import type { App } from '@slack/bolt';
import { db } from '../db/client.js';
import { requests, projects, organizations, projectMembers, users } from '../db/schema.js';
import { eq, and, inArray, isNull, desc } from 'drizzle-orm';
import { resolveUserFromSlack } from './userSync.js';
import { appHomeBlocks, type ReqWithProject } from './blocks.js';
import { decryptOrgSettings } from '../lib/secretCrypto.js';
import { resolveGlobalPermissions } from '../lib/permissions.js';
import { logger } from '../lib/logger.js';
import type { SlackQuickAction, ProjectRole, GlobalRole, OrganizationSettings } from '@enlight/shared';

// ── Quick-action blocks ───────────────────────────────────────────────────────

function quickActionBlocks(
  projectId: string,
  projectName: string,
  actions: SlackQuickAction[],
) {
  if (actions.length === 0) return [];

  return [
    { type: 'divider' as const },
    {
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: `*⚡ ${projectName} — Quick Actions*` },
    },
    {
      type: 'actions' as const,
      elements: actions.map((a) => ({
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: `${a.emoji} ${a.label}`, emoji: true },
        action_id: `quick_action:${projectId}:${a.id}`,
        value: a.id,
      })),
    },
  ];
}

/**
 * Returns projects this user is an explicit member of that have quick actions,
 * filtered to only the actions visible to the user's role in each project.
 *
 * Global super_admin / admin always see all actions regardless of visibleToRoles.
 */
async function getUserQuickActionProjects(
  orgUserId: string,
  orgId: string,
  globalRole: GlobalRole,
) {
  const memberships = await db
    .select({
      projectId: projectMembers.projectId,
      projectRole: projectMembers.role,
      projectName: projects.name,
      slackQuickActions: projects.slackQuickActions,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.userId, orgUserId),
        eq(projects.orgId, orgId),
        eq(projects.status, 'active'),
      ),
    );

  const isSuperUser = globalRole === 'super_admin' || globalRole === 'admin';

  return memberships.map((m) => ({
    projectId: m.projectId,
    projectName: m.projectName,
    actions: (m.slackQuickActions as SlackQuickAction[]).filter((a) => {
      if (a.fields.length === 0) return false;
      // No role restriction → visible to everyone
      if (!a.visibleToRoles || a.visibleToRoles.length === 0) return true;
      // Global admins bypass role filters
      if (isSuperUser) return true;
      return a.visibleToRoles.includes(m.projectRole as ProjectRole);
    }),
  }));
}

/** "Start Offboarding" button, shown when the user has offboarding.run and it's enabled. */
async function offboardingBlocks(orgId: string, orgUserId: string) {
  const [u] = await db
    .select({ roleId: users.roleId, globalRole: users.globalRole })
    .from(users)
    .where(eq(users.id, orgUserId))
    .limit(1);
  if (!u) return [];
  const perms = await resolveGlobalPermissions({ roleId: u.roleId, globalRole: u.globalRole });
  if (!perms.includes('offboarding.run')) return [];
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const settings = decryptOrgSettings((org?.settings ?? {}) as OrganizationSettings);
  if (!settings.offboarding?.enabled) return [];

  return [
    { type: 'divider' as const },
    {
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: '*🧹 Employee Offboarding*\nSuspend a Google Workspace account, move it to the Departed OU, and optionally transfer Drive files.' },
    },
    {
      type: 'actions' as const,
      elements: [
        {
          type: 'button' as const,
          style: 'danger' as const,
          text: { type: 'plain_text' as const, text: '🧹 Start Offboarding', emoji: true },
          action_id: 'start_offboarding',
        },
      ],
    },
  ];
}

// ── App Home builders ─────────────────────────────────────────────────────────

