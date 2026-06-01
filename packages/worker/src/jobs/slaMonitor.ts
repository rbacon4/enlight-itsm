/**
 * SLA Monitor — runs on a repeating schedule (every 5 minutes by default).
 *
 * For every active project that has SLA policies AND at least one alert
 * channel configured, scans open/in-progress requests and fires a one-time
 * alert when either SLA window is breached:
 *
 *   • response_breached   — ticket is still 'open' (no agent pick-up) past the
 *                           response-time deadline for its priority.
 *   • resolution_breached — ticket is not resolved/closed past the resolution-
 *                           time deadline for its priority.
 *
 * A row is inserted into `sla_alerts` (unique on request_id + alert_type)
 * before delivering notifications, so even if delivery partially fails the
 * alert is only attempted once per breach.
 *
 * Business hours: if the project has `supportHours` configured, elapsed time
 * counts only minutes that fall within the enabled windows.  null = 24/7.
 */

import type { Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../api/src/db/client.js';
import {
  organizations,
  projects,
  requests,
  users,
  slaAlerts,
  auditLogs,
} from '../../../api/src/db/schema.js';
import { makeSlackClient } from '../../../api/src/slack/client.js';
import { decryptOrgSettings } from '../../../api/src/lib/secretCrypto.js';
import { sendEmail, isEmailConfigured } from '../../../api/src/lib/emailSender.js';
import type {
  SlaPolicy,
  SlaAlertConfig,
  SupportHours,
  SupportHoursDay,
  OrganizationSettings,
  Weekday,
  EmailSenderConfig,
} from '@enlight/shared';
import type { KnownBlock, Block } from '@slack/web-api';
import { logger } from '../lib/logger.js';

const ACTIVE_STATUSES = ['open', 'in_progress', 'pending_user'] as const;

// ── Entry point ────────────────────────────────────────────────────────────────

export async function handleSlaMonitorJob(_job: Job): Promise<void> {
  logger.info('SLA monitor scan starting');

  const allOrgs = await db
    .select({
      id: organizations.id,
      settings: organizations.settings,
      emailSenderConfig: organizations.emailSenderConfig,
    })
    .from(organizations);

  let breachesFound = 0;

  for (const org of allOrgs) {
    try {
      breachesFound += await scanOrg(org);
    } catch (err) {
      logger.error('SLA monitor: error scanning org', { orgId: org.id, err });
    }
  }

  logger.info('SLA monitor scan complete', { breachesFound });
}

// ── Per-org scan ───────────────────────────────────────────────────────────────

async function scanOrg(org: {
  id: string;
  settings: unknown;
  emailSenderConfig: unknown;
}): Promise<number> {
  let orgSettings: OrganizationSettings;
  try {
    orgSettings = decryptOrgSettings((org.settings ?? {}) as OrganizationSettings);
  } catch {
    // Settings encrypted under a different key (e.g. key rotation) — proceed
    // without decrypted secrets.  SLA policies are plain JSON so breach detection
    // still works; Slack/email fallback to env vars.
    logger.warn('SLA: could not decrypt org settings, using defaults', { orgId: org.id });
    orgSettings = {} as OrganizationSettings;
  }
  const slack = makeSlackClient(orgSettings);
  const emailCfg = (org.emailSenderConfig ?? null) as EmailSenderConfig | null;
  const webUrl = process.env['WEB_URL'] ?? 'http://localhost:3000';

  const orgProjects = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, org.id), eq(projects.status, 'active')));

  let breaches = 0;

  for (const project of orgProjects) {
    const slaPolicies = (project.slaPolicies ?? []) as SlaPolicy[];
    const alertCfg = (project.slaAlertConfig ?? { channels: [] }) as SlaAlertConfig;
    const supportHours = project.supportHours as SupportHours | null;

    if (slaPolicies.length === 0 || alertCfg.channels.length === 0) continue;

    const openReqs = await db
      .select({
        id: requests.id,
        ticketNumber: requests.ticketNumber,
        title: requests.title,
        priority: requests.priority,
        status: requests.status,
        createdAt: requests.createdAt,
        assigneeId: requests.assigneeId,
      })
      .from(requests)
      .where(
        and(
          eq(requests.projectId, project.id),
          inArray(requests.status, [...ACTIVE_STATUSES]),
        ),
      );

    const now = new Date();

    for (const req of openReqs) {
      const policy = slaPolicies.find((p) => p.priority === req.priority);
      if (!policy) continue;

      const ageMinutes = elapsedBusinessMinutes(req.createdAt, now, supportHours);

      // Response SLA: 'open' = not yet picked up by any agent.
      if (req.status === 'open' && ageMinutes > policy.responseTimeMinutes) {
        if (await recordAlertIfNew(req.id, 'response_breached')) {
          try {
            await deliverAlerts({
              req, project, orgId: org.id, alertType: 'response_breached',
              policy, ageMinutes, alertCfg, slack, emailCfg, webUrl,
            });
          } catch (err) {
            logger.error('SLA: deliverAlerts failed', { reqId: req.id, alertType: 'response_breached', err });
          }
          breaches++;
        }
      }

      // Resolution SLA.
      if (ageMinutes > policy.resolutionTimeMinutes) {
        if (await recordAlertIfNew(req.id, 'resolution_breached')) {
          try {
            await deliverAlerts({
              req, project, orgId: org.id, alertType: 'resolution_breached',
              policy, ageMinutes, alertCfg, slack, emailCfg, webUrl,
            });
          } catch (err) {
            logger.error('SLA: deliverAlerts failed', { reqId: req.id, alertType: 'resolution_breached', err });
          }
          breaches++;
        }
      }
    }
  }

  return breaches;
}

