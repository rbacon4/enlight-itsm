import type { KnownBlock } from '@slack/web-api';
import type { Request, RequestStatus, RequestPriority } from '@enlight/shared';
import { ticketId } from '@enlight/shared';

export type ReqWithProject = Request & {
  projectName?: string;
  ticketNumber?: number;
  projectKey?: string;
};

const PRIORITY_EMOJI: Record<RequestPriority, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '⚪',
};

const STATUS_LABEL: Record<RequestStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  pending_user: 'Pending You',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** Returns the formatted ticket ID (e.g. "IT-42") or empty string if unavailable. */
function reqTicketLabel(req: ReqWithProject): string {
  if (req.projectKey && req.ticketNumber != null) {
    return ticketId(req.projectKey, req.ticketNumber);
  }
  return '';
}

/** Truncate description to a short preview for inline display. */
function descSnippet(description: string | null | undefined): string | null {
  if (!description?.trim()) return null;
  const trimmed = description.trim();
  return trimmed.length > 90 ? trimmed.slice(0, 90) + '…' : trimmed;
}

/**
 * Single-row tile for the requester's My Requests list.
 * Shows ticket ID, status/priority chip, and a description excerpt.
 * When `threadUrl` is provided the button deep-links directly to the
 * Slack DM thread; otherwise it opens the details modal.
 */
export function requestSummaryBlock(req: ReqWithProject): KnownBlock[] {
  const priorityEmoji = PRIORITY_EMOJI[req.priority];
  const statusLabel = STATUS_LABEL[req.status];
  const tid = reqTicketLabel(req);
  const snippet = descSnippet(req.description);

  const textLines = [
    tid ? `*${tid}* — ${req.title}` : `*${req.title}*`,
    `${priorityEmoji} ${req.priority.toUpperCase()} · ${statusLabel}`,
    snippet ? `_${snippet}_` : null,
  ].filter(Boolean).join('\n');

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: textLines },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View', emoji: true },
        value: req.id,
        action_id: 'view_request',
      },
    },
  ];
}

/** Single ticket row for the agent queue: project, priority, status, inline actions. */
function agentTicketBlock(req: ReqWithProject, isAssigned: boolean): KnownBlock[] {
  const priorityEmoji = PRIORITY_EMOJI[req.priority];
  const statusLabel = STATUS_LABEL[req.status];
  const tid = reqTicketLabel(req);
  const meta = [
    priorityEmoji + ' ' + req.priority.toUpperCase(),
    statusLabel,
    req.projectName,
  ]
    .filter(Boolean)
    .join(' · ');

  const titleLine = tid ? `*${tid}* — ${req.title}` : `*${req.title}*`;

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${titleLine}\n${meta}` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View', emoji: true },
        value: req.id,
        action_id: 'view_request',
      },
    },
  ];

  if (isAssigned) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '💬 Reply', emoji: true },
          value: req.id,
          action_id: 'reply_to_request',
        },
        ...(req.status !== 'resolved' && req.status !== 'closed'
          ? [
              {
                type: 'button' as const,
                text: { type: 'plain_text' as const, text: '✅ Resolve', emoji: true },
                style: 'primary' as const,
                value: req.id,
                action_id: 'resolve_request',
              },
            ]
          : []),
      ],
    });
  } else {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✋ Assign to me', emoji: true },
          style: 'primary',
          value: req.id,
          action_id: 'assign_to_me',
        },
      ],
    });
  }

  return blocks;
}

/**
 * Detail view blocks used inside a modal.
 * @param threadUrl  Optional permalink to the Slack DM thread — rendered as a
 *                   clickable mrkdwn link since modals don't support URL buttons.
 */
export function requestDetailBlocks(
  req: Request & { projectName?: string; ticketNumber?: number; projectKey?: string },
  isAgent: boolean,
  threadUrl?: string,
): KnownBlock[] {
  const priorityEmoji = PRIORITY_EMOJI[req.priority];
  const statusLabel = STATUS_LABEL[req.status];
  const tid =
    req.projectKey && req.ticketNumber != null
      ? ticketId(req.projectKey, req.ticketNumber)
      : null;

  const titleLine = tid ? `*${tid} — ${req.title}*` : `*${req.title}*`;

  const blocks: KnownBlock[] = [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          titleLine,
          req.projectName ? `_${req.projectName}_` : '',
          '',
          req.description || '_No description_',
        ]
          .filter(s => s !== '')
          .join('\n'),
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status*\n${statusLabel}` },
        { type: 'mrkdwn', text: `*Priority*\n${priorityEmoji} ${req.priority}` },
        {
          type: 'mrkdwn',
          text: `*Created*\n<!date^${Math.floor(new Date(req.createdAt).getTime() / 1000)}^{date_short_pretty}|${new Date(req.createdAt).toLocaleDateString()}>`,
        },
        req.resolvedAt
          ? {
              type: 'mrkdwn',
              text: `*Resolved*\n<!date^${Math.floor(new Date(req.resolvedAt).getTime() / 1000)}^{date_short_pretty}|${new Date(req.resolvedAt).toLocaleDateString()}>`,
            }
          : {
              type: 'mrkdwn',
              text: tid ? `*Ticket*\n${tid}` : `*Ref*\n#${req.id.slice(0, 8)}`,
            },
      ],
    },
  ];

  // Thread link (mrkdwn works in modals; url buttons do not)
  if (threadUrl) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${threadUrl}|💬 Open conversation thread>` },
    });
  }

  if (isAgent && req.status !== 'resolved' && req.status !== 'closed') {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Resolve', emoji: true },
          style: 'primary',
          value: req.id,
          action_id: 'resolve_request',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔺 Escalate', emoji: true },
          style: 'danger',
          value: req.id,
          action_id: 'escalate_request',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '💬 Reply', emoji: true },
          value: req.id,
          action_id: 'reply_to_request',
        },
      ],
    });
  }

  return blocks;
}

export function appHomeBlocks(
  myRequests: ReqWithProject[],
  recentResolved: ReqWithProject[],
  isAgent: boolean,
  unassignedRequests?: ReqWithProject[],
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔦 Enlight Support', emoji: true },
    },
  ];

  if (isAgent) {
    // ── Agent / Admin view ─────────────────────────────────────────────────────
    const unassigned = unassignedRequests ?? [];
    const totalOpen = myRequests.length + unassigned.length;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: totalOpen > 0
          ? `*${myRequests.length}* assigned to you · *${unassigned.length}* unassigned`
          : '_Queue is clear_ ✨',
      },
    });

    // ── My assigned tickets ────────────────────────────────────────────────────
    if (myRequests.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*My Queue (${myRequests.length})*` },
      });
      for (const req of myRequests.slice(0, 10)) {
        blocks.push(...agentTicketBlock(req, true));
      }
      if (myRequests.length > 10) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_…and ${myRequests.length - 10} more_` }],
        });
      }
    } else {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_No tickets assigned to you._' },
      });
    }

    // ── Unassigned tickets ─────────────────────────────────────────────────────
    if (unassigned.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Unassigned (${unassigned.length})*` },
      });
      for (const req of unassigned.slice(0, 8)) {
        blocks.push(...agentTicketBlock(req, false));
      }
      if (unassigned.length > 8) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_…and ${unassigned.length - 8} more_` }],
        });
      }
    }

    // ── Recently resolved ──────────────────────────────────────────────────────
    if (recentResolved.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Recently Resolved (${recentResolved.length})*` },
      });
      for (const req of recentResolved.slice(0, 5)) {
        blocks.push(...requestSummaryBlock(req));
      }
    }
  } else {
    // ── End-user (requester) view ──────────────────────────────────────────────
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Your support requests. Message me anytime to open a new one.',
      },
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '+ New Request', emoji: true },
          style: 'primary',
          action_id: 'open_new_request_modal',
        },
      ],
    });

    if (myRequests.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Open (${myRequests.length})*` },
      });
      for (const req of myRequests.slice(0, 10)) {
        blocks.push(...requestSummaryBlock(req));
      }
    } else {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '_No open requests. Message me to get help._',
        },
      });
    }

    if (recentResolved.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Recently Resolved (${recentResolved.length})*` },
      });
      for (const req of recentResolved.slice(0, 5)) {
        blocks.push(...requestSummaryBlock(req));
      }
    }
  }

  return blocks;
}

