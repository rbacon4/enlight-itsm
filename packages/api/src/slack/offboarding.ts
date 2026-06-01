/**
 * Slack App Home offboarding flow.
 *
 * Ported from the standalone Python app's App Home button + confirmation modal
 * (iterations 1.1 / 2.1 / 2.2). The slash command is intentionally NOT ported —
 * offboarding is triggered only from the App Home "Start Offboarding" button.
 */
import type { App } from '@slack/bolt';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { resolveUserFromSlack } from './userSync.js';
import { decryptOrgSettings } from '../lib/secretCrypto.js';
import { resolveGlobalPermissions } from '../lib/permissions.js';
import { makeGoogleWorkspaceService, resolveOffboardingConfig } from '../lib/googleWorkspace.js';
import { createOffboardingEvent, validateOffboardingInput } from '../lib/offboarding.js';
import { offboardingQueue } from '../queues/index.js';
import { makeSlackClient } from './client.js';
import { logger } from '../lib/logger.js';
import type { OrganizationSettings, OffboardingProfileLookup } from '@enlight/shared';

const TARGET_BLOCK = 'offboard_target_block';
const TARGET_ACTION = 'offboard_target_lookup';
const DELEGATE_BLOCK = 'offboard_delegate_block';
const DELEGATE_ACTION = 'offboard_delegate_input';
const ARCHIVE_BLOCK = 'offboard_archive_block';
const ARCHIVE_ACTION = 'offboard_archive_check';

interface ModalState {
  orgId: string;
  archiveOuPath?: string;
  departedOuPath: string;
}

/** Build (or rebuild) the offboarding modal view, optionally with a profile card. */
function buildModalView(
  state: ModalState,
  opts: { targetEmail?: string; delegateEmail?: string; profile?: OffboardingProfileLookup } = {},
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: 'input',
      block_id: TARGET_BLOCK,
      dispatch_action: true,
      label: { type: 'plain_text', text: 'Departing employee email' },
      element: {
        type: 'plain_text_input',
        action_id: TARGET_ACTION,
        dispatch_action_config: { trigger_actions_on: ['on_enter_pressed'] },
        initial_value: opts.targetEmail || undefined,
        placeholder: { type: 'plain_text', text: 'jane.doe@company.com' },
      },
    },
  ];

  if (opts.profile) {
    if (opts.profile.found) {
      const p = opts.profile;
      const fields = [
        p.name ? `*Name:* ${p.name}` : null,
        p.jobTitle ? `*Title:* ${p.jobTitle}` : null,
        p.department ? `*Department:* ${p.department}` : null,
        p.employeeId ? `*Employee ID:* ${p.employeeId}` : null,
        p.managerEmail ? `*Manager:* ${p.managerEmail}` : null,
        p.suspended ? `:information_source: *Already suspended*` : null,
      ].filter(Boolean) as string[];
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `:bust_in_silhouette: ${fields.join('\n')}` },
      });
      if (p.managerEmail) {
        blocks.push({
          type: 'actions',
          block_id: 'offboard_transfer_block',
          elements: [
            {
              type: 'button',
              action_id: 'offboard_transfer_to_manager',
              text: { type: 'plain_text', text: '↪ Transfer Drive to manager' },
              value: p.managerEmail,
            },
          ],
        });
      }
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:x: \`${opts.profile.email}\` was not found in Google Workspace${opts.profile.error ? ` (${opts.profile.error})` : ''}.`,
        },
      });
    }
  }

  blocks.push({
    type: 'input',
    block_id: DELEGATE_BLOCK,
    optional: true,
    label: { type: 'plain_text', text: 'Transfer Drive files to (delegate email)' },
    element: {
      type: 'plain_text_input',
      action_id: DELEGATE_ACTION,
      initial_value: opts.delegateEmail || undefined,
      placeholder: { type: 'plain_text', text: 'manager@company.com (optional)' },
    },
  });

  if (state.archiveOuPath) {
    blocks.push({
      type: 'input',
      block_id: ARCHIVE_BLOCK,
      optional: true,
      label: { type: 'plain_text', text: 'Destination' },
      element: {
        type: 'checkboxes',
        action_id: ARCHIVE_ACTION,
        options: [
          {
            text: { type: 'plain_text', text: `Archive instead of Departed (${state.archiveOuPath})` },
            value: 'archive',
          },
        ],
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Account will be suspended and moved to \`${state.departedOuPath}\`. Actions are reversible by a Workspace super admin.`,
      },
    ],
  });

  return {
    type: 'modal' as const,
    callback_id: 'offboarding_submit',
    private_metadata: JSON.stringify(state),
    title: { type: 'plain_text' as const, text: 'Offboard Employee' },
    submit: { type: 'plain_text' as const, text: 'Offboard' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks,
  };
}

