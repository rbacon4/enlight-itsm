/**
 * Integration sync orchestrator.
 *
 * Provides a provider-agnostic API for outbound ticket sync and is called by:
 *   - routes/requests.ts (on create/update/comment)
 *   - worker/jobs/integrationSync.ts (async queue)
 *   - routes/integrations.ts (inbound webhooks, manual sync)
 */

import { db } from '../../db/client.js';
import { integrations, requestExternalRefs, requests, comments } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { decryptSecret } from '../secretCrypto.js';
import { logger } from '../logger.js';
import type { IntegrationProvider, JiraConfig, AsanaConfig, LinearConfig } from './types.js';
import {
  createJiraIssue, updateJiraIssue, transitionJiraIssue, getJiraIssue, addJiraComment,
  testJiraConnection,
} from './jira.js';
import {
  createAsanaTask, updateAsanaTask, transitionAsanaTask, getAsanaTask, addAsanaComment,
  testAsanaConnection,
} from './asana.js';
import {
  createLinearIssue, updateLinearIssue, transitionLinearIssue, getLinearIssue, addLinearComment,
  testLinearConnection,
} from './linear.js';

// ── Config decryption ─────────────────────────────────────────────────────────

function decryptConfig(provider: string, config: Record<string, unknown>): Record<string, unknown> {
  const secretFields: Record<string, string[]> = {
    jira: ['apiToken'],
    asana: ['accessToken'],
    linear: ['apiKey'],
  };
  const fields = secretFields[provider] ?? [];
  const out = { ...config };
  for (const field of fields) {
    if (typeof out[field] === 'string' && (out[field] as string).startsWith('enc:')) {
      out[field] = decryptSecret(out[field] as string);
    }
  }
  return out;
}

// ── Test connection ───────────────────────────────────────────────────────────

export async function testIntegrationConnection(
  provider: IntegrationProvider,
  config: Record<string, unknown>,
): Promise<string | null> {
  const cfg = decryptConfig(provider, config);
  switch (provider) {
    case 'jira':   return testJiraConnection(cfg as unknown as JiraConfig);
    case 'asana':  return testAsanaConnection(cfg as unknown as AsanaConfig);
    case 'linear': return testLinearConnection(cfg as unknown as LinearConfig);
  }
}

// ── Outbound sync: create external ticket ────────────────────────────────────

export async function syncRequestCreated(requestId: string): Promise<void> {
  const [req] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);

  if (!req) return;

  const projectIntegrations = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.projectId, req.projectId), eq(integrations.enabled, true)));

  for (const integration of projectIntegrations) {
    try {
      // Skip if already synced
      const [existing] = await db
        .select()
        .from(requestExternalRefs)
        .where(
          and(
            eq(requestExternalRefs.requestId, requestId),
            eq(requestExternalRefs.integrationId, integration.id),
          ),
        )
        .limit(1);

      if (existing) continue;

      const cfg = decryptConfig(
        integration.provider,
        integration.config as Record<string, unknown>,
      );
      const ticket = {
        title: req.title,
        description: req.description,
        priority: req.priority,
      };

      let result;
      switch (integration.provider) {
        case 'jira':
          result = await createJiraIssue(cfg as unknown as JiraConfig, ticket);
          break;
        case 'asana':
          result = await createAsanaTask(cfg as unknown as AsanaConfig, ticket);
          break;
        case 'linear':
          result = await createLinearIssue(cfg as unknown as LinearConfig, ticket);
          break;
        default:
          continue;
      }

      await db.insert(requestExternalRefs).values({
        requestId,
        integrationId: integration.id,
        externalId: result.externalId,
        externalUrl: result.externalUrl,
      });

      logger.info('Outbound sync: ticket created', {
        provider: integration.provider,
        requestId,
        externalId: result.externalId,
      });
    } catch (err) {
      logger.error('Outbound sync failed (create)', {
        provider: integration.provider,
        requestId,
        err,
      });
      // Record the error but don't fail the request operation
      await db
        .insert(requestExternalRefs)
        .values({
          requestId,
          integrationId: integration.id,
          externalId: '',
          externalUrl: '',
          syncError: (err as Error).message,
        })
        .onConflictDoUpdate({
          target: [requestExternalRefs.requestId, requestExternalRefs.integrationId],
          set: { syncError: (err as Error).message, syncedAt: new Date() },
        });
    }
  }
}

// ── Outbound sync: update external ticket ────────────────────────────────────

