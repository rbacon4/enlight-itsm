import type { App } from '@slack/bolt';
import { db } from '../db/client.js';
import { requests, projects, organizations, comments, projectMembers } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { resolveUserFromSlack, sendDM, sendThreadedDM } from './userSync.js';
import { newRequestModal, requestDetailBlocks } from './blocks.js';
import { agentQueue } from '../queues/index.js';
import { createRequest } from '../lib/createRequest.js';
import { ticketId } from '@enlight/shared';
import { logger } from '../lib/logger.js';
import { getSlackApp } from './app.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

type SlackFileRef = { name?: string; title?: string; permalink?: string };

type ProjectEntry = {
  id: string;
  name: string;
  categories: unknown;
  accessType: string;
  allowedSlackUserGroups: unknown;
};

/**
 * Check whether a Slack user may submit to a given project.
 * - Open projects → always allowed (anyone from an approved domain).
 * - Restricted projects → user must be an explicit project member OR belong
 *   to one of the project's allowed Slack user groups.
 *
 * Requires the `usergroups:read` bot scope for group checks.
 * Fails closed on Slack API errors (denies access with a warning log).
 */
async function canUserAccessProject(
  slackUserId: string,
  userId: string,
  project: ProjectEntry,
): Promise<boolean> {
  if (project.accessType !== 'restricted') return true;

  // Check explicit project membership first (no Slack API call needed)
  const [membership] = await db
    .select({ id: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId)))
    .limit(1);

  if (membership) return true;

  // Check Slack user group membership
  // Handles both legacy string[] and new {id, role}[] format
  const rawGroups = (project.allowedSlackUserGroups as unknown[]) ?? [];
  const groups = rawGroups.filter(Boolean).map(item =>
    typeof item === 'string' ? { id: item } : { id: (item as { id: string }).id },
  );
  if (groups.length === 0) return false;

  try {
    const client = getSlackApp().client;
    for (const group of groups) {
      const result = await client.usergroups.users.list({ usergroup: group.id });
      const members = (result.users as string[] | undefined) ?? [];
      if (members.includes(slackUserId)) return true;
    }
  } catch (err) {
    logger.warn('Could not verify Slack user group membership — ensure the bot has the usergroups:read scope', {
      err,
      slackUserId,
      projectId: project.id,
    });
  }

  return false;
}

/**
 * Extract human-readable content from a Slack message, merging the caption
 * text with any attached file names/links.
 *
 * - `caption`  plain-text only (used for title + keyword routing)
 * - `body`     full content including file lines (used for description/comment)
 */
function extractMessageContent(msg: Record<string, unknown>): { caption: string; body: string } {
  const caption = ((msg.text as string | undefined) ?? '').trim();

  // Modern Slack sends `files` (array); legacy single-file upload uses `file`
  const files: SlackFileRef[] = [
    ...((msg.files as SlackFileRef[] | undefined) ?? []),
    ...((msg.file != null) ? [msg.file as SlackFileRef] : []),
  ];

  const fileLines = files.map(f => {
    const name = f.title || f.name || 'attachment';
    return f.permalink ? `📎 ${name}: ${f.permalink}` : `📎 ${name}`;
  });

  const parts = [...(caption ? [caption] : []), ...fileLines];
  return { caption, body: parts.join('\n') || '(empty message)' };
}

