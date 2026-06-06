/**
 * JumpCloud directory sync job.
 * Uses offset pagination (limit+skip), upserts jumpcloud_users.
 */
import { db } from '../../../api/src/db/client.js';
import { organizations, jumpcloudUsers } from '../../../api/src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptOrgSettings, encryptOrgSettings } from '../../../api/src/lib/secretCrypto.js';
import { makeJumpCloudClient } from '../../../api/src/lib/jumpcloud.js';
import type { OrganizationSettings } from '@enlight/shared';
import { logger } from '../lib/logger.js';

export async function handleJumpCloudSyncJob(data: { orgId: string }): Promise<void> {
  const { orgId } = data;
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return;

  const settings = decryptOrgSettings((org.settings ?? {}) as OrganizationSettings);
  if (!settings.jumpcloud?.syncEnabled) return;

  const client = makeJumpCloudClient(settings, orgId);
  logger.info('JumpCloud sync started', { orgId });

  let skip = 0;
  const limit = 100;
  let totalSynced = 0;

  while (true) {
    const page = await client.listUsers({ skip, limit });
    if (page.results.length === 0) break;

    for (const u of page.results) {
      const displayName = [u.firstname, u.lastname].filter(Boolean).join(' ') || u.username;
      await db
        .insert(jumpcloudUsers)
        .values({
          orgId,
          jumpcloudId: u.id,
          username: u.username,
          workEmail: u.email,
          displayName,
          department: u.department ?? null,
          title: u.jobTitle ?? null,
          suspended: u.suspended,
          employmentStatus: u.suspended ? 'INACTIVE' : 'ACTIVE',
          jumpcloudData: u as unknown as Record<string, unknown>,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [jumpcloudUsers.orgId, jumpcloudUsers.jumpcloudId],
          set: {
            username: u.username,
            workEmail: u.email,
            displayName,
            department: u.department ?? null,
            title: u.jobTitle ?? null,
            suspended: u.suspended,
            employmentStatus: u.suspended ? 'INACTIVE' : 'ACTIVE',
            jumpcloudData: u as unknown as Record<string, unknown>,
            syncedAt: new Date(),
          },
        });
      totalSynced++;
    }

    skip += page.results.length;
    if (skip >= page.totalCount) break;
  }

  const updatedSettings = encryptOrgSettings({
    ...settings,
    jumpcloud: { ...settings.jumpcloud, lastSyncAt: new Date().toISOString() },
  });
  await db.update(organizations).set({ settings: updatedSettings as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(organizations.id, orgId));

  logger.info('JumpCloud sync completed', { orgId, totalSynced });
}