export async function syncRequestUpdated(
  requestId: string,
  changes: { title?: string; description?: string; priority?: string; status?: string },
): Promise<void> {
  const refs = await db
    .select({ ref: requestExternalRefs, integration: integrations })
    .from(requestExternalRefs)
    .innerJoin(integrations, eq(requestExternalRefs.integrationId, integrations.id))
    .where(
      and(
        eq(requestExternalRefs.requestId, requestId),
        eq(integrations.enabled, true),
      ),
    );

  for (const { ref, integration } of refs) {
    if (!ref.externalId) continue;
    try {
      const cfg = decryptConfig(
        integration.provider,
        integration.config as Record<string, unknown>,
      );

      switch (integration.provider) {
        case 'jira': {
          const jiraCfg = cfg as unknown as JiraConfig;
          if (changes.title !== undefined || changes.description !== undefined || changes.priority !== undefined) {
            await updateJiraIssue(jiraCfg, ref.externalId, changes);
          }
          if (changes.status) {
            const targetName = jiraCfg.statusMap?.[changes.status];
            if (targetName) await transitionJiraIssue(jiraCfg, ref.externalId, targetName);
          }
          break;
        }
        case 'asana': {
          const asanaCfg = cfg as unknown as AsanaConfig;
          if (changes.title !== undefined || changes.description !== undefined) {
            await updateAsanaTask(asanaCfg, ref.externalId, changes);
          }
          if (changes.status) {
            await transitionAsanaTask(asanaCfg, ref.externalId, changes.status);
          }
          break;
        }
        case 'linear': {
          const linearCfg = cfg as unknown as LinearConfig;
          if (changes.title !== undefined || changes.description !== undefined || changes.priority !== undefined) {
            await updateLinearIssue(linearCfg, ref.externalId, changes);
          }
          if (changes.status) {
            await transitionLinearIssue(linearCfg, ref.externalId, changes.status);
          }
          break;
        }
      }

      await db
        .update(requestExternalRefs)
        .set({ syncedAt: new Date(), syncError: null })
        .where(eq(requestExternalRefs.id, ref.id));

    } catch (err) {
      logger.error('Outbound sync failed (update)', {
        provider: integration.provider,
        requestId,
        externalId: ref.externalId,
        err,
      });
      await db
        .update(requestExternalRefs)
        .set({ syncError: (err as Error).message })
        .where(eq(requestExternalRefs.id, ref.id));
    }
  }
}

// ── Outbound sync: push a comment ────────────────────────────────────────────

export async function syncCommentAdded(
  requestId: string,
  commentId: string,
): Promise<void> {
  const [comment] = await db
    .select()
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);

  if (!comment) return;

  const refs = await db
    .select({ ref: requestExternalRefs, integration: integrations })
    .from(requestExternalRefs)
    .innerJoin(integrations, eq(requestExternalRefs.integrationId, integrations.id))
    .where(
      and(
        eq(requestExternalRefs.requestId, requestId),
        eq(integrations.enabled, true),
      ),
    );

  for (const { ref, integration } of refs) {
    if (!ref.externalId) continue;
    try {
      const cfg = decryptConfig(
        integration.provider,
        integration.config as Record<string, unknown>,
      );
      const text = comment.body;
      switch (integration.provider) {
        case 'jira':   await addJiraComment(cfg as unknown as JiraConfig, ref.externalId, text); break;
        case 'asana':  await addAsanaComment(cfg as unknown as AsanaConfig, ref.externalId, text); break;
        case 'linear': await addLinearComment(cfg as unknown as LinearConfig, ref.externalId, text); break;
      }
    } catch (err) {
      logger.error('Comment sync failed', { provider: integration.provider, commentId, err });
    }
  }
}

// ── Inbound sync: update Enlight from external event ─────────────────────────

/**
 * Called by inbound webhook handlers. Looks up the request by externalId +
 * integrationId and applies the incoming changes to the Enlight request.
 * Returns the updated request ID or null if not found.
 */
export async function applyInboundUpdate(
  integrationId: string,
  externalId: string,
  changes: { title?: string; description?: string; status?: string },
): Promise<string | null> {
  const [ref] = await db
    .select()
    .from(requestExternalRefs)
    .where(
      and(
        eq(requestExternalRefs.integrationId, integrationId),
        eq(requestExternalRefs.externalId, externalId),
      ),
    )
    .limit(1);

  if (!ref) return null;

  const update: Partial<typeof requests.$inferInsert> = { updatedAt: new Date() };

  if (changes.title) update.title = changes.title;
  if (changes.description) update.description = changes.description;

  // Map external status → Enlight status
  if (changes.status) {
    const enlightStatus = mapExternalStatusToEnlight(changes.status);
    if (enlightStatus) update.status = enlightStatus;
    if (enlightStatus === 'resolved') update.resolvedAt = new Date();
  }

  if (Object.keys(update).length > 1) { // more than just updatedAt
    await db.update(requests).set(update).where(eq(requests.id, ref.requestId));
    await db
      .update(requestExternalRefs)
      .set({ syncedAt: new Date(), syncError: null })
      .where(eq(requestExternalRefs.id, ref.id));

    logger.info('Inbound sync applied', { integrationId, externalId, requestId: ref.requestId });
  }

  return ref.requestId;
}

/** Heuristic mapping of external status names → Enlight statuses. */
function mapExternalStatusToEnlight(
  externalStatus: string,
): 'open' | 'in_progress' | 'resolved' | 'closed' | 'pending_user' | null {
  const s = externalStatus.toLowerCase();
  if (['to do', 'todo', 'backlog', 'open', 'triage'].some((v) => s.includes(v))) return 'open';
  if (['in progress', 'in-progress', 'doing', 'started'].some((v) => s.includes(v))) return 'in_progress';
  if (['done', 'resolved', 'complete', 'completed', 'closed', 'won\'t fix', 'wontfix'].some((v) => s.includes(v)))
    return 'resolved';
  if (['waiting', 'pending', 'on hold'].some((v) => s.includes(v))) return 'pending_user';
  return null;
}
