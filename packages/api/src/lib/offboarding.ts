/**
 * Offboarding workflow orchestrator.
 *
 * Ported from the standalone Python app (handlers/offboard.py +
 * services/claude_service.py). Runs the Google Workspace steps, generates an
 * AI audit summary, persists the event, writes an audit-log row, opens a
 * tracking ticket, and posts a summary to the Slack audit channel.
 *
 * Designed to run inside a BullMQ worker job (handleOffboardingJob). The
 * GWS operations (suspend / move OU / Drive transfer) are idempotent, so a
 * retried job is safe.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/client.js';
import { offboardingEvents, organizations, users, comments, offboardingChecklists, offboardingChecklistSteps } from '../db/schema.js';
import { auditLogs } from '../db/schema.js';
import { eq, and, inArray, asc } from 'drizzle-orm';
import type {
  OrganizationSettings,
  OffboardingActionResult,
  OffboardingStatus,
  ClaudeModel,
} from '@enlight/shared';
import { decryptOrgSettings, decryptSecret } from './secretCrypto.js';
import { makeGoogleWorkspaceService, resolveOffboardingConfig } from './googleWorkspace.js';
import { makeMicrosoft365Service, resolveMicrosoft365Config } from './microsoft365.js';
import { runAutomatedStep, buildVars } from './checklistRunner.js';
import { createRequest } from './createRequest.js';
import { makeSlackClient } from '../slack/client.js';
import { logger } from './logger.js';

interface ManualStep { name: string; description: string | null }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface CreateOffboardingEventInput {
  orgId: string;
  targetEmail: string;
  delegateEmail?: string | null;
  archive?: boolean;
  checklistId?: string | null;
  triggeredById?: string | null;
  triggeredVia: 'slack' | 'web' | 'agent';
}

/** Validate an offboarding request. Returns an error string, or null if valid. */
export function validateOffboardingInput(
  targetEmail: string,
  delegateEmail?: string | null,
): string | null {
  if (!targetEmail) return 'Target email is required.';
  if (!EMAIL_RE.test(targetEmail)) return `"${targetEmail}" is not a valid email address.`;
  if (delegateEmail && !EMAIL_RE.test(delegateEmail)) return `Delegate email "${delegateEmail}" is not valid.`;
  if (delegateEmail && targetEmail.toLowerCase() === delegateEmail.toLowerCase())
    return 'Target and delegate cannot be the same user.';
  return null;
}

/** Insert a pending offboarding event row (the workflow runs later in the worker). */
export async function createOffboardingEvent(input: CreateOffboardingEventInput) {
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, input.orgId), eq(users.email, input.targetEmail.toLowerCase())))
    .limit(1);

  const [event] = await db
    .insert(offboardingEvents)
    .values({
      orgId: input.orgId,
      targetEmail: input.targetEmail,
      targetUserId: target?.id ?? null,
      delegateEmail: input.delegateEmail ?? null,
      archive: input.archive ?? false,
      checklistId: input.checklistId ?? null,
      status: 'pending',
      triggeredById: input.triggeredById ?? null,
      triggeredVia: input.triggeredVia,
    })
    .returning();
  if (!event) throw new Error('Failed to create offboarding event');
  return event;
}

