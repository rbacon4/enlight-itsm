/**
 * Integrations routes — two-way ticket sync with Jira, Asana, and Linear.
 *
 * CRUD (project-scoped):
 *   GET    /projects/:id/integrations
 *   POST   /projects/:id/integrations
 *   PUT    /projects/:id/integrations/:integrationId
 *   DELETE /projects/:id/integrations/:integrationId
 *   POST   /projects/:id/integrations/:integrationId/test
 *   POST   /projects/:id/integrations/:integrationId/sync  (manual trigger)
 *   GET    /projects/:id/integrations/:integrationId/refs  (external refs for a project)
 *
 * Inbound webhooks (unauthenticated, signature-verified):
 *   POST   /webhooks/jira/:integrationId
 *   POST   /webhooks/asana/:integrationId
 *   POST   /webhooks/linear/:integrationId
 *   GET    /webhooks/asana/:integrationId   (Asana handshake)
 */

import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/client.js';
import { integrations, requestExternalRefs, requests } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { Errors } from '../lib/errors.js';
import { encryptSecret, decryptSecret } from '../lib/secretCrypto.js';
import { logger } from '../lib/logger.js';
import {
  syncRequestCreated,
  syncRequestUpdated,
  applyInboundUpdate,
  testIntegrationConnection,
} from '../lib/integrations/sync.js';
import { z } from 'zod';
import type { IntegrationProvider } from '../lib/integrations/types.js';

// ── Project-scoped router ─────────────────────────────────────────────────────

export const integrationsRouter = Router({ mergeParams: true });
integrationsRouter.use(requireAuth);

const SECRET_FIELDS: Record<string, string[]> = {
  jira: ['apiToken'],
  asana: ['accessToken'],
  linear: ['apiKey'],
};

function encryptConfigSecrets(provider: string, config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  for (const field of (SECRET_FIELDS[provider] ?? [])) {
    if (typeof out[field] === 'string' && !(out[field] as string).startsWith('enc:')) {
      out[field] = encryptSecret(out[field] as string);
    }
  }
  return out;
}

function redactConfigSecrets(provider: string, config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  for (const field of (SECRET_FIELDS[provider] ?? [])) {
    if (out[field]) out[field] = '••••••••';
  }
  return out;
}

// GET /projects/:projectId/integrations
integrationsRouter.get(
  '/',
  requireProjectPermission('project.manage'),
  async (req, res, next) => {
    try {
      const { projectId } = req.params as { projectId: string };
      const rows = await db
        .select()
        .from(integrations)
        .where(eq(integrations.projectId, projectId));

      res.json(
        rows.map((r) => ({
          ...r,
          config: redactConfigSecrets(r.provider, r.config as Record<string, unknown>),
        })),
      );
    } catch (err) { next(err); }
  },
);

const integrationBodySchema = z.object({
  provider: z.enum(['jira', 'asana', 'linear']),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()),
});

// POST /projects/:projectId/integrations
integrationsRouter.post(
  '/',
  requireProjectPermission('project.manage'),
  async (req, res, next) => {
    try {
      const { projectId } = req.params as { projectId: string };
      const user = req.user!;
      const body = integrationBodySchema.parse(req.body);

      const encConfig = encryptConfigSecrets(body.provider, body.config);
      const webhookSecret = crypto.randomBytes(32).toString('hex');

      const [row] = await db
        .insert(integrations)
        .values({
          orgId: user.orgId,
          projectId,
          provider: body.provider,
          enabled: body.enabled,
          config: encConfig,
          webhookSecret,
        })
        .returning();

      res.status(201).json({
        ...row,
        config: redactConfigSecrets(row!.provider, row!.config as Record<string, unknown>),
        webhookSecret, // returned once at creation for webhook registration
      });
    } catch (err) { next(err); }
  },
);

// PUT /projects/:projectId/integrations/:integrationId
integrationsRouter.put(
  '/:integrationId',
  requireProjectPermission('project.manage'),
  async (req, res, next) => {
    try {
      const { projectId, integrationId } = req.params as { projectId: string; integrationId: string };
      const body = integrationBodySchema.partial().parse(req.body);

      const [existing] = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.id, integrationId), eq(integrations.projectId, projectId)))
        .limit(1);
      if (!existing) { next(Errors.notFound('Integration')); return; }

      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (body.enabled !== undefined) update['enabled'] = body.enabled;
      if (body.config) {
        const provider = body.provider ?? existing.provider;
        // Merge: keep existing encrypted secrets when blank fields are sent
        const existingCfg = existing.config as Record<string, unknown>;
        const merged: Record<string, unknown> = { ...existingCfg };
        for (const [k, v] of Object.entries(body.config)) {
          if (v === '' || v === '••••••••') continue; // blank/redacted — keep existing
          merged[k] = v;
        }
        update['config'] = encryptConfigSecrets(provider, merged);
      }

      const [updated] = await db
        .update(integrations)
        .set(update)
        .where(eq(integrations.id, integrationId))
        .returning();

      res.json({
        ...updated,
        config: redactConfigSecrets(updated!.provider, updated!.config as Record<string, unknown>),
      });
    } catch (err) { next(err); }
  },
);