// ── De-duplication ─────────────────────────────────────────────────────────────

/**
 * Inserts an sla_alerts row (unique on request_id + alert_type).
 * Returns true if freshly inserted (alert should fire), false if already sent.
 */
async function recordAlertIfNew(
  requestId: string,
  alertType: 'response_breached' | 'resolution_breached',
): Promise<boolean> {
  try {
    // RETURNING returns the inserted row; on conflict (duplicate) it returns [].
    const inserted = await db
      .insert(slaAlerts)
      .values({ requestId, alertType })
      .onConflictDoNothing()
      .returning({ id: slaAlerts.id });
    return inserted.length > 0;
  } catch (err) {
    logger.warn('SLA dedup insert failed', { requestId, alertType, err });
    return false;
  }
}

// ── Alert delivery ─────────────────────────────────────────────────────────────

interface DeliverOpts {
  req: {
    id: string;
    ticketNumber: number;
    title: string;
    priority: string;
    status: string;
    assigneeId: string | null;
  };
  project: { id: string; name: string; key: string };
  orgId: string;
  alertType: 'response_breached' | 'resolution_breached';
  policy: SlaPolicy;
  ageMinutes: number;
  alertCfg: SlaAlertConfig;
  slack: ReturnType<typeof makeSlackClient>;
  emailCfg: EmailSenderConfig | null;
  webUrl: string;
}

