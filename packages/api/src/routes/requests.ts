import { Router } from 'express';
import { db } from '../db/client.js';
import { requests, comments, attachments, projects, organizations, users } from '../db/schema.js';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { Errors } from '../lib/errors.js';
import { agentQueue, enqueueAutomationEvent } from '../queues/index.js';
import {
  notifyAgentReplied, notifyRequesterReplied,
  notifyTicketResolved, notifyAssigned,
} from '../lib/notifier.js';
import { deliverWebhooks } from '../lib/webhooks.js';
import { createRequest } from '../lib/createRequest.js';
import { makeSlackClient } from '../slack/client.js';
import { decryptOrgSettings } from '../lib/secretCrypto.js';
import { getStorageBackend, StorageNotConfiguredError } from '../lib/storage.js';
import { logger } from '../lib/logger.js';
import {
  syncRequestCreated,
  syncRequestUpdated,
  syncCommentAdded,
} from '../lib/integrations/sync.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { OrganizationSettings, StorageProvider } from '@enlight/shared';

const router = Router({ mergeParams: true });
router.use(requireAuth);

const createRequestSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().default(''),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  customFields: z.record(z.unknown()).default({}),
});

const listRequestsSchema = z.object({
  status: z.enum(['open', 'in_progress', 'pending_user', 'resolved', 'closed']).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  assigneeId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// GET /projects/:projectId/requests
router.get('/', requireProjectPermission('requests.view'), async (req, res, next) => {
  try {
    const query = listRequestsSchema.parse(req.query);
    const { projectId } = req.params as { projectId: string };

    const conditions = [eq(requests.projectId, projectId)];
    if (query.status) conditions.push(eq(requests.status, query.status));
    if (query.priority) conditions.push(eq(requests.priority, query.priority));
    if (query.assigneeId) conditions.push(eq(requests.assigneeId, query.assigneeId));

    const offset = (query.page - 1) * query.pageSize;

    const [rows, [countRow]] = await Promise.all([
      db
        .select()
        .from(requests)
        .where(and(...conditions))
        .orderBy(desc(requests.createdAt))
        .limit(query.pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(requests)
        .where(and(...conditions)),
    ]);

    res.json({
      data: rows,
      total: countRow?.count ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/requests
router.post('/', requireProjectPermission('requests.create'), async (req, res, next) => {
  try {
    const user = req.user!;
    const { projectId } = req.params as { projectId: string };
    const body = createRequestSchema.parse(req.body);

    const { request } = await createRequest({ ...body, projectId, requesterId: user.id });

    // Queue AI agent triage
    await agentQueue.add('triage', { requestId: request.id, projectId, requesterRole: user.globalRole });

    // Fire-and-forget outbound sync to external integrations (Jira/Asana/Linear)
    void syncRequestCreated(request.id);

    res.status(201).json(request);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/requests/:requestId
router.get('/:requestId', requireProjectPermission('requests.view'), async (req, res, next) => {
  try {
    const { requestId, projectId } = req.params as { requestId: string; projectId: string };

    const [request] = await db
      .select()
      .from(requests)
      .where(and(eq(requests.id, requestId), eq(requests.projectId, projectId)))
      .limit(1);

    if (!request) {
      next(Errors.notFound('Request'));
      return;
    }

    const [requestComments, requestAttachments] = await Promise.all([
      db.select().from(comments).where(eq(comments.requestId, requestId)).orderBy(comments.createdAt),
      db.select().from(attachments).where(eq(attachments.requestId, requestId)).orderBy(attachments.createdAt),
    ]);

    res.json({ ...request, comments: requestComments, attachments: requestAttachments });
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/requests/bulk — apply the same update to multiple tickets at once
router.post('/bulk', requireProjectPermission('requests.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      status:     z.enum(['open','in_progress','pending_user','resolved','closed']).optional(),
      priority:   z.enum(['critical','high','medium','low']).optional(),
      assigneeId: z.string().uuid().nullable().optional(),
    }).parse(req.body);

    const { ids, ...updates } = body;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.status !== undefined) {
      patch['status'] = updates.status;
      if (updates.status === 'resolved' || updates.status === 'closed') patch['resolvedAt'] = new Date();
    }
    if (updates.priority !== undefined) patch['priority'] = updates.priority;
    if (updates.assigneeId !== undefined) patch['assigneeId'] = updates.assigneeId;

    if (Object.keys(patch).length === 1) { res.json({ updated: 0 }); return; } // only updatedAt

    const updated = await db
      .update(requests)
      .set(patch)
      .where(and(
        eq(requests.projectId, req.params['projectId'] as string),
        inArray(requests.id, ids),
      ))
      .returning({ id: requests.id });

    // Fire webhooks for status changes
    if (updates.status === 'resolved' || updates.status === 'closed') {
      for (const r of updated) {
        notifyTicketResolved(r.id);
      }
    }
    if (updates.assigneeId) {
      for (const r of updated) {
        notifyAssigned(r.id, updates.assigneeId);
      }
    }

    res.json({ updated: updated.length });
  } catch (err) { next(err); }
});

// PATCH /projects/:projectId/requests/:requestId
router.patch('/:requestId', requireProjectPermission('requests.edit'), async (req, res, next) => {
  try {
    const { requestId, projectId } = req.params as { requestId: string; projectId: string };

    const allowed = ['title', 'description', 'status', 'priority', 'category',
      'subcategory', 'assigneeId', 'customFields'];
    const updates = Object.fromEntries(
      Object.entries(req.body as Record<string, unknown>).filter(([k]) => allowed.includes(k)),
    );

    if ((updates['status'] as string) === 'resolved' || (updates['status'] as string) === 'closed') {
      (updates as Record<string, unknown>)['resolvedAt'] = new Date();
    }

    const [updated] = await db
      .update(requests)
      .set({ ...updates, updatedAt: new Date() })
      .where(and(eq(requests.id, requestId), eq(requests.projectId, projectId)))
      .returning();

    if (!updated) {
      next(Errors.notFound('Request'));
      return;
    }

    void enqueueAutomationEvent('request_updated', updated.id);

    // Outbound sync: push field/status changes to external integrations
    const syncChanges: Record<string, string> = {};
    if (typeof updates['title'] === 'string') syncChanges['title'] = updates['title'];
    if (typeof updates['description'] === 'string') syncChanges['description'] = updates['description'];
    if (typeof updates['priority'] === 'string') syncChanges['priority'] = updates['priority'];
    if (typeof updates['status'] === 'string') syncChanges['status'] = updates['status'];
    if (Object.keys(syncChanges).length > 0) void syncRequestUpdated(updated.id, syncChanges);

    deliverWebhooks(req.user!.orgId, 'request.updated', {
      id: updated.id, ticketNumber: updated.ticketNumber, title: updated.title,
      status: updated.status, priority: updated.priority, changedFields: Object.keys(updates),
    });

    // Email notifications for status and assignment changes.
    const newStatus = updates['status'] as string | undefined;
    if (newStatus === 'resolved' || newStatus === 'closed') {
      notifyTicketResolved(updated.id);
    }
    const newAssigneeId = updates['assigneeId'] as string | null | undefined;
    if (newAssigneeId && typeof newAssigneeId === 'string') {
      notifyAssigned(updated.id, newAssigneeId);
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/requests/:requestId/comments
router.post('/:requestId/comments', requireProjectPermission('requests.comment'), async (req, res, next) => {
  try {
    const user = req.user!;
    const { requestId } = req.params as { requestId: string };

    const body = z.object({
      body: z.string().min(1),
      isInternal: z.boolean().default(false),
    }).parse(req.body);

    // Only agents/admins can post internal notes
    if (body.isInternal && (user.globalRole === 'viewer' || user.globalRole === 'customer')) {
      next(Errors.forbidden());
      return;
    }

    const [comment] = await db
      .insert(comments)
      .values({ requestId, authorId: user.id, body: body.body, isInternal: body.isInternal })
      .returning();

    if (!comment) throw Errors.internal();

    // Fire comment_added automations (e.g. notify on customer reply).
    void enqueueAutomationEvent('comment_added', requestId, comment.id);

    // Outbound sync: push public comments to external integrations
    if (!body.isInternal) void syncCommentAdded(requestId, comment.id);
    deliverWebhooks(req.user!.orgId, 'comment.added', {
      requestId, commentId: comment.id, isInternal: body.isInternal,
      authorId: user.id, body: body.body.slice(0, 500),
    });

    // ── Post-comment routing ────────────────────────────────────────────────
    // Internal notes stay inside the platform — no AI, no Slack.
    // External (public) comments are routed by who posted them:
    //   - Requester (viewer) → queue AI agent to respond
    //   - Human agent/admin  → deliver to the requester via Slack DM
    if (!body.isInternal) {
      const isFromRequester = user.globalRole === 'viewer' || user.globalRole === 'customer';
      // Email notifications (fire-and-forget, never blocks the response).
      if (isFromRequester) {
        notifyRequesterReplied(requestId, comment.id);
      } else {
        notifyAgentReplied(requestId, comment.id);
      }

      if (isFromRequester) {
        // Requester replied — let the AI respond
        await agentQueue.add('comment_received', {
          requestId,
          commentId: comment.id,
          projectId: req.params['projectId'] as string,
        });
      } else {
        // Human agent replied — push their message to the requester's Slack DM
        try {
          const [reqRow] = await db
            .select({
              slackUserId: requests.slackUserId,
              slackThreadTs: requests.slackThreadTs,
              orgId: projects.orgId,
              requesterId: requests.requesterId,
            })
            .from(requests)
            .innerJoin(projects, eq(projects.id, requests.projectId))
            .where(eq(requests.id, requestId))
            .limit(1);

          if (reqRow) {
            // requests.slackUserId is set when the request was opened via Slack DM.
            // For web-portal requests it is null, so fall back to the user record.
            let targetSlackUserId = reqRow.slackUserId;
            if (!targetSlackUserId) {
              const [requesterRow] = await db
                .select({ slackUserId: users.slackUserId })
                .from(users)
                .where(eq(users.id, reqRow.requesterId))
                .limit(1);
              targetSlackUserId = requesterRow?.slackUserId ?? null;
            }

            if (targetSlackUserId) {
              const [orgRow] = await db
                .select({ settings: organizations.settings })
                .from(organizations)
                .where(eq(organizations.id, reqRow.orgId))
                .limit(1);

              const slack = makeSlackClient(orgRow?.settings as OrganizationSettings | undefined);
              if (slack) {
                // Use the agent's name as the Slack sender (requires chat:write.customize scope)
                const postParams = {
                  username: user.name,
                  icon_emoji: ':bust_in_silhouette:',
                  text: body.body,
                };

                if (reqRow.slackThreadTs) {
                  await slack.chat.postMessage({
                    channel: targetSlackUserId,
                    thread_ts: reqRow.slackThreadTs,
                    ...postParams,
                  });
                } else {
                  const result = await slack.chat.postMessage({
                    channel: targetSlackUserId,
                    ...postParams,
                  });
                  // Anchor future messages to this thread
                  if (result.ts) {
                    await db
                      .update(requests)
                      .set({ slackThreadTs: result.ts, updatedAt: new Date() })
                      .where(eq(requests.id, requestId));
                  }
                }
                logger.info('Agent reply delivered to Slack', {
                  requestId,
                  agentId: user.id,
                  targetSlackUserId,
                });
              } else {
                logger.debug('No Slack token configured — skipping agent reply delivery', { requestId });
              }
            } else {
              logger.debug('Requester has no Slack user ID — skipping Slack delivery', { requestId });
            }
          }
        } catch (slackErr) {
          // Slack delivery is best-effort — don't fail the API response
          logger.warn('Failed to deliver agent comment to Slack', { slackErr, requestId });
        }
      }
    }

    res.status(201).json(comment);
  } catch (err) {
    next(err);
  }
});

// ── Attachments (object storage: GCS / S3 / Spaces) ─────────────────────────

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB

/** Load + decrypt the calling org's settings. */
async function orgSettings(orgId: string): Promise<OrganizationSettings> {
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return decryptOrgSettings((org?.settings ?? {}) as OrganizationSettings);
}

function attachmentDto(a: typeof attachments.$inferSelect) {
  return {
    id: a.id, requestId: a.requestId, uploaderId: a.uploaderId, filename: a.filename,
    contentType: a.contentType, sizeBytes: a.sizeBytes, storageProvider: a.storageProvider as StorageProvider,
    createdAt: a.createdAt,
  };
}

// GET /:requestId/attachments — list
router.get('/:requestId/attachments', requireProjectPermission('requests.view'), async (req, res, next) => {
  try {
    const rows = await db.select().from(attachments)
      .where(eq(attachments.requestId, req.params['requestId'] as string))
      .orderBy(desc(attachments.createdAt));
    res.json(rows.map(attachmentDto));
  } catch (err) {
    next(err);
  }
});

// POST /:requestId/attachments — upload (base64 in JSON)
router.post('/:requestId/attachments', requireProjectPermission('requests.comment'), async (req, res, next) => {
  try {
    const body = z.object({
      filename: z.string().min(1).max(255),
      contentType: z.string().min(1).max(150),
      dataBase64: z.string().min(1),
    }).parse(req.body);

    const buf = Buffer.from(body.dataBase64, 'base64');
    if (buf.length === 0) { next(Errors.badRequest('Empty or invalid file data.')); return; }
    if (buf.length > MAX_ATTACHMENT_BYTES) { next(Errors.badRequest(`File exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit.`)); return; }

    const settings = await orgSettings(req.user!.orgId);
    const provider = settings.storageProvider ?? 'none';
    const requestId = req.params['requestId'] as string;
    const safeName = body.filename.replace(/[^\w.\-]+/g, '_');
    const key = `attachments/${requestId}/${randomUUID()}-${safeName}`;

    try {
      const backend = getStorageBackend(settings);
      await backend.putObject(key, buf, body.contentType);
    } catch (err) {
      if (err instanceof StorageNotConfiguredError) { next(Errors.badRequest(err.message)); return; }
      logger.error('Attachment upload failed', { err });
      next(Errors.badRequest(`Upload failed: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const [row] = await db.insert(attachments).values({
      requestId, uploaderId: req.user!.id, gcsObjectKey: key, storageProvider: provider,
      filename: body.filename, contentType: body.contentType, sizeBytes: buf.length,
    }).returning();
    res.status(201).json(attachmentDto(row!));
  } catch (err) {
    next(err);
  }
});

// GET /:requestId/attachments/:id/download — returns a short-lived signed URL
// (the client navigates to it; a top-level navigation avoids cross-origin CORS).
router.get('/:requestId/attachments/:id/download', requireProjectPermission('requests.view'), async (req, res, next) => {
  try {
    const [a] = await db.select().from(attachments)
      .where(and(eq(attachments.id, req.params['id'] as string), eq(attachments.requestId, req.params['requestId'] as string))).limit(1);
    if (!a) { next(Errors.notFound('Attachment')); return; }
    const settings = await orgSettings(req.user!.orgId);
    const backend = getStorageBackend(settings, a.storageProvider as StorageProvider);
    const url = await backend.signedDownloadUrl(a.gcsObjectKey, a.filename);
    res.json({ url });
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) { next(Errors.badRequest(err.message)); return; }
    next(err);
  }
});

// DELETE /:requestId/attachments/:id
router.delete('/:requestId/attachments/:id', requireProjectPermission('requests.edit'), async (req, res, next) => {
  try {
    const [a] = await db.select().from(attachments)
      .where(and(eq(attachments.id, req.params['id'] as string), eq(attachments.requestId, req.params['requestId'] as string))).limit(1);
    if (!a) { next(Errors.notFound('Attachment')); return; }
    try {
      const settings = await orgSettings(req.user!.orgId);
      const backend = getStorageBackend(settings, a.storageProvider as StorageProvider);
      await backend.deleteObject(a.gcsObjectKey);
    } catch (err) {
      logger.warn('Attachment object delete failed (removing row anyway)', { err });
    }
    await db.delete(attachments).where(eq(attachments.id, a.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export { router as requestsRouter };
