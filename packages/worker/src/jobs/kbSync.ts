import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../../api/src/db/client.js';
import { knowledgeSources, knowledgeChunks, projects, organizations } from '../../../api/src/db/schema.js';
import { embedTexts, type EmbeddingKeyOverrides } from '../../../api/src/lib/embeddings.js';
import { decryptOrgSettings } from '../../../api/src/lib/secretCrypto.js';
import type { OrganizationSettings } from '@enlight/shared';
import { chunkText } from '../lib/chunker.js';
import { getFileDocuments } from '../sources/file.js';
import { getConfluenceDocuments } from '../sources/confluence.js';
import { getGDriveDocuments } from '../sources/gdrive.js';
import { getNotionDocuments } from '../sources/notion.js';
import { logger } from '../lib/logger.js';

interface KbSyncJobData {
  sourceId: string;
}

const EMBED_BATCH = 50;

export async function handleKbSyncJob(job: Job<KbSyncJobData>): Promise<void> {
  const { sourceId } = job.data;
  logger.info('KB sync starting', { sourceId });

  const [source] = await db
    .select()
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, sourceId))
    .limit(1);

  if (!source) {
    logger.warn('KB sync: source not found', { sourceId });
    return;
  }

  // Fetch org settings for API key overrides (org → project → knowledgeSource chain)
  const [project] = await db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, source.projectId))
    .limit(1);

  const [org] = project
    ? await db
        .select({ settings: organizations.settings })
        .from(organizations)
        .where(eq(organizations.id, project.orgId))
        .limit(1)
    : [];

  const orgSettings = decryptOrgSettings((org?.settings ?? {}) as OrganizationSettings);
  const embeddingOverrides: EmbeddingKeyOverrides = {
    embeddingProvider: orgSettings.embeddingProvider,
    voyageApiKey:      orgSettings.voyageApiKey,
    openAiApiKey:      orgSettings.openAiApiKey,
  };

  await db
    .update(knowledgeSources)
    .set({ status: 'syncing', errorMessage: null, updatedAt: new Date() })
    .where(eq(knowledgeSources.id, sourceId));

  try {
    const documents = await fetchDocuments(source);

    // Replace all existing chunks for this source
    await db.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));

    let totalChunks = 0;
    for (const doc of documents) {
      const chunks = chunkText(doc.body, source.chunkSize, source.chunkOverlap, source.minChunkSize);
      if (chunks.length === 0) continue;

      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const embeddings = await embedTexts(batch, embeddingOverrides);

        const rows = batch.map((body, j) => {
          const embedding = embeddings[j];
          if (!embedding) throw new Error(`Missing embedding at index ${j}`);
          return {
            sourceId,
            title: doc.title,
            body,
            embedding,
            sourceUrl: doc.sourceUrl ?? null,
            metadata: { ...doc.metadata, chunkIndex: i + j } as Record<string, unknown>,
          };
        });

        await db.insert(knowledgeChunks).values(rows);
        totalChunks += batch.length;
      }
    }

    await db
      .update(knowledgeSources)
      .set({
        status: 'active',
        lastSyncedAt: new Date(),
        documentCount: documents.length,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSources.id, sourceId));

    logger.info('KB sync complete', { sourceId, documents: documents.length, chunks: totalChunks });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await db
      .update(knowledgeSources)
      .set({ status: 'error', errorMessage, updatedAt: new Date() })
      .where(eq(knowledgeSources.id, sourceId));
    logger.error('KB sync failed', { sourceId, err });
    throw err;
  }
}

async function fetchDocuments(source: typeof knowledgeSources.$inferSelect) {
  switch (source.type) {
    case 'file':
      return getFileDocuments(source);
    case 'confluence':
      return getConfluenceDocuments(source);
    case 'gdrive':
      return getGDriveDocuments(source);
    case 'notion':
      return getNotionDocuments(source);
    default:
      throw new Error(`Unknown source type: ${source.type}`);
  }
}
