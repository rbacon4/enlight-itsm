import { Router } from 'express';
import { db } from '../db/client.js';
import { knowledgeSources } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { Errors } from '../lib/errors.js';
import { kbSyncQueue } from '../queues/index.js';
import { z } from 'zod';

const router = Router({ mergeParams: true });
router.use(requireAuth);

const chunkFields = {
  chunkSize: z.number().int().min(128).max(2048).default(512),
  chunkOverlap: z.number().int().min(0).max(512).default(64),
  minChunkSize: z.number().int().min(0).default(64),
};

const createSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('confluence'),
    // baseUrl: e.g. https://mycompany.atlassian.net
    // email + accessToken: Confluence API token (email = your Atlassian account email)
    config: z.object({
      baseUrl: z.string().url(),
      spaceKeys: z.array(z.string()).min(1),
      email: z.string().email().optional(),
      accessToken: z.string().optional(),
    }),
    ...chunkFields,
  }),
  z.object({
    type: z.literal('gdrive'),
    // folderIds: Google Drive folder IDs to sync (omit for My Drive root)
    // accessToken: short-lived OAuth2 token (for dev); use oauthSecretRef in prod
    config: z.object({
      folderIds: z.array(z.string()).optional(),
      accessToken: z.string().optional(),
    }),
    ...chunkFields,
  }),
  z.object({
    type: z.literal('notion'),
    // Provide databaseIds and/or pageIds to sync
    config: z.object({
      databaseIds: z.array(z.string()).optional(),
      pageIds: z.array(z.string()).optional(),
      accessToken: z.string().optional(),
    }),
    ...chunkFields,
  }),
  z.object({
    type: z.literal('file'),
    fileType: z.enum(['pdf', 'txt', 'rtf', 'docx']),
    config: z.object({
      // fileContent: base64-encoded file bytes (uploaded via browser)
      fileContent: z.string().max(30_000_000).optional(), // ~20 MB binary
      // localPath for local dev; gcsObjectKey for production
      localPath: z.string().optional(),
      gcsObjectKey: z.string().optional(),
      filename: z.string(),
    }),
    ...chunkFields,
  }),
]);

// GET /projects/:projectId/knowledge/sources
router.get('/sources', requireProjectPermission('knowledge.view'), async (req, res, next) => {
  try {
    const sources = await db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.projectId, req.params['projectId'] as string));

    res.json(sources);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/knowledge/sources
router.post('/sources', requireProjectPermission('knowledge.manage'), async (req, res, next) => {
  try {
    const body = createSourceSchema.parse(req.body);

    const [source] = await db
      .insert(knowledgeSources)
      .values({
        projectId: req.params['projectId'] as string,
        ...body,
        fileType: 'fileType' in body ? body.fileType : null,
      })
      .returning();

    if (!source) throw Errors.internal();

    // Queue initial sync
    await kbSyncQueue.add('sync', { sourceId: source.id });

    res.status(201).json(source);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/knowledge/sources/:sourceId/sync
router.post('/sources/:sourceId/sync', requireProjectPermission('knowledge.manage'), async (req, res, next) => {
  try {
    const { projectId, sourceId } = req.params as { projectId: string; sourceId: string };

    const [source] = await db
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.id, sourceId), eq(knowledgeSources.projectId, projectId)))
      .limit(1);

    if (!source) {
      next(Errors.notFound('Knowledge source'));
      return;
    }

    await kbSyncQueue.add('sync', { sourceId });

    res.json({ queued: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /projects/:projectId/knowledge/sources/:sourceId
router.delete('/sources/:sourceId', requireProjectPermission('knowledge.manage'), async (req, res, next) => {
  try {
    const { projectId, sourceId } = req.params as { projectId: string; sourceId: string };

    const [deleted] = await db
      .delete(knowledgeSources)
      .where(and(eq(knowledgeSources.id, sourceId), eq(knowledgeSources.projectId, projectId)))
      .returning();

    if (!deleted) {
      next(Errors.notFound('Knowledge source'));
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export { router as knowledgeRouter };