async function deliverAlerts(opts: DeliverOpts): Promise<void> {
  const { req, project, orgId, alertType, policy, ageMinutes, alertCfg, slack, emailCfg, webUrl } = opts;

  const limit = alertType === 'response_breached'
    ? policy.responseTimeMinutes
    : policy.resolutionTimeMinutes;

  const overdue = Math.round(ageMinutes - limit);
  const label = alertType === 'response_breached' ? 'Response' : 'Resolution';
  const ticketUrl = `${webUrl}/projects/${project.id}/requests/${req.id}`;

  // Resolve assignee once.
  let assignee: { name: string; email: string; slackUserId: string | null } | null = null;
  if (req.assigneeId) {
    const [u] = await db
      .select({ name: users.name, email: users.email, slackUserId: users.slackUserId })
      .from(users)
      .where(eq(users.id, req.assigneeId))
      .limit(1);
    assignee = u ?? null;
  }

  const overdueText = formatDuration(overdue);
  const slackFallback = [
    `🚨 SLA ${label} Breach — ${overdueText} overdue`,
    `*${project.key}-${req.ticketNumber}:* ${req.title}`,
    `Priority: ${req.priority} | SLA: ${formatDuration(limit)} | Assignee: ${assignee?.name ?? 'Unassigned'}`,
    ticketUrl,
  ].join('\n');

  const slackBlocks = buildSlackBlocks({ label, req, project, limit, overdueText, ticketUrl, assignee });

  for (const channelType of alertCfg.channels) {
    try {
      if (channelType === 'slack_channel') {
        if (!slack) { logger.warn('SLA: Slack not configured — skipping slack_channel alert'); continue; }
        if (!alertCfg.slackChannelId) { logger.warn('SLA: slackChannelId not set — skipping'); continue; }
        await slack.chat.postMessage({ channel: alertCfg.slackChannelId, text: slackFallback, blocks: slackBlocks });

      } else if (channelType === 'slack_dm') {
        if (!slack) { logger.warn('SLA: Slack not configured — skipping slack_dm alert'); continue; }
        const slackUserId = assignee?.slackUserId;
        if (!slackUserId) { logger.warn('SLA: assignee has no Slack user ID — skipping DM', { reqId: req.id }); continue; }
        await slack.chat.postMessage({ channel: slackUserId, text: slackFallback, blocks: slackBlocks });

      } else if (channelType === 'email') {
        if (!isEmailConfigured(emailCfg)) { logger.warn('SLA: email not configured — skipping email alert'); continue; }
        if (!assignee?.email) { logger.warn('SLA: assignee has no email — skipping', { reqId: req.id }); continue; }
        await sendEmail({
          to: assignee.email,
          subject: `[Enlight] SLA ${label} Breach — ${project.key}-${req.ticketNumber}: ${req.title}`,
          html: buildEmailHtml({ label, req, project, limit, overdueText, ticketUrl, assignee }),
          orgEmailConfig: emailCfg,
        });
      }
    } catch (err) {
      logger.error('SLA alert delivery failed', { channelType, reqId: req.id, alertType, err });
    }
  }

  // Audit log.
  try {
    await db.insert(auditLogs).values({
      orgId,
      actorId: null,
      action: `sla.${alertType}`,
      entityType: 'request',
      entityId: req.id,
      diff: { priority: req.priority, ageMinutes: Math.round(ageMinutes), limitMinutes: limit },
    });
  } catch (err) {
    logger.warn('SLA: audit log write failed', { err });
  }

  logger.info('SLA breach alert fired', {
    reqId: req.id,
    ticket: `${project.key}-${req.ticketNumber}`,
    alertType,
    priority: req.priority,
    overdueMinutes: overdue,
  });
}

// ── Slack Block Kit ───────────────────────────────────────────────────────────

function buildSlackBlocks(opts: {
  label: string;
  req: { ticketNumber: number; title: string; priority: string; status: string };
  project: { key: string; name: string };
  limit: number;
  overdueText: string;
  ticketUrl: string;
  assignee: { name: string } | null;
}): (KnownBlock | Block)[] {
  const { label, req, project, limit, overdueText, ticketUrl, assignee } = opts;
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🚨 SLA ${label} Breach`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<${ticketUrl}|${project.key}-${req.ticketNumber}: ${req.title}>`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Priority:*\n${req.priority}` },
        { type: 'mrkdwn', text: `*Status:*\n${req.status.replace('_', ' ')}` },
        { type: 'mrkdwn', text: `*SLA limit:*\n${formatDuration(limit)}` },
        { type: 'mrkdwn', text: `*Overdue by:*\n${overdueText}` },
        { type: 'mrkdwn', text: `*Assignee:*\n${assignee?.name ?? 'Unassigned'}` },
        { type: 'mrkdwn', text: `*Project:*\n${project.name}` },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Ticket', emoji: true },
          url: ticketUrl,
          style: 'danger',
        },
      ],
    },
  ];
}

// ── Email HTML ────────────────────────────────────────────────────────────────

function buildEmailHtml(opts: {
  label: string;
  req: { ticketNumber: number; title: string; priority: string; status: string };
  project: { key: string; name: string };
  limit: number;
  overdueText: string;
  ticketUrl: string;
  assignee: { name: string; email: string } | null;
}): string {
  const { label, req, project, limit, overdueText, ticketUrl, assignee } = opts;
  const tdLabel = `style="padding:6px 16px 6px 0;color:#6b7280;white-space:nowrap;font-size:14px"`;
  const tdValue = `style="padding:6px 0;font-size:14px"`;
  const rows = [
    ['Project',   project.name],
    ['Priority',  req.priority],
    ['Status',    req.status.replace('_', ' ')],
    ['SLA limit', formatDuration(limit)],
    ['Overdue by', `<strong style="color:#dc2626">${overdueText}</strong>`],
    ['Assignee',  assignee?.name ?? 'Unassigned'],
  ]
    .map(([k, v]) => `<tr><td ${tdLabel}>${k}</td><td ${tdValue}>${v}</td></tr>`)
    .join('');

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#111;max-width:600px;margin:auto;padding:24px">
<h2 style="color:#dc2626;margin-top:0">🚨 SLA ${label} Breach</h2>
<p style="font-size:15px">
  <a href="${ticketUrl}" style="color:#2563eb">${project.key}-${req.ticketNumber}: ${req.title}</a>
</p>
<table style="border-collapse:collapse;width:100%">${rows}</table>
<p style="margin-top:24px">
  <a href="${ticketUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:14px">
    View Ticket →
  </a>
</p>
<p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:16px">
  Sent by Enlight ITSM · <a href="${ticketUrl}" style="color:#9ca3af">Manage alerts in project settings</a>
</p>
</body></html>`;
}