/** Read the currently-entered target/delegate from a view's state. */
function readViewState(view: { state: { values: Record<string, Record<string, { value?: string | null; selected_options?: unknown[] }>> } }) {
  const v = view.state.values;
  const targetEmail = v[TARGET_BLOCK]?.[TARGET_ACTION]?.value ?? '';
  const delegateEmail = v[DELEGATE_BLOCK]?.[DELEGATE_ACTION]?.value ?? '';
  const archive = (v[ARCHIVE_BLOCK]?.[ARCHIVE_ACTION]?.selected_options?.length ?? 0) > 0;
  return { targetEmail: targetEmail.trim(), delegateEmail: delegateEmail.trim(), archive };
}

async function loadOrgSettings(orgId: string): Promise<OrganizationSettings> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return decryptOrgSettings((org?.settings ?? {}) as OrganizationSettings);
}

export function registerOffboardingHandlers(app: App): void {
  // Open the modal from the App Home button
  app.action('start_offboarding', async ({ ack, body, client }) => {
    await ack();
    const slackUserId = body.user.id;
    const [org] = await db.select().from(organizations).limit(1);
    if (!org) return;

    const user = await resolveUserFromSlack(slackUserId, org.id);
    if (!user) return;
    const perms = await resolveGlobalPermissions({ roleId: user.roleId, globalRole: user.globalRole });
    if (!perms.includes('offboarding.run')) return; // silently ignore unauthorized clicks

    const settings = await loadOrgSettings(org.id);
    if (!settings.offboarding?.enabled) return;
    const cfg = resolveOffboardingConfig(settings);

    const modalState: ModalState = {
      orgId: org.id,
      departedOuPath: cfg.departedOuPath,
      ...(cfg.archiveOuPath ? { archiveOuPath: cfg.archiveOuPath } : {}),
    };
    await client.views.open({
      trigger_id: (body as { trigger_id: string }).trigger_id,
      view: buildModalView(modalState) as never,
    });
  });

  // Live profile lookup when the submitter presses Enter in the target field
  app.action(TARGET_ACTION, async ({ ack, body, client }) => {
    await ack();
    const view = (body as { view?: { id: string; private_metadata: string; state: never } }).view;
    if (!view) return;
    const state = JSON.parse(view.private_metadata) as ModalState;
    const { targetEmail, delegateEmail } = readViewState(view as never);
    if (!targetEmail) return;

    const settings = await loadOrgSettings(state.orgId);
    const gws = makeGoogleWorkspaceService(settings);
    const profile = await gws.lookupProfile(targetEmail);

    await client.views.update({
      view_id: view.id,
      view: buildModalView(state, { targetEmail, delegateEmail, profile }) as never,
    });
  });

  // "Transfer Drive to manager" → populate the delegate field
  app.action('offboard_transfer_to_manager', async ({ ack, body, client, action }) => {
    await ack();
    const view = (body as { view?: { id: string; private_metadata: string; state: never } }).view;
    if (!view) return;
    const state = JSON.parse(view.private_metadata) as ModalState;
    const managerEmail = (action as { value?: string }).value ?? '';
    const { targetEmail } = readViewState(view as never);

    const settings = await loadOrgSettings(state.orgId);
    const gws = makeGoogleWorkspaceService(settings);
    const profile = targetEmail ? await gws.lookupProfile(targetEmail) : undefined;

    await client.views.update({
      view_id: view.id,
      view: buildModalView(state, {
        targetEmail,
        delegateEmail: managerEmail,
        ...(profile ? { profile } : {}),
      }) as never,
    });
  });

  // Submission → create the event and enqueue the workflow
  app.view('offboarding_submit', async ({ ack, body, view }) => {
    const state = JSON.parse(view.private_metadata) as ModalState;
    const { targetEmail, delegateEmail, archive } = readViewState(view as never);

    const validationError = validateOffboardingInput(targetEmail, delegateEmail || null);
    if (validationError) {
      await ack({ response_action: 'errors', errors: { [TARGET_BLOCK]: validationError } } as never);
      return;
    }
    await ack();

    const slackUserId = body.user.id;
    const user = await resolveUserFromSlack(slackUserId, state.orgId);
    if (!user) return;
    const perms = await resolveGlobalPermissions({ roleId: user.roleId, globalRole: user.globalRole });
    if (!perms.includes('offboarding.run')) return;

    try {
      const event = await createOffboardingEvent({
        orgId: state.orgId,
        targetEmail,
        delegateEmail: delegateEmail || null,
        archive,
        triggeredById: user.id,
        triggeredVia: 'slack',
      });
      await offboardingQueue.add(
        'run',
        { eventId: event.id },
        { attempts: 2, backoff: { type: 'exponential', delay: 3000 } },
      );

      // Running notice to the audit channel (completion is posted by the worker)
      const settings = await loadOrgSettings(state.orgId);
      const channel = settings.offboarding?.auditChannel;
      const slack = makeSlackClient(settings);
      if (channel && slack) {
        await slack.chat.postMessage({
          channel,
          text: `:hourglass_flowing_sand: Offboarding started for \`${targetEmail}\` by <@${slackUserId}>…`,
        });
      }
      logger.info('Offboarding triggered from Slack', { eventId: event.id, targetEmail });
    } catch (err) {
      logger.error('Failed to start offboarding from Slack', { err });
    }
  });
}