export function registerIntakeHandlers(app: App): void {
  // ── DM message received ────────────────────────────────────────────────────
  // When a user sends a direct message to the bot, route it:
  // - If it references an existing open request thread → add comment
  // - Otherwise → start AI-guided intake to create a new request
  app.message(async ({ message, say }) => {
    // Allow file_share (attachment uploads); block bot messages, edits, deletes, etc.
    if (message.subtype && message.subtype !== 'file_share') return;
    // Legacy file_share events don't include channel_type — guard with 'in' first
    if ('channel_type' in message && message.channel_type !== 'im') return;

    const slackUserId = (message as { user?: string }).user;
    if (!slackUserId) return;

    const [org] = await db.select().from(organizations).limit(1);
    if (!org) return;

    const user = await resolveUserFromSlack(slackUserId, org.id);
    if (!user) {
      await say(
        "👋 Welcome to Enlight! You don't have an account yet. Ask your admin to invite you.",
      );
      return;
    }

    // Check if this message is in a thread tied to an existing request
    const threadTs = (message as { thread_ts?: string }).thread_ts;
    if (threadTs) {
      const [existingReq] = await db
        .select()
        .from(requests)
        .where(eq(requests.slackThreadTs, threadTs))
        .limit(1);

      if (existingReq) {
        // Add the user's message as a comment on the existing request
        const { body: commentBody } = extractMessageContent(message as unknown as Record<string, unknown>);
        await db.insert(comments).values({
          requestId: existingReq.id,
          authorId: user.id,
          body: commentBody,
          isInternal: false,
          aiGenerated: false,
        });

        // Only trigger the AI when a requester (viewer/customer) replies.
        // Agents, admins, and super_admins replying via Slack are acting as
        // human responders — the AI should not jump back in.
        if (user.globalRole === 'viewer' || user.globalRole === 'customer') {
          await agentQueue.add('comment_received', {
            requestId: existingReq.id,
            projectId: existingReq.projectId,
            triggerType: 'comment_received',
            userMessage: commentBody,
            slackUserId,
          });
        }
        return;
      }
    }

    // No existing thread — route to a project and open a request
    const { caption, body: text } = extractMessageContent(message as unknown as Record<string, unknown>);
    const ts = (message as { ts?: string }).ts;

    // All active projects in this org
    const allProjects = await db
      .select({
        id: projects.id,
        name: projects.name,
        categories: projects.categories,
        accessType: projects.accessType,
        allowedSlackUserGroups: projects.allowedSlackUserGroups,
      })
      .from(projects)
      .where(and(eq(projects.orgId, org.id), eq(projects.status, 'active')));

    if (allProjects.length === 0) {
      await say('⚠️ No active projects are configured yet. Ask your admin to create one.');
      return;
    }

    // Explicit project memberships for this user
    const memberships = await db
      .select({
        projectId: projectMembers.projectId,
        projectName: projects.name,
        categories: projects.categories,
        accessType: projects.accessType,
        allowedSlackUserGroups: projects.allowedSlackUserGroups,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(
        and(
          eq(projectMembers.userId, user.id),
          eq(projects.orgId, org.id),
          eq(projects.status, 'active'),
        ),
      );

    // Pool: prefer the user's explicit memberships; fall back to all projects.
    // Then filter down to only projects this user is allowed to access.
    const rawPool: ProjectEntry[] = memberships.length > 0
      ? memberships.map(m => ({
          id: m.projectId,
          name: m.projectName,
          categories: m.categories,
          accessType: m.accessType,
          allowedSlackUserGroups: m.allowedSlackUserGroups,
        }))
      : allProjects;

    const accessResults = await Promise.all(
      rawPool.map(p => canUserAccessProject(slackUserId, user.id, p)),
    );
    const pool: ProjectEntry[] = rawPool.filter((_, i) => accessResults[i]);

    if (pool.length === 0) {
      await say(
        "🔒 You don't have access to any projects. Contact your admin to be added to a project.",
      );
      return;
    }

    let targetProjectId: string | undefined;
    let targetProjectName: string | undefined;

    if (pool.length === 1) {
      targetProjectId = pool[0]!.id;
      targetProjectName = pool[0]!.name;
    } else {
      // Score each project by keyword match against name and categories.
      // Use caption only — don't let file URLs influence routing.
      const msgLower = caption.toLowerCase();
      let bestScore = 0;
      for (const p of pool) {
        let score = 0;
        for (const word of p.name.toLowerCase().split(/\s+/)) {
          if (word.length > 2 && msgLower.includes(word)) score += 2;
        }
        const cats = (p.categories as Array<{ name: string; subcategories: string[] }>) ?? [];
        for (const cat of cats) {
          if (msgLower.includes(cat.name.toLowerCase())) score += 3;
          for (const sub of cat.subcategories) {
            if (sub.length > 2 && msgLower.includes(sub.toLowerCase())) score += 2;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          targetProjectId = p.id;
          targetProjectName = p.name;
        }
      }

      if (!targetProjectId || bestScore === 0) {
        // Ambiguous — ask the user to pick
        await say({
          text: 'Which project is this request for?',
          blocks: [
            {
              type: 'section' as const,
              text: {
                type: 'mrkdwn' as const,
                text: "I'm not sure which project this belongs to. Please select one:",
              },
            },
            {
              type: 'actions' as const,
              elements: pool.slice(0, 5).map(p => ({
                type: 'button' as const,
                text: { type: 'plain_text' as const, text: p.name, emoji: false },
                action_id: `select_project:${p.id}`,
                value: JSON.stringify({ projectId: p.id, text: text.slice(0, 1000), caption: caption.slice(0, 120), originalTs: ts }),
              })),
            },
          ],
        });
        return;
      }
    }

    // Create the request (atomically assigns ticket number)
    const { request: newReq, projectKey } = await createRequest({
      projectId: targetProjectId!,
      title: caption.slice(0, 120) || text.slice(0, 120) || 'Support request via Slack',
      description: text,
      requesterId: user.id,
      ...(ts ? { slackThreadTs: ts } : {}),
      slackUserId,
    });

    const tid = ticketId(projectKey, newReq.ticketNumber);
    await say({
      text: `Got it! I've opened *${tid}* for you. The team will be in touch shortly.`,
      ...(ts ? { thread_ts: ts } : {}),
    });

    await agentQueue.add('triage', {
      requestId: newReq.id,
      projectId: targetProjectId!,
      triggerType: 'triage',
      userMessage: text,
      slackUserId,
      requesterRole: user.globalRole,
    });

    logger.info('New request created via Slack DM', {
      requestId: newReq.id,
      slackUserId,
      projectId: targetProjectId,
      projectName: targetProjectName,
    });
  });

  // ── Project picker selection ────────────────────────────────────────────────
  app.action(/^select_project:/, async ({ ack, body, client, action }) => {
    await ack();

    const slackUserId = body.user.id;
    const { projectId, text, caption, originalTs } = JSON.parse(
      (action as { value: string }).value,
    ) as { projectId: string; text: string; caption?: string; originalTs?: string };

    const [org] = await db.select().from(organizations).limit(1);
    if (!org) return;

    const user = await resolveUserFromSlack(slackUserId, org.id);
    if (!user) return;

    // Delete the picker message so the conversation stays clean
    const channelId = (body as unknown as { channel?: { id: string } }).channel?.id;
    const messageTs = (body as unknown as { message?: { ts: string } }).message?.ts;
    if (channelId && messageTs) {
      await client.chat.delete({ channel: channelId, ts: messageTs }).catch(() => {});
    }

    const { request: newReq, projectKey } = await createRequest({
      projectId,
      title: (caption ?? text).slice(0, 120) || 'Support request via Slack',
      description: text,
      requesterId: user.id,
      slackUserId,
      ...(originalTs ? { slackThreadTs: originalTs } : {}),
    });

    const tid = ticketId(projectKey, newReq.ticketNumber);

    if (channelId) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Got it! I've opened *${tid}* for you. The team will be in touch shortly.`,
        ...(originalTs ? { thread_ts: originalTs } : {}),
      });
    }

    await agentQueue.add('triage', {
      requestId: newReq.id,
      projectId,
      triggerType: 'triage',
      userMessage: text,
      slackUserId,
      requesterRole: user.globalRole,
    });

    logger.info('New request created via Slack DM (project picker)', {
      requestId: newReq.id,
      slackUserId,
      projectId,
    });
  });

  // ── App Home "New Request" button ──────────────────────────────────────────
  app.action('open_new_request_modal', async ({ ack, body, client }) => {
    await ack();

    const slackUserId = body.user.id;
    const [org] = await db.select().from(organizations).limit(1);
    if (!org) return;

    const user = await resolveUserFromSlack(slackUserId, org.id);
    if (!user) return;

    const allActive = await db
      .select({
        id: projects.id,
        name: projects.name,
        categories: projects.categories,
        accessType: projects.accessType,
        allowedSlackUserGroups: projects.allowedSlackUserGroups,
      })
      .from(projects)
      .where(and(eq(projects.orgId, org.id), eq(projects.status, 'active')));

    // Filter to projects the user is allowed to access
    const accessResults = await Promise.all(
      allActive.map(p => canUserAccessProject(slackUserId, user.id, p)),
    );
    const accessibleProjects = allActive
      .filter((_, i) => accessResults[i])
      .map(p => ({ id: p.id, name: p.name }));

    await client.views.open({
      trigger_id: (body as { trigger_id: string }).trigger_id,
      view: newRequestModal(accessibleProjects) as never,
    });
  });

  // ── New request modal submitted ────────────────────────────────────────────
  app.view('new_request_submit', async ({ ack, body, view, client }) => {
    await ack();

    const slackUserId = body.user.id;
    const values = view.state.values;
    const projectId = values['project']?.['project_select']?.selected_option?.value;
    const title = values['title']?.['title_input']?.value;
    const description = values['description']?.['description_input']?.value ?? '';
    const priority =
      (values['priority']?.['priority_select']?.selected_option?.value as
        | 'critical'
        | 'high'
        | 'medium'
        | 'low') ?? 'medium';

    if (!projectId || !title) return;

    const [org] = await db.select().from(organizations).limit(1);
    if (!org) return;

    const user = await resolveUserFromSlack(slackUserId, org.id);
    if (!user) return;

    const { request: newReq, projectKey } = await createRequest({
      projectId,
      title,
      description,
      priority,
      requesterId: user.id,
      slackUserId,
    });

    // DM the user a confirmation
    const tid = ticketId(projectKey, newReq.ticketNumber);
    const dm = await client.conversations.open({ users: slackUserId });
    const channelId = dm.channel?.id;
    if (channelId) {
      const result = await client.chat.postMessage({
        channel: channelId,
        text: `✅ *${tid}* — ${title} — has been submitted.`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ *${tid}* — *${title}* — has been submitted. We'll update you here as it progresses.`,
            },
          },
        ],
      });

      // Save the thread ts for future updates
      if (result.ts) {
        await db
          .update(requests)
          .set({ slackThreadTs: result.ts })
          .where(eq(requests.id, newReq.id));
      }
    }

    await agentQueue.add('triage', {
      requestId: newReq.id,
      projectId,
      triggerType: 'triage',
      slackUserId,
      requesterRole: user.globalRole,
    });
  });

  // ── Slash command: /enlight new ────────────────────────────────────────────
  app.command('/enlight', async ({ command, ack, respond, client }) => {
    await ack();
    const [subcommand, ...args] = command.text.trim().split(/\s+/);

    if (subcommand === 'new') {
      const [org] = await db.select().from(organizations).limit(1);
      if (!org) { await respond('Enlight is not yet configured.'); return; }

      const slackUserId = command.user_id;
      const cmdUser = await resolveUserFromSlack(slackUserId, org.id);
      if (!cmdUser) { await respond("You don't have an Enlight account yet."); return; }

      const allActive = await db
        .select({
          id: projects.id,
          name: projects.name,
          categories: projects.categories,
          accessType: projects.accessType,
          allowedSlackUserGroups: projects.allowedSlackUserGroups,
        })
        .from(projects)
        .where(and(eq(projects.orgId, org.id), eq(projects.status, 'active')));

      const accessResults = await Promise.all(
        allActive.map(p => canUserAccessProject(slackUserId, cmdUser.id, p)),
      );
      const accessibleProjects = allActive
        .filter((_, i) => accessResults[i])
        .map(p => ({ id: p.id, name: p.name }));

      if (accessibleProjects.length === 0) {
        await respond("🔒 You don't have access to any projects. Contact your admin.");
        return;
      }

      await client.views.open({
        trigger_id: command.trigger_id,
        view: newRequestModal(accessibleProjects) as never,
      });
      return;
    }

    if (subcommand === 'status') {
      const reqId = args[0];
      if (!reqId) { await respond('Usage: `/enlight status <request-id>`'); return; }

      const [req] = await db
        .select()
        .from(requests)
        .where(eq(requests.id, reqId))
        .limit(1);

      if (!req) { await respond(`Request \`${reqId}\` not found.`); return; }

      await respond({
        response_type: 'ephemeral',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blocks: requestDetailBlocks(req as any, false) as never,
      });
      return;
    }

    await respond(
      'Available commands: `/enlight new` · `/enlight status <id>` · `/enlight assign <id>`',
    );
  });
}