export function newRequestModal(projects: Array<{ id: string; name: string }>): object {
  return {
    type: 'modal',
    callback_id: 'new_request_submit',
    title: { type: 'plain_text', text: 'New Support Request' },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'project',
        label: { type: 'plain_text', text: 'Project' },
        element: {
          type: 'static_select',
          action_id: 'project_select',
          placeholder: { type: 'plain_text', text: 'Select a project…' },
          options: projects.map((p) => ({
            text: { type: 'plain_text', text: p.name },
            value: p.id,
          })),
        },
      },
      {
        type: 'input',
        block_id: 'title',
        label: { type: 'plain_text', text: 'Summary' },
        element: {
          type: 'plain_text_input',
          action_id: 'title_input',
          placeholder: { type: 'plain_text', text: 'Briefly describe the issue…' },
          max_length: 500,
        },
      },
      {
        type: 'input',
        block_id: 'description',
        optional: true,
        label: { type: 'plain_text', text: 'Details' },
        element: {
          type: 'plain_text_input',
          action_id: 'description_input',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Any additional context, steps to reproduce, etc.' },
        },
      },
      {
        type: 'input',
        block_id: 'priority',
        label: { type: 'plain_text', text: 'Priority' },
        element: {
          type: 'static_select',
          action_id: 'priority_select',
          initial_option: { text: { type: 'plain_text', text: '🟡 Medium' }, value: 'medium' },
          options: [
            { text: { type: 'plain_text', text: '🔴 Critical' }, value: 'critical' },
            { text: { type: 'plain_text', text: '🟠 High' }, value: 'high' },
            { text: { type: 'plain_text', text: '🟡 Medium' }, value: 'medium' },
            { text: { type: 'plain_text', text: '⚪ Low' }, value: 'low' },
          ],
        },
      },
    ],
  };
}

export function replyModal(requestId: string, requestTitle: string): object {
  return {
    type: 'modal',
    callback_id: 'reply_submit',
    private_metadata: requestId,
    title: { type: 'plain_text', text: 'Reply to Request' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `Replying to: *${requestTitle}*` },
      },
      {
        type: 'input',
        block_id: 'message',
        label: { type: 'plain_text', text: 'Message' },
        element: {
          type: 'plain_text_input',
          action_id: 'message_input',
          multiline: true,
        },
      },
      {
        type: 'input',
        block_id: 'internal',
        optional: true,
        label: { type: 'plain_text', text: 'Note type' },
        element: {
          type: 'checkboxes',
          action_id: 'internal_check',
          options: [
            {
              text: { type: 'plain_text', text: 'Internal note (only agents can see)' },
              value: 'internal',
            },
          ],
        },
      },
    ],
  };
}