// ── Business-hours elapsed-time calculation ────────────────────────────────────

/**
 * Returns the elapsed minutes between `since` and `now` that fall within the
 * project's configured support windows.
 *
 * Iterates day-by-day (O(days)) using Intl.DateTimeFormat to find each day's
 * business window in UTC, then computes the intersection with [since, now].
 */
function elapsedBusinessMinutes(
  since: Date,
  now: Date,
  supportHours: SupportHours | null,
): number {
  if (!supportHours) return (now.getTime() - since.getTime()) / 60_000;
  if (since >= now) return 0;

  const tz = supportHours.timezone;
  const dayMap = new Map<Weekday, SupportHoursDay>(
    supportHours.days.map((d) => [d.day, d]),
  );

  const DAY_MS = 24 * 60 * 60 * 1000;
  let elapsed = 0;

  // Start cursor at UTC midnight of the day containing `since`.
  let cursor = new Date(since);
  cursor.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() < now.getTime()) {
    // Sample at noon UTC to avoid DST boundary issues when reading the weekday.
    const noon = new Date(cursor.getTime() + 12 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      year:    'numeric',
      month:   '2-digit',
      day:     '2-digit',
      hour12:  false,
    }).formatToParts(noon);

    const weekdayRaw = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const weekday = weekdayRaw.toLowerCase().slice(0, 3) as Weekday;
    const dayConfig = dayMap.get(weekday);

    if (dayConfig?.enabled) {
      const year  = parts.find((p) => p.type === 'year')?.value  ?? '2024';
      const month = parts.find((p) => p.type === 'month')?.value ?? '01';
      const day   = parts.find((p) => p.type === 'day')?.value   ?? '01';
      const dateStr = `${year}-${month}-${day}`;

      const windowStart = localDateTimeToUTC(`${dateStr}T${dayConfig.from}:00`, tz);
      const windowEnd   = localDateTimeToUTC(`${dateStr}T${dayConfig.to}:00`,   tz);

      const intStart = Math.max(since.getTime(), windowStart.getTime());
      const intEnd   = Math.min(now.getTime(),   windowEnd.getTime());
      if (intEnd > intStart) elapsed += (intEnd - intStart) / 60_000;
    }

    cursor = new Date(cursor.getTime() + DAY_MS);
  }

  return elapsed;
}

/**
 * "Inverse Intl" trick — converts a naive local datetime string
 * ('YYYY-MM-DDTHH:MM:SS') in `tz` to the corresponding UTC Date.
 *
 * Accurate to ±1 h around DST transitions (acceptable for SLA purposes).
 */
function localDateTimeToUTC(localDateTimeStr: string, tz: string): Date {
  const naive = new Date(`${localDateTimeStr}Z`);
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year:   'numeric',
    month:  '2-digit',
    day:    '2-digit',
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(naive);
  // en-CA yields "YYYY-MM-DD, HH:MM:SS"
  const localAsUTC = new Date(formatted.replace(', ', 'T') + 'Z');
  return new Date(naive.getTime() + (naive.getTime() - localAsUTC.getTime()));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
