import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { db } from '../db/client.js';
import { offboardingEvents, organizations, offboardingChecklists, offboardingChecklistSteps } from '../db/schema.js';
import { eq, and, asc, desc } from 'drizzle-orm';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { Errors } from '../lib/errors.js';
import type { OrganizationSettings, ChecklistStep, AiBuiltRequest } from '@enlight/shared';
import { decryptOrgSettings, encryptSecret, decryptSecret } from '../lib/secretCrypto.js';
import {
  createOffboardingEvent,
  validateOffboardingInput,
} from '../lib/offboarding.js';
import { makeGoogleWorkspaceService, resolveOffboardingConfig } from '../lib/googleWorkspace.js';
import { makeMicrosoft365Service, resolveMicrosoft365Config } from '../lib/microsoft365.js';
import { runAutomatedStep, buildVars } from '../lib/checklistRunner.js';
import { offboardingQueue } from '../queues/index.js';

const router = Router();
router.use(requireAuth);

/** Load + decrypt the calling org's settings. */
async function orgSettingsFor(orgId: string): Promise<OrganizationSettings> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return decryptOrgSettings((org?.settings ?? {}) as OrganizationSettings);
}

// GET /offboarding — history (admin only)
router.get('/', requirePermission('offboarding.run'), async (req, res, next) => {
  try {
    const events = await db
      .select()
      .from(offboardingEvents)
      .where(eq(offboardingEvents.orgId, req.user!.orgId))
      .orderBy(desc(offboardingEvents.createdAt))
      .limit(100);
    res.json(events);
  } catch (err) {
    next(err);
  }
});

// GET /offboarding/lookup?email=  — live Google Workspace profile card
router.get('/lookup', requirePermission('offboarding.run'), async (req, res, next) => {
  try {
    const email = z.string().email().parse(req.query['email']);
    const settings = await orgSettingsFor(req.user!.orgId);
    if (!settings.offboarding?.enabled) {
      res.json({ found: false, email, error: 'Offboarding is not enabled.' });
      return;
    }
    const gws = makeGoogleWorkspaceService(settings);
    res.json(await gws.lookupProfile(email));
  } catch (err) {
    next(err);
  }
});

// POST /offboarding/test-config — verify OU paths against Google Workspace
router.post('/test-config', requirePermission('offboarding.run'), async (req, res, next) => {
  try {
    const settings = await orgSettingsFor(req.user!.orgId);
    const cfg = resolveOffboardingConfig(settings);
    const gws = makeGoogleWorkspaceService(settings);
    const checks: Record<string, boolean> = {};
    checks[cfg.departedOuPath] = await gws.checkOuExists(cfg.departedOuPath);
    if (cfg.archiveOuPath) checks[cfg.archiveOuPath] = await gws.checkOuExists(cfg.archiveOuPath);
    res.json({ mock: cfg.mock, ouChecks: checks });
  } catch (err) {
    next(err);
  }
});

// POST /offboarding — trigger an offboarding
router.post('/', requirePermission('offboarding.run'), async (req, res, next) => {
  try {
    // Use loose strings here and defer format validation to validateOffboardingInput
    // so malformed emails return a clean 400 with a helpful message (not a 500).
    const body = z
      .object({
        targetEmail: z.string().max(320),
        delegateEmail: z.string().max(320).optional().nullable(),
        archive: z.boolean().optional(),
        checklistId: z.string().uuid().optional().nullable(),
      })
      .parse(req.body);

    const settings = await orgSettingsFor(req.user!.orgId);
    if (!settings.offboarding?.enabled) {
      next(Errors.badRequest('Offboarding is not enabled. Configure it in Settings → Offboarding.'));
      return;
    }

    const validationError = validateOffboardingInput(body.targetEmail, body.delegateEmail);
    if (validationError) {
      next(Errors.badRequest(validationError));
      return;
    }

    const event = await createOffboardingEvent({
      orgId: req.user!.orgId,
      targetEmail: body.targetEmail,
      delegateEmail: body.delegateEmail ?? null,
      archive: body.archive ?? false,
      checklistId: body.checklistId ?? null,
      triggeredById: req.user!.id,
      triggeredVia: 'web',
    });

    await offboardingQueue.add(
      'run',
      { eventId: event.id },
      { attempts: 2, backoff: { type: 'exponential', delay: 3000 } },
    );

    res.status(202).json(event);
  } catch (err) {
    next(err);
  }
});