/** Execute the full offboarding workflow for a previously-created event. */
export async function runOffboarding(eventId: string): Promise<void> {
  const [event] = await db.select().from(offboardingEvents).where(eq(offboardingEvents.id, eventId)).limit(1);
  if (!event) {
    logger.error('runOffboarding: event not found', { eventId });
    return;
  }

  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, event.orgId))
    .limit(1);
  const orgSettings = decryptOrgSettings((org?.settings ?? {}) as OrganizationSettings);
  const cfg = resolveOffboardingConfig(orgSettings);

  await db
    .update(offboardingEvents)
    .set({ status: 'running', updatedAt: new Date() })
    .where(eq(offboardingEvents.id, eventId));

  // 1. Validate
  const validationError = validateOffboardingInput(event.targetEmail, event.delegateEmail);
  if (validationError) {
    await finalize(eventId, 'failed', [], null, validationError, orgSettings, event.orgId, event.triggeredById);
    return;
  }

  const actions: OffboardingActionResult[] = [];
  let alreadySuspended = false;
  const target = event.targetEmail;
  const delegate = event.delegateEmail;

  // ── Provider: Google Workspace (runs when a Google domain is configured) ──
  if (cfg.googleDomain) {
    const gws = makeGoogleWorkspaceService(orgSettings);
    try {
      const user = await gws.getUser(target);
      if (!user) {
        actions.push({ action: 'Look up Google Workspace user', success: false, details: '', error: `${target} was not found in Google Workspace.` });
      } else {
        alreadySuspended = Boolean(user.suspended);
        actions.push(await gws.suspendUser(target));
        const ouPath = event.archive ? cfg.archiveOuPath || cfg.departedOuPath : cfg.departedOuPath;
        actions.push(await gws.moveToOu(target, ouPath));
        if (delegate) actions.push(await gws.transferDriveData(target, delegate));
      }
    } catch (err) {
      actions.push({ action: 'Google Workspace offboarding', success: false, details: '', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Provider: Microsoft 365 (runs when enabled) ──
  const m365cfg = resolveMicrosoft365Config(orgSettings);
  if (m365cfg.enabled) {
    const svc = makeMicrosoft365Service(orgSettings);
    try {
      const mu = await svc.getUser(target);
      if (!mu) {
        actions.push({ action: 'Look up Microsoft 365 user', success: false, details: '', error: `${target} was not found in Microsoft 365.` });
      } else {
        actions.push(await svc.disableUser(target));
        actions.push(await svc.revokeSessions(target));
        actions.push(await svc.removeLicenses(target));
        if (m365cfg.transferToManager && delegate) actions.push(await svc.transferOneDrive(target, delegate));
      }
    } catch (err) {
      actions.push({ action: 'Microsoft 365 offboarding', success: false, details: '', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Checklist: automated steps execute; manual steps go on the ticket ──
  const { automated, manual } = await runChecklist(event.orgId, event.checklistId, target, delegate);
  actions.push(...automated);

  // AI summary (with plain-text fallback)
  const aiSummary = await generateOffboardingSummary(target, actions, orgSettings, alreadySuspended);

  const allSucceeded = actions.every((a) => a.success);
  const status: OffboardingStatus = allSucceeded ? 'completed' : 'completed_with_errors';

  await finalize(eventId, status, actions, aiSummary, null, orgSettings, event.orgId, event.triggeredById, manual);
}

/** Resolve the chosen (or default) checklist and run its steps. */
async function runChecklist(
  orgId: string,
  checklistId: string | null,
  targetEmail: string,
  delegateEmail: string | null,
): Promise<{ automated: OffboardingActionResult[]; manual: ManualStep[] }> {
  let listId = checklistId;
  if (!listId) {
    const [def] = await db.select({ id: offboardingChecklists.id }).from(offboardingChecklists)
      .where(and(eq(offboardingChecklists.orgId, orgId), eq(offboardingChecklists.isDefault, true))).limit(1);
    listId = def?.id ?? null;
  }
  if (!listId) return { automated: [], manual: [] };

  const steps = await db.select().from(offboardingChecklistSteps)
    .where(and(eq(offboardingChecklistSteps.checklistId, listId), eq(offboardingChecklistSteps.enabled, true)))
    .orderBy(asc(offboardingChecklistSteps.position));

  const vars = buildVars({ targetEmail, delegateEmail });
  const automated: OffboardingActionResult[] = [];
  const manual: ManualStep[] = [];
  for (const s of steps) {
    if (s.type === 'manual') {
      manual.push({ name: s.name, description: s.description });
      continue;
    }
    if (!s.url) {
      automated.push({ action: s.name, success: false, details: '', error: 'No URL configured for this automated step.' });
      continue;
    }
    const result = await runAutomatedStep({
      name: s.name, method: s.method || 'POST', url: s.url,
      headers: (s.headers ?? {}) as Record<string, string>, bodyTemplate: s.bodyTemplate,
      authType: s.authType as 'none' | 'bearer' | 'api_key' | 'basic', authHeaderName: s.authHeaderName,
      credential: s.credentialEnc ? decryptSecret(s.credentialEnc) : null,
      expectedStatusMin: s.expectedStatusMin, expectedStatusMax: s.expectedStatusMax,
    }, vars);
    automated.push({ action: result.action, success: result.success, details: result.details, ...(result.error ? { error: result.error } : {}) });
  }
  return { automated, manual };
}

/** Persist results, write audit log, open the tracking ticket, post to Slack. */
async function finalize(
  eventId: string,
  status: OffboardingStatus,
  actions: OffboardingActionResult[],
  aiSummary: string | null,
  error: string | null,
  orgSettings: OrganizationSettings,
  orgId: string,
  triggeredById: string | null,
  manual: ManualStep[] = [],
): Promise<void> {
  // Re-read current event for target/delegate/archive details.
  const [event] = await db.select().from(offboardingEvents).where(eq(offboardingEvents.id, eventId)).limit(1);
  if (!event) return;

  // Tracking ticket
  let requestId: string | null = event.requestId;
  const trackingProjectId = orgSettings.offboarding?.trackingProjectId;
  if (trackingProjectId && !requestId) {
    try {
      const requesterId = triggeredById ?? (await firstAdminId(orgId));
      if (requesterId) {
        const summaryLine = aiSummary ?? error ?? 'Offboarding processed.';
        const descLines = [
          `**Departing user:** ${event.targetEmail}`,
          event.delegateEmail ? `**Delegate:** ${event.delegateEmail}` : null,
          `**Destination:** ${event.archive ? 'Archive OU' : 'Departed OU'}`,
          '',
          '**Automated actions:**',
          ...actions.map((a) => `${a.success ? '✅' : '❌'} ${a.action}${a.success ? '' : ` — ${a.error}`}`),
          ...(manual.length
            ? ['', '**Manual steps (to complete):**', ...manual.map((m) => `- [ ] ${m.name}${m.description ? ` — ${m.description}` : ''}`)]
            : []),
        ].filter(Boolean) as string[];

        const { request } = await createRequest({
          projectId: trackingProjectId,
          requesterId,
          title: `Offboarding: ${event.targetEmail}`,
          description: descLines.join('\n'),
          priority: 'high',
          category: 'Offboarding',
          status: status === 'completed' ? 'resolved' : 'open',
        });
        requestId = request.id;

        // AI summary as the first comment
        await db.insert(comments).values({
          requestId: request.id,
          authorId: requesterId,
          body: summaryLine,
          isInternal: true,
          aiGenerated: true,
        });
      }
    } catch (err) {
      logger.error('Offboarding: failed to create tracking ticket', { err });
    }
  }

  await db
    .update(offboardingEvents)
    .set({
      status,
      actions,
      aiSummary,
      error,
      requestId,
      manualSteps: manual,
      updatedAt: new Date(),
      completedAt: new Date(),
    })
    .where(eq(offboardingEvents.id, eventId));

  // Audit log
  try {
    await db.insert(auditLogs).values({
      orgId,
      actorId: triggeredById ?? null,
      action: 'offboard',
      entityType: 'offboarding',
      entityId: eventId,
      diff: { targetEmail: event.targetEmail, status, actions } as Record<string, unknown>,
    });
  } catch (err) {
    logger.error('Offboarding: failed to write audit log', { err });
  }

  // Slack audit post
  const channel = orgSettings.offboarding?.auditChannel;
  if (channel) {
    try {
      const slack = makeSlackClient(orgSettings);
      if (slack) {
        const text = formatSlackMessage(event.targetEmail, status, actions, aiSummary, error);
        const res = await slack.chat.postMessage({ channel, text });
        if (res.ts) {
          await db
            .update(offboardingEvents)
            .set({ slackMessageTs: res.ts as string })
            .where(eq(offboardingEvents.id, eventId));
        }
      }
    } catch (err) {
      logger.warn('Offboarding: failed to post Slack summary', { err });
    }
  }
}

async function firstAdminId(orgId: string): Promise<string | null> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), inArray(users.globalRole, ['super_admin', 'admin'])))
    .limit(1);
  return admin?.id ?? null;
}

// ── AI summary ────────────────────────────────────────────────────────────────

const MODEL_MAP: Record<ClaudeModel, string> = {
  'claude-opus-4-5': 'claude-opus-4-5',
  'claude-sonnet-4-5': 'claude-sonnet-4-5',
  'claude-haiku-4-5': 'claude-haiku-4-5',
};

export async function generateOffboardingSummary(
  targetEmail: string,
  actions: OffboardingActionResult[],
  orgSettings: OrganizationSettings,
  alreadySuspended: boolean,
): Promise<string> {
  const apiKey = orgSettings.anthropicApiKey || process.env['ANTHROPIC_API_KEY'];
  const successCount = actions.filter((a) => a.success).length;
  const errorCount = actions.length - successCount;

  if (!apiKey) return fallbackSummary(targetEmail, actions);

  const actionsText = actions
    .map((a) => `- ${a.success ? '✅' : '❌'} ${a.action}: ${a.success ? a.details : `ERROR — ${a.error}`}`)
    .join('\n');

  const prompt = `You are an IT operations assistant. An automated offboarding workflow just ran for a departing employee. Generate a concise Slack-formatted audit summary.

OFFBOARDING DETAILS:
- Departing employee: ${targetEmail}
- Actions attempted: ${actions.length}
- Successful: ${successCount}
- Failed: ${errorCount}
${alreadySuspended ? '- Note: the account was already suspended before this run.' : ''}

ACTION LOG:
${actionsText}

Write a 3-section response in this exact format (use Slack mrkdwn):

*Summary*
One or two sentences describing what happened, the overall status (success/partial/failed), and what was done to the account.

*Errors & Issues*
If there were no errors, write "None — all actions completed successfully." Otherwise, explain each error in plain language and what it means operationally.

*Recommended Follow-Up Actions*
List 3–5 concrete next steps the IT or People Ops team should take. Always include things like: reviewing active SaaS app access, revoking API keys or tokens, checking shared drives, reviewing calendar invites, and notifying relevant teams.

Keep the tone professional but concise. Use bullet points for the follow-up list. Do not use headers with # characters — use bold (*text*) instead.`;

  try {
    const client = new Anthropic({ apiKey });
    const model = MODEL_MAP[orgSettings.defaultModel ?? 'claude-haiku-4-5'] ?? 'claude-haiku-4-5';
    const message = await client.messages.create({
      model,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = message.content[0];
    if (block && block.type === 'text') return block.text.trim();
    return fallbackSummary(targetEmail, actions);
  } catch (err) {
    logger.error('Offboarding: Claude summary failed, using fallback', { err });
    return fallbackSummary(targetEmail, actions);
  }
}

function fallbackSummary(targetEmail: string, actions: OffboardingActionResult[]): string {
  const allSucceeded = actions.every((a) => a.success);
  const lines = [`*Offboarding Summary for ${targetEmail}*`, '', '*Actions Taken:*'];
  for (const a of actions) {
    lines.push(`${a.success ? '✅' : '❌'} ${a.action}: ${a.success ? a.details : `ERROR — ${a.error}`}`);
  }
  lines.push(
    '',
    `*Status:* ${allSucceeded ? 'All actions completed.' : 'One or more actions failed — review errors above.'}`,
    '',
    '_Note: AI summary unavailable. Please review manually._',
  );
  return lines.join('\n');
}

function formatSlackMessage(
  targetEmail: string,
  status: OffboardingStatus,
  actions: OffboardingActionResult[],
  aiSummary: string | null,
  error: string | null,
): string {
  if (status === 'failed') {
    return `:x: *Offboarding failed* for \`${targetEmail}\`\n>${error ?? 'Unknown error.'}`;
  }
  const emoji = status === 'completed' ? ':white_check_mark:' : ':warning:';
  const label = status === 'completed' ? 'Completed' : 'Completed with errors';
  const lines = [`${emoji} *Offboarding ${label}*`, `>*Target:* \`${targetEmail}\``];
  lines.push('', '*Actions Taken:*');
  for (const a of actions) {
    lines.push(`${a.success ? ':white_check_mark:' : ':x:'} ${a.action}: _${a.success ? a.details : `ERROR — ${a.error}`}_`);
  }
  if (aiSummary) lines.push('', '────────────────────', '', aiSummary);
  return lines.join('\n');
}
