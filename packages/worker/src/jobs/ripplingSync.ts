/**
 * Rippling IT directory sync job.
 * Pages through all workers and upserts them into rippling_workers.
 * Cron: every 4h (or RIPPLING_SYNC_CRON env).
 */
import { db } from '../../../api/src/db/client.js';
import { organizations, ripplingWorkers } from '../../../api/src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptOrgSettings, encryptOrgSettings } from '../../../api/src/lib/secretCrypto.js';
import { makeRipplingClient } from '../../../api/src/lib/rippling.js';
import type { OrganizationSettings } from '@enlight/shared';
import { logger } from '../lib/logger.js';

export async function handleRipplingSyncJob(data: { orgId: string }): Promise<void> {
  const { orgId } = data;
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return;

  const settings = decryptOrgSettings((org.settings ?? {}) as OrganizationSettings);
  if (!settings.rippling?.syncEnabled) return;

  const client = makeRipplingClient(settings);
  logger.info('Rippling sync started', { orgId });

  let cursor: string | undefined;
  let totalSynced = 0;

  do {
    const page = await client.listWorkers({ cursor, limit: 100 });
    for (const w of page.data) {
      const displayName = `${w.name.firstName} ${w.name.lastName}`.trim();
      await db
        .insert(ripplingWorkers)
        .values({
          orgId,
          ripplingId: w.id,
          workEmail: w.workEmail,
          personalEmail: w.personalEmail ?? null,
          displayName,
          department: w.department ?? null,
          title: w.title ?? null,
          employmentStatus: w.employmentStatus,
          ripplingData: w as unknown as Record<string, unknown>,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [ripplingWorkers.orgId, ripplingWorkers.ripplingId],
          set: {
            workEmail: w.workEmail,
            personalEmail: w.personalEmail ?? null,
            displayName,
            department: w.department ?? null,
            title: w.title ?? null,
            employmentStatus: w.employmentStatus,
            ripplingData: w as unknown as Record<string, unknown>,
            syncedAt: new Date(),
          },
        });
      totalSynced++;
    }
    cursor = page.nextCursor;
  } while (cursor);

  // Update lastSyncAt
  const updatedSettings = encryptOrgSettings({
    ...settings,
    rippling: { ...settings.rippling, lastSyncAt: new Date().toISOString() },
  });
  await db.update(organizations).set({ settings: updatedSettings as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(organizations.id, orgId));

  logger.info('Rippling sync completed', { orgId, totalSynced });
}