// ── Microsoft 365 ───────────────────────────────────────────────────────────

// POST /offboarding/m365/test-config — token + getUser smoke test
router.post('/m365/test-config', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const settings = await orgSettingsFor(req.user!.orgId);
    const cfg = resolveMicrosoft365Config(settings);
    const svc = makeMicrosoft365Service(settings);
    const sample = z.object({ email: z.string().email().optional() }).parse(req.body ?? {});
    const probe = sample.email ?? `test.user@${settings.offboarding?.googleDomain ?? 'example.com'}`;
    try {
      const user = await svc.getUser(probe);
      res.json({ mock: cfg.mock, ok: true, found: Boolean(user), detail: user ? `Resolved ${probe}` : `${probe} not found` });
    } catch (err) {
      res.json({ mock: cfg.mock, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  } catch (err) {
    next(err);
  }
});

// ── Checklists ──────────────────────────────────────────────────────────────

/** Map a step row → API shape (credential redacted to a boolean). */
function toStep(row: typeof offboardingChecklistSteps.$inferSelect): ChecklistStep {
  return {
    id: row.id, checklistId: row.checklistId, orgId: row.orgId, position: row.position,
    type: row.type as ChecklistStep['type'], name: row.name, description: row.description,
    enabled: row.enabled, method: row.method, url: row.url,
    headers: (row.headers ?? {}) as Record<string, string>, bodyTemplate: row.bodyTemplate,
    authType: row.authType as ChecklistStep['authType'], authHeaderName: row.authHeaderName,
    credentialSet: Boolean(row.credentialEnc), expectedStatusMin: row.expectedStatusMin,
    expectedStatusMax: row.expectedStatusMax, schemaText: row.schemaText,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

// GET /offboarding/checklist-options — id/name/default for the trigger picker (run perm)
router.get('/checklist-options', requirePermission('offboarding.run'), async (req, res, next) => {
  try {
    const lists = await db
      .select({ id: offboardingChecklists.id, name: offboardingChecklists.name, isDefault: offboardingChecklists.isDefault })
      .from(offboardingChecklists)
      .where(eq(offboardingChecklists.orgId, req.user!.orgId))
      .orderBy(asc(offboardingChecklists.name));
    res.json(lists);
  } catch (err) {
    next(err);
  }
});

// GET /offboarding/checklists — list checklists with their steps
router.get('/checklists', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const lists = await db.select().from(offboardingChecklists)
      .where(eq(offboardingChecklists.orgId, req.user!.orgId)).orderBy(asc(offboardingChecklists.name));
    const steps = await db.select().from(offboardingChecklistSteps)
      .where(eq(offboardingChecklistSteps.orgId, req.user!.orgId)).orderBy(asc(offboardingChecklistSteps.position));
    res.json(lists.map((l) => ({ ...l, steps: steps.filter((s) => s.checklistId === l.id).map(toStep) })));
  } catch (err) {
    next(err);
  }
});

// POST /offboarding/checklists — create a checklist
router.post('/checklists', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(500).optional(),
      isDefault: z.boolean().optional(),
    }).parse(req.body);
    if (body.isDefault) await clearDefault(req.user!.orgId);
    const [list] = await db.insert(offboardingChecklists).values({
      orgId: req.user!.orgId, name: body.name, description: body.description ?? null, isDefault: body.isDefault ?? false,
    }).returning();
    res.status(201).json({ ...list, steps: [] });
  } catch (err) {
    next(err);
  }
});