// DELETE /projects/:projectId/integrations/:integrationId
integrationsRouter.delete(
  '/:integrationId',
  requireProjectPermission('project.manage'),
  async (req, res, next) => {
    try {
      const { projectId, integrationId } = req.params as { projectId: string; integrationId: string };

      const [existing] = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.id, integrationId), eq(integrations.projectId, projectId)))
        .limit(1);
      if (!existing) { next(Errors.notFound('Integration')); return; }

      await db.delete(integrations).where(eq(integrations.id, integrationId));
      res.status(204).send();
    } catch (err) { next(err); }
  },
);

// POST /projects/:projectId/integrations/:integrationId/test
integrationsRouter.post(
  '/:integrationId/test',
  requireProjectPermission('project.manage'),
  async (req, res, next) => {
    try {
      const { projectId, integrationId } = req.params as { projectId: string; integrationId: string };

      const [integration] = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.id, integrationId), eq(integrations.projectId, projectId)))
        .limit(1);
      if (!integration) { next(Errors.notFound('Integration')); return; }

      // Decrypt secrets for test
      const cfg = { ...(integration.config as Record<string, unknown>) };
      for (const field of (SECRET_FIELDS[integration.provider] ?? [])) {
        if (typeof cfg[field] === 'string' && (cfg[field] as string).startsWith('enc:')) {
          cfg[field] = decryptSecret(cfg[field] as string);
        }
      }

      const error = await testIntegrationConnection(
        integration.provider as IntegrationProvider,
        cfg,
      );

      res.json({ success: !error, error: error ?? undefined });
    } catch (err) { next(err); }
  },
);

// POST /projects/:projectId/integrations/:integrationId/sync — manual full sync
integrationsRouter.post(
  '/:integrationId/sync',
  requireProjectPermission('project.manage'),
  async (req, res, next) => {
    try {
      const { projectId, integrationId } = req.params as { projectId: string; integrationId: string };

      const [integration] = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.id, integrationId), eq(integrations.projectId, projectId)))
        .limit(1);
      if (!integration) { next(Errors.notFound('Integration')); return; }

      // Get all open requests in the project that don't have a ref yet
      const allRefs = await db
        .select({ requestId: requestExternalRefs.requestId })
        .from(requestExternalRefs)
        .where(eq(requestExternalRefs.integrationId, integrationId));

      const syncedIds = new Set(allRefs.map((r) => r.requestId));

      const openRequests = await db
        .select()
        .from(requests)
        .where(eq(requests.projectId, projectId));

      let created = 0;
      let errors = 0;
      for (const req of openRequests) {
        if (syncedIds.has(req.id)) {
          // Already synced — push a status update
          void syncRequestUpdated(req.id, {
            title: req.title,
            description: req.description,
            priority: req.priority,
            status: req.status,
          });
        } else {
          try {
            await syncRequestCreated(req.id);
            created++;
          } catch {
            errors++;
          }
        }
      }

      res.json({ synced: openRequests.length, created, errors });
    } catch (err) { next(err); }
  },
);

// GET /projects/:projectId/integrations/:integrationId/refs
integrationsRouter.get(
  '/:integrationId/refs',
  requireProjectPermission('project.manage'),
  async (req, res, next) => {
    try {
      const { integrationId } = req.params as { integrationId: string };
      const refs = await db
        .select({
          ref: requestExternalRefs,
          title: requests.title,
          status: requests.status,
          ticketNumber: requests.ticketNumber,
        })
        .from(requestExternalRefs)
        .innerJoin(requests, eq(requestExternalRefs.requestId, requests.id))
        .where(eq(requestExternalRefs.integrationId, integrationId));

      res.json(refs);
    } catch (err) { next(err); }
  },
);

// ── Inbound webhook router (unauthenticated, mounted at /webhooks) ─────────────

export const webhookReceiverRouter = Router();

// Helper: look up integration + verify webhook signature
async function resolveIntegration(integrationId: string) {
  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, integrationId), eq(integrations.enabled, true)))
    .limit(1);
  return integration ?? null;
}