/** Fetch App Home data for an agent / admin and push the view. */
export async function pushAgentHome(
  slackUserId: string,
  orgUserId: string,
  orgId: string,
  globalRole: GlobalRole,
  client: App['client'],
): Promise<void> {
  // Get all project IDs for this org
  const orgProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.status, 'active')));
  const projectIds = orgProjects.map((p) => p.id);

  if (projectIds.length === 0) {
    await client.views.publish({
      user_id: slackUserId,
      view: {
        type: 'home',
        blocks: appHomeBlocks([], [], true, []),
      },
    });
    return;
  }

  // Helper: select request fields + project name/key via join
  const selectWithProject = {
    id: requests.id,
    projectId: requests.projectId,
    title: requests.title,
    description: requests.description,
    status: requests.status,
    priority: requests.priority,
    category: requests.category,
    subcategory: requests.subcategory,
    requesterId: requests.requesterId,
    assigneeId: requests.assigneeId,
    customFields: requests.customFields,
    slackThreadTs: requests.slackThreadTs,
    slackUserId: requests.slackUserId,
    createdAt: requests.createdAt,
    updatedAt: requests.updatedAt,
    resolvedAt: requests.resolvedAt,
    ticketNumber: requests.ticketNumber,
    projectName: projects.name,
    projectKey: projects.key,
  } as const;

  const [myOpen, unassigned, recentResolved, quickActionProjects] = await Promise.all([
    // Tickets assigned to this agent that are active
    db
      .select(selectWithProject)
      .from(requests)
      .leftJoin(projects, eq(requests.projectId, projects.id))
      .where(
        and(
          inArray(requests.projectId, projectIds),
          eq(requests.assigneeId, orgUserId),
          inArray(requests.status, ['open', 'in_progress', 'pending_user']),
        ),
      )
      .orderBy(desc(requests.updatedAt))
      .limit(20),

    // Unassigned open tickets across the org
    db
      .select(selectWithProject)
      .from(requests)
      .leftJoin(projects, eq(requests.projectId, projects.id))
      .where(
        and(
          inArray(requests.projectId, projectIds),
          isNull(requests.assigneeId),
          eq(requests.status, 'open'),
        ),
      )
      .orderBy(desc(requests.createdAt))
      .limit(20),

    // Recently resolved tickets assigned to this agent
    db
      .select(selectWithProject)
      .from(requests)
      .leftJoin(projects, eq(requests.projectId, projects.id))
      .where(
        and(
          inArray(requests.projectId, projectIds),
          eq(requests.assigneeId, orgUserId),
          inArray(requests.status, ['resolved', 'closed']),
        ),
      )
      .orderBy(desc(requests.resolvedAt))
      .limit(5),

    getUserQuickActionProjects(orgUserId, orgId, globalRole),
  ]);

  const qaBlocks = quickActionProjects.flatMap(({ projectId, projectName, actions }) =>
    quickActionBlocks(projectId, projectName, actions),
  );

  const offBlocks = await offboardingBlocks(orgId, orgUserId);

  await client.views.publish({
    user_id: slackUserId,
    view: {
      type: 'home',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: [...appHomeBlocks(myOpen as any, recentResolved as any, true, unassigned as any), ...qaBlocks, ...offBlocks],
    },
  });
}

/** Fetch App Home data for an end-user and push the view. */
async function pushUserHome(
  slackUserId: string,
  orgUserId: string,
  orgId: string,
  globalRole: GlobalRole,
  client: App['client'],
): Promise<void> {
  const orgProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.status, 'active')));
  const projectIds = orgProjects.map((p) => p.id);

  if (projectIds.length === 0) {
    await client.views.publish({
      user_id: slackUserId,
      view: { type: 'home', blocks: appHomeBlocks([], [], false) },
    });
    return;
  }

  const selectWithProject = {
    id: requests.id,
    projectId: requests.projectId,
    title: requests.title,
    description: requests.description,
    status: requests.status,
    priority: requests.priority,
    category: requests.category,
    subcategory: requests.subcategory,
    requesterId: requests.requesterId,
    assigneeId: requests.assigneeId,
    customFields: requests.customFields,
    slackThreadTs: requests.slackThreadTs,
    slackUserId: requests.slackUserId,
    createdAt: requests.createdAt,
    updatedAt: requests.updatedAt,
    resolvedAt: requests.resolvedAt,
    ticketNumber: requests.ticketNumber,
    projectName: projects.name,
    projectKey: projects.key,
  } as const;

  const [openReqs, resolvedReqs, quickActionProjects] = await Promise.all([
    db
      .select(selectWithProject)
      .from(requests)
      .leftJoin(projects, eq(requests.projectId, projects.id))
      .where(
        and(
          eq(requests.requesterId, orgUserId),
          inArray(requests.status, ['open', 'in_progress', 'pending_user']),
        ),
      )
      .orderBy(desc(requests.updatedAt))
      .limit(20),

    db
      .select(selectWithProject)
      .from(requests)
      .leftJoin(projects, eq(requests.projectId, projects.id))
      .where(
        and(
          eq(requests.requesterId, orgUserId),
          inArray(requests.status, ['resolved', 'closed']),
        ),
      )
      .orderBy(desc(requests.resolvedAt))
      .limit(5),

    getUserQuickActionProjects(orgUserId, orgId, globalRole),
  ]);

  const qaBlocks = quickActionProjects.flatMap(({ projectId, projectName, actions }) =>
    quickActionBlocks(projectId, projectName, actions),
  );

  await client.views.publish({
    user_id: slackUserId,
    view: {
      type: 'home',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: [...appHomeBlocks(openReqs as any, resolvedReqs as any, false), ...qaBlocks],
    },
  });
}

export function registerAppHomeHandlers(app: App): void {
  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;

    const slackUserId = event.user;

    const [org] = await db.select().from(organizations).limit(1);
    if (!org) {
      await client.views.publish({
        user_id: slackUserId,
        view: {
          type: 'home',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '⚠️ Enlight is not yet configured. Ask your admin to complete setup.',
              },
            },
          ],
        },
      });
      return;
    }

    const user = await resolveUserFromSlack(slackUserId, org.id);
    if (!user) {
      await client.views.publish({
        user_id: slackUserId,
        view: {
          type: 'home',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: "👋 Welcome to Enlight! You don't have an account yet. Ask your admin to invite you.",
              },
            },
          ],
        },
      });
      return;
    }

    const isAgent =
      user.globalRole === 'super_admin' ||
      user.globalRole === 'admin' ||
      user.globalRole === 'agent';

    try {
      if (isAgent) {
        await pushAgentHome(slackUserId, user.id, org.id, user.globalRole, client);
      } else {
        await pushUserHome(slackUserId, user.id, org.id, user.globalRole, client);
      }
    } catch (err) {
      logger.error('Failed to render App Home', { slackUserId, err });
    }
  });
}
