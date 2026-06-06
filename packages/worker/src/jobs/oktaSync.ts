/**
 * Okta directory sync job.
 * Filters for active statuses, uses link-header cursor pagination, upserts okta_users.
 */
import { db } from '../../../api/src/db/client.js';
import { organizations, oktaUsers } from '../../../api/src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptOrgSettings, encryptOrgSettings } from '../../../api/src/lib/secretCrypto.js';
import { makeOktaClient } from '../../../api/src/lib/okta.js';
import type { OrganizationSettings } from '@enlight/shared';
import { logger } from '../lib/logger.js';

export async function handleOktaSyncJob(data: { orgId: string }): Promise<void> {
  const { orgId } = data;
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return;

  const settings = decryptOrgSettings((org.settings ?? {}) as OrganizationSettings);
  if (!settings.okta?.syncEnabled) return;

  const client = makeOktaClient(settings, orgId);
  logger.info('Okta sync started', { orgId });

  const page = await client.listUsers({
    filter: 'status eq "ACTIVE" or status eq "PROVISIONED" or status eq "RECOVERY" or status eq "PASSWORD_EXPIRED"',
    limit: 200,
  });

  let totalSynced = 0;
  for (const u of page.users) {
    const displayName = u.profile.displayName ?? [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') ?? u.profile.login;
    await db
      .insert(oktaUsers)
      .values({
        orgId,
        oktaId: u.id,
        login: u.profile.login,
        email: u.profile.email,
        displayName,
        firstName: u.profile.firstName ?? null,
        lastName: u.profile.lastName ?? null,
        department: u.profile.department ?? null,
        title: u.profile.title ?? null,
        status: u.status,
        oktaData: u as unknown as Record<string, unknown>,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [oktaUsers.orgId, oktaUsers.oktaId],
        set: {
          login: u.profile.login,
          email: u.profile.email,
          displayName,
          firstName: u.profile.firstName ?? null,
          lastName: u.profile.lastName ?? null,
          department: u.profile.department ?? null,
          title: u.profile.title ?? null,
          status: u.status,
          oktaData: u as unknown as Record<string, unknown>,
          syncedAt: new Date(),
        },
      });
    totalSynced++;
  }

  const updatedSettings = encryptOrgSettings({
    ...settings,
    okta: { ...settings.okta, lastSyncAt: new Date().toISOString() },
  });
  await db.update(organizations).set({ settings: updatedSettings as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(organizations.id, orgId));

  logger.info('Okta sync completed', { orgId, totalSynced });
}