// ── Jira inbound ──────────────────────────────────────────────────────────────

webhookReceiverRouter.post('/jira/:integrationId', async (req, res) => {
  try {
    const integration = await resolveIntegration(req.params['integrationId']!);
    if (!integration) { res.status(404).end(); return; }

    // Jira doesn't sign webhooks with a secret by default — we check the secret
    // in the URL query param that Jira sends (registered as ?secret=xxx)
    const urlSecret = req.query['secret'] as string | undefined;
    if (integration.webhookSecret && urlSecret !== integration.webhookSecret) {
      res.status(401).end();
      return;
    }

    const body = req.body as {
      webhookEvent?: string;
      issue?: {
        key: string;
        fields?: { summary?: string; description?: string; status?: { name?: string } };
      };
    };

    if (!body.issue?.key) { res.status(200).end(); return; }

    const event = body.webhookEvent ?? '';
    const issueKey = body.issue.key;

    if (event === 'jira:issue_deleted') {
      // Don't auto-close Enlight tickets on Jira delete — just log
      logger.info('Jira issue deleted', { issueKey });
    } else {
      // issue_created or issue_updated — only pass fields that are defined
      const changes: { title?: string; status?: string } = {};
      const summary = body.issue.fields?.summary;
      const statusName = body.issue.fields?.status?.name;
      if (summary) changes.title = summary;
      if (statusName) changes.status = statusName;
      if (Object.keys(changes).length > 0) await applyInboundUpdate(integration.id, issueKey, changes);
    }

    res.status(200).end();
  } catch (err) {
    logger.error('Jira webhook error', { err });
    res.status(500).end();
  }
});

// ── Asana inbound ─────────────────────────────────────────────────────────────

// Asana sends a GET handshake with X-Hook-Secret to verify the endpoint
webhookReceiverRouter.get('/asana/:integrationId', async (req, res) => {
  const secret = req.headers['x-hook-secret'] as string | undefined;
  if (secret) {
    // Store the secret for future signature verification
    const { integrationId } = req.params as { integrationId: string };
    await db
      .update(integrations)
      .set({ webhookSecret: secret })
      .where(eq(integrations.id, integrationId));
    res.setHeader('X-Hook-Secret', secret);
  }
  res.status(200).end();
});

webhookReceiverRouter.post('/asana/:integrationId', async (req, res) => {
  try {
    const integration = await resolveIntegration(req.params['integrationId']!);
    if (!integration) { res.status(404).end(); return; }

    // Verify Asana HMAC-SHA256 signature
    if (integration.webhookSecret) {
      const sig = req.headers['x-hook-signature'] as string | undefined;
      const expectedSig = crypto
        .createHmac('sha256', integration.webhookSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (!sig || sig !== expectedSig) {
        res.status(401).end();
        return;
      }
    }

    // Asana sends an array of events
    const events = (req.body as { events?: { resource?: { gid?: string }; type?: string; action?: string }[] }).events ?? [];

    for (const event of events) {
      const gid = event.resource?.gid;
      if (!gid) continue;
      if (event.type === 'task' && event.action === 'completed') {
        await applyInboundUpdate(integration.id, gid, { status: 'resolved' });
      }
    }

    res.status(200).end();
  } catch (err) {
    logger.error('Asana webhook error', { err });
    res.status(500).end();
  }
});

// ── Linear inbound ────────────────────────────────────────────────────────────

webhookReceiverRouter.post('/linear/:integrationId', async (req, res) => {
  try {
    const integration = await resolveIntegration(req.params['integrationId']!);
    if (!integration) { res.status(404).end(); return; }

    // Verify Linear HMAC-SHA256 signature
    if (integration.webhookSecret) {
      const sig = req.headers['linear-signature'] as string | undefined;
      const expectedSig = crypto
        .createHmac('sha256', integration.webhookSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (!sig || sig !== expectedSig) {
        res.status(401).end();
        return;
      }
    }

    const body = req.body as {
      type?: string;
      action?: string;
      data?: { id?: string; title?: string; description?: string; state?: { name?: string } };
    };

    if (body.type === 'Issue' && body.data?.id) {
      const changes: { title?: string; description?: string; status?: string } = {};
      if (body.data.title) changes.title = body.data.title;
      if (body.data.description) changes.description = body.data.description;
      if (body.data.state?.name) changes.status = body.data.state.name;
      if (Object.keys(changes).length > 0) await applyInboundUpdate(integration.id, body.data.id, changes);
    }

    res.status(200).end();
  } catch (err) {
    logger.error('Linear webhook error', { err });
    res.status(500).end();
  }
});
