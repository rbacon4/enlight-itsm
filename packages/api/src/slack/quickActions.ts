/**
 * Handles quick-action button clicks and modal submissions for the Slack App Home.
 *
 * Quick actions are project-level configurable buttons that bypass the AI intake
 * and go straight to a structured form modal.
 */
import type { App } from '@slack/bolt';
import { db } from '../db/client.js';
import { projects, organizations, requests } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { resolveUserFromSlack } from './userSync.js';
import { createRequest } from '../lib/createRequest.js';
import { agentQueue } from '../queues/index.js';
import { ticketId } from '@enlight/shared';
import type { SlackQuickAction, SlackQuickActionField } from '@enlight/shared';
import { makeSlackClient } from './client.js';
import { logger } from '../lib/logger.js';

// ── Block Kit helpers ─────────────────────────────────────────────────────────

function fieldToBlock(field: SlackQuickActionField) {
  const base = {
    type: 'input' as const,
    block_id: `qa_field_${field.id}`,
    label: { type: 'plain_text' as const, text: field.label },
    optional: !field.required,
  };

  switch (field.type) {
    case 'textarea':
      return {
        ...base,
        element: {
          type: 'plain_text_input' as const,
          action_id: `field_${field.id}`,
          multiline: true,
          placeholder: field.placeholder
            ? { type: 'plain_text' as const, text: field.placeholder }
            : undefined,
        },
      };
    case 'select':
      return {
        ...base,
        element: {
          type: 'static_select' as const,
          action_id: `field_${field.id}`,
          placeholder: { type: 'plain_text' as const, text: field.placeholder ?? 'Select…' },
          options: (field.options ?? []).map((opt) => ({
            text: { type: 'plain_text' as const, text: opt },
            value: opt,
          })),
        },
      };
    case 'date':
      return {
        ...base,
        element: {
          type: 'datepicker' as const,
          action_id: `field_${field.id}`,
          placeholder: { type: 'plain_text' as const, text: field.placeholder ?? 'Pick a date…' },
        },
      };
    case 'text':
    default:
      return {
        ...base,
        element: {
          type: 'plain_text_input' as const,
          action_id: `field_${field.id}`,
          placeholder: field.placeholder
            ? { type: 'plain_text' as const, text: field.placeholder }
            : undefined,
        },
      };
  }
}

// ── Register handlers ─────────────────────────────────────────────────────────

export function registerQuickActionHandlers(app: App): void {
  // Button click: open the quick-action modal
  // action_id = "quick_action:{projectId}:{actionId}"
  app.action(/^quick_action:/, async ({ ack, body, client, action }) => {
    await ack();

    const [, projectId, actionId] = (action as { action_id: string }).action_id.split(':');
    if (!projectId || !actionId) return;

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) return;

    const actions = project.slackQuickActions as SlackQuickAction[];
    const qa = actions.find((a) => a.id === actionId);
    if (!qa) return;

    await client.views.open({
      trigger_id: (body as { trigger_id: string }).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'quick_action_submit',
        private_metadata: JSON.stringify({ projectId, actionId }),
        title: { type: 'plain_text', text: qa.label.slice(0, 24) },
        submit: { type: 'plain_text', text: 'Submit' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: qa.description || `Fill in the details below.` },
          },
          ...qa.fields.map(fieldToBlock),
        ],
      } as never,
    });
  });

  // Modal submission: create the request
  app.view('quick_action_submit', async ({ ack, body, view }) => {
    await ack();

    const { projectId, actionId } = JSON.parse(view.private_metadata) as { projectId: string; actionId: string };
    const slackUserId = body.user.id;

    const [org] = await db.select().from(organizations).limit(1);
    if (!org) return;

    const user = await resolveUserFromSlack(slackUserId, org.id);
    if (!user) return;

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) return;

    const actions = project.slackQuickActions as SlackQuickAction[];
    const qa = actions.find((a) => a.id === actionId);
    if (!qa) return;

    // Build description from submitted field values
    const lines: string[] = [];
    const values = view.state.values;
    for (const field of qa.fields) {
      const blockId = `qa_field_${field.id}`;
      const actionId = `field_${field.id}`;
      const blockVal = values[blockId]?.[actionId];
      let value: string | undefined;

      if (blockVal?.type === 'static_select') {
        value = blockVal.selected_option?.value;
      } else if (blockVal?.type === 'datepicker') {
        value = blockVal.selected_date ?? undefined;
      } else {
        value = blockVal?.value ?? undefined;
      }

      if (value) lines.push(`**${field.label}:** ${value}`);
    }

    const description = lines.join('\n');
    const title = `${qa.emoji} ${qa.label}`;

    try {
      const { request, projectKey } = await createRequest({
        projectId,
        requesterId: user.id,
        title,
        description,
        priority: qa.priority,
        slackUserId,
      });

      // Confirm via DM
      const tid = ticketId(projectKey, request.ticketNumber);
      const slack = makeSlackClient();
      if (slack) {
        const dm = await slack.conversations.open({ users: slackUserId });
        const channelId = dm.channel?.id;
        if (channelId) {
          const result = await slack.chat.postMessage({
            channel: channelId,
            text: `✅ *${tid}* — *${title}* — submitted. We'll update you here.`,
          });
          if (result.ts) {
            await db.update(requests)
              .set({ slackThreadTs: result.ts as string })
              .where(eq(requests.id, request.id));
          }
        }
      }

      // Queue AI triage
      await agentQueue.add('triage', {
        requestId: request.id,
        projectId,
        triggerType: 'triage',
        slackUserId,
      });

      logger.info('Quick action request created', { requestId: request.id, action: qa.label });
    } catch (err) {
      logger.error('Failed to create quick action request', { err });
    }
  });
}