// PATCH /offboarding/checklists/:id
router.patch('/checklists/:id', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(500).nullable().optional(),
      isDefault: z.boolean().optional(),
    }).parse(req.body);
    const [list] = await db.select().from(offboardingChecklists)
      .where(and(eq(offboardingChecklists.id, req.params['id'] as string), eq(offboardingChecklists.orgId, req.user!.orgId))).limit(1);
    if (!list) { next(Errors.notFound('Checklist')); return; }
    if (body.isDefault) await clearDefault(req.user!.orgId);
    const [updated] = await db.update(offboardingChecklists).set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      updatedAt: new Date(),
    }).where(eq(offboardingChecklists.id, list.id)).returning();
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /offboarding/checklists/:id
router.delete('/checklists/:id', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const r = await db.delete(offboardingChecklists)
      .where(and(eq(offboardingChecklists.id, req.params['id'] as string), eq(offboardingChecklists.orgId, req.user!.orgId))).returning();
    if (r.length === 0) { next(Errors.notFound('Checklist')); return; }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const stepSchema = z.object({
  type: z.enum(['manual', 'automated']),
  name: z.string().min(1).max(160),
  description: z.string().max(1000).nullable().optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().optional(),
  method: z.string().max(10).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  headers: z.record(z.string()).optional(),
  bodyTemplate: z.string().max(20_000).nullable().optional(),
  authType: z.enum(['none', 'bearer', 'api_key', 'basic']).optional(),
  authHeaderName: z.string().max(120).nullable().optional(),
  credential: z.string().max(4000).nullable().optional(),
  expectedStatusMin: z.number().int().min(100).max(599).optional(),
  expectedStatusMax: z.number().int().min(100).max(599).optional(),
  schemaText: z.string().max(200_000).nullable().optional(),
});

// POST /offboarding/checklists/:id/steps — add a step
router.post('/checklists/:id/steps', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const body = stepSchema.parse(req.body);
    const [list] = await db.select().from(offboardingChecklists)
      .where(and(eq(offboardingChecklists.id, req.params['id'] as string), eq(offboardingChecklists.orgId, req.user!.orgId))).limit(1);
    if (!list) { next(Errors.notFound('Checklist')); return; }
    const existing = await db.select({ position: offboardingChecklistSteps.position }).from(offboardingChecklistSteps)
      .where(eq(offboardingChecklistSteps.checklistId, list.id));
    const nextPos = existing.length ? Math.max(...existing.map((e) => e.position)) + 1 : 0;
    const [step] = await db.insert(offboardingChecklistSteps).values({
      checklistId: list.id, orgId: req.user!.orgId, position: body.position ?? nextPos,
      type: body.type, name: body.name, description: body.description ?? null, enabled: body.enabled ?? true,
      method: body.method ?? null, url: body.url ?? null, headers: body.headers ?? {},
      bodyTemplate: body.bodyTemplate ?? null, authType: body.authType ?? 'none', authHeaderName: body.authHeaderName ?? null,
      credentialEnc: body.credential ? encryptSecret(body.credential) : null,
      expectedStatusMin: body.expectedStatusMin ?? 200, expectedStatusMax: body.expectedStatusMax ?? 299,
      schemaText: body.schemaText ?? null,
    }).returning();
    res.status(201).json(toStep(step!));
  } catch (err) {
    next(err);
  }
});

// PATCH /offboarding/checklists/:id/steps/:stepId — update a step
router.patch('/checklists/:id/steps/:stepId', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const body = stepSchema.partial().parse(req.body);
    const [step] = await db.select().from(offboardingChecklistSteps)
      .where(and(eq(offboardingChecklistSteps.id, req.params['stepId'] as string), eq(offboardingChecklistSteps.orgId, req.user!.orgId))).limit(1);
    if (!step) { next(Errors.notFound('Step')); return; }
    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ['type', 'name', 'description', 'enabled', 'position', 'method', 'url', 'headers', 'bodyTemplate', 'authType', 'authHeaderName', 'expectedStatusMin', 'expectedStatusMax', 'schemaText'] as const) {
      if (body[k] !== undefined) set[k] = body[k];
    }
    // Credential: only update when a non-empty value is sent (blank keeps existing).
    if (body.credential !== undefined && body.credential !== null && body.credential !== '') set['credentialEnc'] = encryptSecret(body.credential);
    const [updated] = await db.update(offboardingChecklistSteps).set(set).where(eq(offboardingChecklistSteps.id, step.id)).returning();
    res.json(toStep(updated!));
  } catch (err) {
    next(err);
  }
});

