import type { App } from '@slack/bolt';
import { db } from '../db/client.js';
import { requests, comments, organizations, users, projects } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { resolveUserFromSlack, notifyRequesterStatusChange } from './userSync.js';
import { requestDetailBlocks, replyModal } from './blocks.js';
import { pushAgentHome } from './appHome.js';
import { logger } from '../lib/logger.js';

/** Re-render the agent's App Home after they take an action on a ticket. */
async function refreshHome(
  slackUserId: string,
  orgUserId: string,
  orgId: string,
  client: App['client'],
): Promise<void> {
  try {
    // Look up global role so quick-action visibility is filtered correctly
    const [u] = await db.select({ globalRole: users.globalRole }).from(users).where(eq(users.id, orgUserId)).limit(1);
    const globalRole = u?.globalRole ?? 'agent';
    await pushAgentHome(slackUserId, orgUserId, orgId, globalRole, client);
  } catch (err) {
    logger.warn('Failed to refresh agent home', { slackUserId, err });
  }
}

export function registerActionHandlers(app: App): void {
  // ── View request details ───────────────────────────────────────────────────
  app.action('view_request', async ({ ack, body, client, action }) => {
    await ack();
    const requestId = (action as { value: string }).value;

    const [org] = await db.select().from(organizations).limit(1);
    const user = org ? await resolveUserFromSlack(body.user.id, org.id) : null;
    const isAgent =
      user?.globalRole === 'super_admin' ||
      user?.globalRole === 'admin' ||
      user?.globalRole === 'agent';

    // Fetch request + project info in one join so we can show the ticket ID
    const [row] = await db
      .select({
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
      })
      .from(requests)
      .leftJoin(projects, eq(projects.id, requests.projectId))
      .where(eq(requests.id, requestId))
      .limit(1);

    if (!row) return;

    // If the request has a Slack thread, fetch its permalink so the modal can
    // show a clickable "Open conversation thread" link (mrkdwn links work in
    // modals; URL buttons do not).
    let threadUrl: string | undefined;
    if (row.slackThreadTs) {
      try {
        // The DM channel is uniquely identified by the Slack user ID for 1:1 bot DMs
        const targetUserId = row.slackUserId ?? body.user.id;
        const dmResult = await client.conversations.open({ users: targetUserId });
        const dmChannelId = (dmResult.channel as { id?: string } | undefined)?.id;
        if (dmChannelId) {
          const permaRes = await client.chat.getPermalink({
            channel: dmChannelId,
            message_ts: row.slackThreadTs,
          });
          if (permaRes.permalink) threadUrl = permaRes.permalink as string;
        }
      } catch { /* non-fatal — modal still opens without the link */ }
    }

    await client.views.open({
      trigger_id: (body as { trigger_id: string }).trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Request Details' },
        close: { type: 'plain_text', text: 'Close' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blocks: requestDetailBlocks(row as any, isAgent, threadUrl),
      } as never,
    });
  });

  // ── Assign to me ───────────────────────────────────────────────────────────
  app.action('assign_to_me', async ({ ack, body, action, client }) => {
    await ack();
    const requestId = (action as { value: string }).value;

    const [org] = await db.select().from(organizations).limit(1);
    if (!org) return;
    const user = await resolveUserFromSlack(body.user.id, org.id);
    if (!user) return;

    const [req] = await db
      .select()
      .from(requests)
      .where(eq(requests.id, requestId))
      .limit(1);
    if (!req) return;

    await db
      .update(requests)
      .set({ assigneeId: user.id, status: 'in_progress', updatedAt: new Date() })
      .where(eq(requests.id, requestId));

    await db.insert(comments).values({
      requestId,
      authorId: user.id,
      body: `Assigned to ${user.name} and marked in progress.`,
      isInternal: true,
      aiGenerated: false,
    });

    logger.info('Ticket assigned via Slack App Home', { requestId, assignee: user.id });

    // Refresh the agent's home to reflect the change
    await refreshHome(body.user.id, user.id, org.id, client);
  });

  // ── Resolve request ────────────────────────────────────────────────────────
  app.action('resolve_request', async ({ ack, body, action, client }) => {
    await ack();
    const requestId = (action as { value: string }).value;

    const [org] = await db.select().from(organizations).limit(1);
    if (!org) return;
    const user = await resolveUserFromSlack(body.user.id, org.id);
    if (!user) return;

    const [req] = await db
      .select()
      .from(requests)
      .where(eq(requests.id, requestId))
      .limit(1);
    if (!req) return;

    await db
      .update(requests)
      .set({ status: 'resolved', resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(requests.id, requestId));

    await db.insert(comments).values({
      requestId,
      authorId: user.id,
      body: `Request resolved by ${user.name}.`,
      isInternal: true,
      aiGenerated: false,
    });

    // Notify requester
    const [requester] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.requesterId))
      .limit(1);

    if (requester?.slackUserId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await notifyRequesterStatusChange(req as any, requester.slackUserId, 'resolved', user.name);
    }

    logger.info('Request resolved via Slack', { requestId, resolvedBy: user.id });

    // Refresh agent home (no modal needed for simple resolve)
    await refreshHome(body.user.id, user.id, org.id, client);
  });

  // ── Escalate request ───────────────────────────────────────────────────────
  app.action('escalate_request', async ({ ack, body, action, client }) => {
    await ack();
    const requestId = (action as { value: string }).value;

    await client.views.open({
      trigger_id: (body as { trigger_id: string }).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'escalate_submit',
        private_metadata: requestId,
        title: { type: 'plain_text', text: 'Escalate Request' },
        submit: { type: 'plain_text', text: 'Escalate' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'reason',
            label: { type: 'plain_text', text: 'Reason for escalation' },
            element: {
              type: 'plain_text_input',
              action_id: 'reason_input',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'Describe why this needs escalation…' },
            },
          },
        ],
      } as never,
    });
  });

  app.view('escalate_submit', async ({ ack, body, view }) => {
    await ack();
    const requestId = view.private_metadata;
    const reason = view.state.values['reason']?.['reason_input']?.value ?? '';

    const [org] = await db.select().from(organizations).limit(1);
    if (!org) return;
    const user = await resolveUserFromSlack(body.user.id, org.id);
    if (!user) return;

    await db
      .update(requests)
      .set({ priority: 'critical', updatedAt: new Date() })
      .where(eq(requests.id, requestId));

    await db.insert(comments).values({
      requestId,
      authorId: user.id,
      body: `**Escalated by ${user.name}:** ${reason}`,
      isInternal: true,
      aiGenerated: false,
    });

    logger.info('Request escalated via Slack', { requestId, by: user.id });
  });

  // ── Reply to request ───────────────────────────────────────────────────────
  app.action('reply_to_request', async ({ ack, body, action, client }) => {
    await ack();
    const requestId = (action as { value: string }).value;

    const [req] = await db
      .select()
      .from(requests)
      .where(eq(requests.id, requestId))
      .limit(1);
    if (!req) return;

    await client.views.open({
      trigger_id: (body as { trigger_id: string }).trigger_id,
      view: replyModal(requestId, req.title) as never,
    });
  });

  app.view('reply_submit', async ({ ack, body, view }) => {
    await ack();
    const requestId = view.private_metadata;
    const messageText = view.state.values['message']?.['message_input']?.value ?? '';
    const isInternal =
      (view.state.values['internal']?.['internal_check']?.selected_options ?? []).some(
        (o: { value: string }) => o.value === 'internal',
      );

    const [org] = await db.select().from(organizations).limit(1);
    if (!org) return;
    const user = await resolveUserFromSlack(body.user.id, org.id);
    if (!user) return;

    const [req] = await db
      .select()
      .from(requests)
      .where(eq(requests.id, requestId))
      .limit(1);
    if (!req) return;

    await db.insert(comments).values({
      requestId,
      authorId: user.id,
      body: messageText,
      isInternal,
      aiGenerated: false,
    });

    // If not internal, notify the requester in their DM thread
    if (!isInternal && req.slackUserId && req.slackUserId !== body.user.id) {
      const { sendThreadedDM: sendThread, sendDM: send } = await import('./userSync.js');
      const replyText = `💬 *${user.name}:* ${messageText}`;
      if (req.slackThreadTs) {
        await sendThread(req.slackUserId, req.slackThreadTs, replyText);
      } else {
        await send(req.slackUserId, replyText);
      }
    }

    logger.info('Reply added via Slack', { requestId, by: user.id, isInternal });
  });
}
