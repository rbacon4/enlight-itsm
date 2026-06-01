import { db } from '../db/client.js';
import { users, organizations, projectMembers } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getSlackApp } from './app.js';
import { logger } from '../lib/logger.js';
import type { Request, OrganizationSettings, ProjectRole } from '@enlight/shared';

/**
 * Resolve the Enlight user ID from a Slack user ID.
 * Looks up by slack_user_id; if not found, fetches the user's email from Slack
 * and matches against the users table.
 */
export async function resolveUserFromSlack(
  slackUserId: string,
  orgId: string,
): Promise<(typeof users.$inferSelect) | null> {
  // Fast path: already linked
  const [existing] = await db
    .select()
    .from(users)
    .where(and(eq(users.slackUserId, slackUserId), eq(users.orgId, orgId)))
    .limit(1);

  if (existing) return existing;

  // Fetch profile from Slack and match by email
  try {
    const profile = await getSlackApp().client.users.info({ user: slackUserId });
    const email = profile.user?.profile?.email;
    if (!email) return null;

    const [byEmail] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.orgId, orgId)))
      .limit(1);

    if (byEmail) {
      // Link for future lookups
      await db
        .update(users)
        .set({ slackUserId })
        .where(eq(users.id, byEmail.id));
      return { ...byEmail, slackUserId };
    }

    // Auto-provision: if the email domain is in the org's approved list, create an account
    const domain = email.split('@')[1]?.toLowerCase();
    if (domain) {
      const [org] = await db
        .select({ settings: organizations.settings })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);

      const settings = (org?.settings ?? {}) as OrganizationSettings;
      const approvedDomains = (settings.approvedDomains ?? []).map((d) => d.toLowerCase());

      if (approvedDomains.includes(domain)) {
        const slackProfile = profile.user;
        const name =
          slackProfile?.real_name ||
          slackProfile?.profile?.real_name ||
          slackProfile?.name ||
          email.split('@')[0] ||
          'Unknown';

        const role = settings.autoProvisionRole ?? 'customer';

        const [newUser] = await db
          .insert(users)
          .values({ orgId, email, name, slackUserId, globalRole: role })
          .returning();

        if (newUser) {
          logger.info('Auto-provisioned Slack user', { email, domain, orgId, role });
          return newUser;
        }
      }
    }
  } catch (err) {
    logger.warn('Could not resolve Slack user', { slackUserId, err });
  }

  return null;
}

/**
 * Send a DM to a Slack user. Returns the message ts for threading.
 */
export async function sendDM(
  slackUserId: string,
  text: string,
  blocks?: object[],
): Promise<string | undefined> {
  try {
    const result = await getSlackApp().client.chat.postMessage({
      channel: slackUserId,
      text,
      blocks: blocks as never,
    });
    return result.ts as string | undefined;
  } catch (err) {
    logger.error('Failed to send DM', { slackUserId, err });
    return undefined;
  }
}

/**
 * Send a threaded message to an existing DM thread.
 */
export async function sendThreadedDM(
  slackUserId: string,
  threadTs: string,
  text: string,
  blocks?: object[],
): Promise<void> {
  try {
    await getSlackApp().client.chat.postMessage({
      channel: slackUserId,
      thread_ts: threadTs,
      text,
      blocks: blocks as never,
    });
  } catch (err) {
    logger.error('Failed to send threaded DM', { slackUserId, threadTs, err });
  }
}

/** Role precedence for upgrade-only policy (higher index = higher rank). */
const ROLE_RANK: Record<ProjectRole, number> = {
  customer: 0,
  viewer: 1,
  agent: 2,
  admin: 3,
};

/**
 * For each group assignment, fetch its members from Slack, resolve/auto-provision
 * each as an Enlight user, and upsert them into `project_members` with the
 * group's assigned role.
 *
 * Existing members are never downgraded — if an existing role outranks the
 * group role the row is left unchanged and counted as skipped.
 *
 * Returns counts of successfully added/upgraded, skipped, and failed members.
 */
export async function syncProjectUserGroupMembers(
  projectId: string,
  orgId: string,
  groups: Array<{ id: string; role: ProjectRole }>,
): Promise<{ added: number; skipped: number; failed: number }> {
  if (groups.length === 0) return { added: 0, skipped: 0, failed: 0 };

  const client = getSlackApp().client;
  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const group of groups) {
    let slackUserIds: string[];
    try {
      const result = await client.usergroups.users.list({ usergroup: group.id });
      slackUserIds = (result.users as string[] | undefined) ?? [];
    } catch (err) {
      logger.warn('Failed to list Slack user group members', { groupId: group.id, err });
      failed++;
      continue;
    }

    for (const slackUserId of slackUserIds) {
      try {
        const user = await resolveUserFromSlack(slackUserId, orgId);
        if (!user) { failed++; continue; }

        const [existing] = await db
          .select({ role: projectMembers.role })
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)))
          .limit(1);

        if (existing) {
          // Upgrade role if group role outranks current role
          if (ROLE_RANK[group.role] > ROLE_RANK[existing.role]) {
            await db
              .update(projectMembers)
              .set({ role: group.role })
              .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)));
            added++;
          } else {
            skipped++;
          }
          continue;
        }

        await db.insert(projectMembers).values({ projectId, userId: user.id, role: group.role });
        added++;
      } catch (err) {
        logger.warn('Failed to add user group member to project', { slackUserId, projectId, err });
        failed++;
      }
    }
  }

  logger.info('User group sync complete', { projectId, groups, added, skipped, failed });
  return { added, skipped, failed };
}

/**
 * Notify the requester of a status change on their request.
 */
export async function notifyRequesterStatusChange(
  req: Request,
  requesterSlackUserId: string | null,
  newStatus: string,
  agentName?: string,
): Promise<void> {
  if (!requesterSlackUserId) return;

  const statusMessages: Record<string, string> = {
    in_progress: `🔄 Your request *${req.title}* is now being worked on${agentName ? ` by ${agentName}` : ''}.`,
    pending_user: `💬 A question about your request *${req.title}* is waiting for your response.`,
    resolved: `✅ Your request *${req.title}* has been resolved. Reply here if you need further help.`,
    closed: `🔒 Your request *${req.title}* has been closed.`,
  };

  const message = statusMessages[newStatus];
  if (!message) return;

  if (req.slackThreadTs) {
    await sendThreadedDM(requesterSlackUserId, req.slackThreadTs, message);
  } else {
    await sendDM(requesterSlackUserId, message);
  }
}