// DELETE /offboarding/checklists/:id/steps/:stepId
router.delete('/checklists/:id/steps/:stepId', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const r = await db.delete(offboardingChecklistSteps)
      .where(and(eq(offboardingChecklistSteps.id, req.params['stepId'] as string), eq(offboardingChecklistSteps.orgId, req.user!.orgId))).returning();
    if (r.length === 0) { next(Errors.notFound('Step')); return; }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /offboarding/checklist/ai-build — AI proposes a request template from a schema (review only)
router.post('/checklist/ai-build', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const body = z.object({
      schema: z.string().min(1).max(200_000),
      instruction: z.string().min(1).max(2000),
    }).parse(req.body);
    const settings = await orgSettingsFor(req.user!.orgId);
    const apiKey = settings.anthropicApiKey || process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) { next(Errors.badRequest('No Anthropic API key configured (Settings → AI Keys).')); return; }

    const client = new Anthropic({ apiKey });
    const prompt = `You configure outbound REST API calls for an IT offboarding tool. Given an API schema and an instruction, output ONLY a JSON object describing the HTTP request to perform the instruction. Use these template variables where a value depends on the departing user: {{targetEmail}}, {{targetUserName}}, {{targetFirstName}}, {{targetLastName}}, {{delegateEmail}}, {{date}}.

JSON shape (no markdown, no prose):
{"method":"POST","url":"https://...","headers":{"Header":"value"},"bodyTemplate":"{...}","authType":"none|bearer|api_key|basic","authHeaderName":"X-API-Key (only for api_key)","notes":"short note"}

Do NOT include secret values; auth is attached separately by authType. Leave the URL host exactly as the schema's server.

INSTRUCTION:
${body.instruction}

API SCHEMA (may be truncated):
${body.schema.slice(0, 60_000)}`;

    const model = ((m?: string) => (m === 'claude-opus-4-5' || m === 'claude-haiku-4-5' ? m : 'claude-sonnet-4-5'))(settings.defaultModel);
    const message = await client.messages.create({ model, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] });
    const blk = message.content[0];
    const text = blk && blk.type === 'text' ? blk.text : '';
    const parsed = extractJson(text);
    if (!parsed) { next(Errors.badRequest('The AI did not return a usable request. Try a more specific instruction.')); return; }
    res.json(parsed as AiBuiltRequest);
  } catch (err) {
    next(err);
  }
});

// GET /offboarding/:id — single event (registered last so it doesn't shadow named routes)
router.get('/:id', requirePermission('offboarding.run'), async (req, res, next) => {
  try {
    const [event] = await db
      .select()
      .from(offboardingEvents)
      .where(eq(offboardingEvents.id, req.params['id'] as string))
      .limit(1);
    if (!event || event.orgId !== req.user!.orgId) {
      next(Errors.notFound('Offboarding event'));
      return;
    }
    res.json(event);
  } catch (err) {
    next(err);
  }
});

// POST /offboarding/checklist/test-call — run a single automated step once
router.post('/checklist/test-call', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().default('Test call'),
      method: z.string().default('POST'),
      url: z.string().min(1),
      headers: z.record(z.string()).optional(),
      bodyTemplate: z.string().optional().nullable(),
      authType: z.enum(['none', 'bearer', 'api_key', 'basic']).default('none'),
      authHeaderName: z.string().optional().nullable(),
      credential: z.string().optional().nullable(),
      stepId: z.string().uuid().optional(),         // reuse stored credential if not provided
      expectedStatusMin: z.number().int().optional(),
      expectedStatusMax: z.number().int().optional(),
      sampleEmail: z.string().email(),
      delegateEmail: z.string().email().optional(),
    }).parse(req.body);

    // Resolve credential: explicit value > stored step credential.
    let credential = body.credential ?? null;
    if (!credential && body.stepId) {
      const [step] = await db.select({ credentialEnc: offboardingChecklistSteps.credentialEnc }).from(offboardingChecklistSteps)
        .where(and(eq(offboardingChecklistSteps.id, body.stepId), eq(offboardingChecklistSteps.orgId, req.user!.orgId))).limit(1);
      if (step?.credentialEnc) credential = decryptSecret(step.credentialEnc);
    }

    const vars = buildVars({ targetEmail: body.sampleEmail, delegateEmail: body.delegateEmail ?? null });
    const result = await runAutomatedStep({
      name: body.name, method: body.method, url: body.url, headers: body.headers ?? {},
      bodyTemplate: body.bodyTemplate ?? null, authType: body.authType, authHeaderName: body.authHeaderName ?? null,
      credential, expectedStatusMin: body.expectedStatusMin ?? 200, expectedStatusMax: body.expectedStatusMax ?? 299,
    }, vars);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

async function clearDefault(orgId: string): Promise<void> {
  await db.update(offboardingChecklists).set({ isDefault: false })
    .where(and(eq(offboardingChecklists.orgId, orgId), eq(offboardingChecklists.isDefault, true)));
}

/** Best-effort extraction of a JSON object from an AI response. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export { router as offboardingRouter };
