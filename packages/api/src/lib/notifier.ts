/**
 * Fire-and-forget email notifications for ticket lifecycle events.
 *
 * Every exported function is synchronous from the caller's perspective —
 * it returns void and swallows errors so it never breaks a request handler.
 *
 * Events covered:
 *   notifyTicketCreated   — confirmation to requester; alert to assignee (if set)
 *   notifyAgentReplied    — agent posted a public comment → email the requester
 *   notifyRequesterReplied — requester posted a comment  → email the assignee
 *   notifyTicketResolved  — status changed to resolved/closed → email the requester
 *   notifyAssigned        — ticket was assigned/reassigned → email the new assignee
 */

import { and, eq } from 'drizzle-orm';
import { deliverWebhooks } from './webhooks.js';
import { db } from '../db/client.js';
import { requests, users, projects, organizations, comments, csatSurveys } from '../db/schema.js';
import crypto from 'crypto';
import { sendEmail, isEmailConfigured } from './emailSender.js';
import { decryptOrgSettings } from './secretCrypto.js';
import { logger } from './logger.js';
import type { EmailSenderConfig, OrganizationSettings } from '@enlight/shared';

// ── Public API ────────────────────────────────────────────────────────────────

/** Ticket was just created. Sends a confirmation to the requester and (if set)
 *  an assignment alert to the initial assignee. */
export function notifyTicketCreated(requestId: string): void {
  run(() => doTicketCreated(requestId));
}

/** A human agent posted a public comment. Emails the requester. */
export function notifyAgentReplied(requestId: string, commentId: string): void {
  run(() => doAgentReplied(requestId, commentId));
}

/** The requester posted a public comment. Emails the assignee (if any). */
export function notifyRequesterReplied(requestId: string, commentId: string): void {
  run(() => doRequesterReplied(requestId, commentId));
}

/** Ticket status changed to resolved or closed. Emails the requester. */
export function notifyTicketResolved(requestId: string): void {
  run(() => doTicketResolved(requestId));
}

/** Ticket was assigned (or reassigned) to a user. Emails the new assignee. */
export function notifyAssigned(requestId: string, assigneeId: string): void {
  run(() => doAssigned(requestId, assigneeId));
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function run(fn: () => Promise<void>): void {
  fn().catch((err) => logger.warn('Email notification error', { err }));
}

interface TicketContext {
  id: string;
  ticketNumber: number;
  title: string;
  priority: string;
  status: string;
  projectKey: string;
  projectName: string;
  orgId: string;
  requesterId: string;
  assigneeId: string | null;
  emailCfg: EmailSenderConfig | null;
  webUrl: string;
}

async function loadTicketCtx(requestId: string): Promise<TicketContext | null> {
  const [row] = await db
    .select({
      id: requests.id,
      ticketNumber: requests.ticketNumber,
      title: requests.title,
      priority: requests.priority,
      status: requests.status,
      projectKey: projects.key,
      projectName: projects.name,
      orgId: projects.orgId,
      requesterId: requests.requesterId,
      assigneeId: requests.assigneeId,
      emailSenderConfig: organizations.emailSenderConfig,
      orgSettings: organizations.settings,
    })
    .from(requests)
    .innerJoin(projects, eq(projects.id, requests.projectId))
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(eq(requests.id, requestId))
    .limit(1);

  if (!row) return null;

  // Decrypt org settings to get emailSenderConfig if it's in the settings JSONB;
  // the organizations.emailSenderConfig column is the primary source.
  const emailCfg = (row.emailSenderConfig ?? null) as EmailSenderConfig | null;

  return {
    id: row.id,
    ticketNumber: row.ticketNumber,
    title: row.title,
    priority: row.priority,
    status: row.status,
    projectKey: row.projectKey,
    projectName: row.projectName,
    orgId: row.orgId,
    requesterId: row.requesterId,
    assigneeId: row.assigneeId,
    emailCfg,
    webUrl: (process.env['WEB_URL'] ?? 'http://localhost:5173').replace(/\/+$/, ''),
  };
}

async function loadUser(userId: string): Promise<{ name: string; email: string; emailPreferences: Record<string, unknown> } | null> {
  const [u] = await db
    .select({ name: users.name, email: users.email, emailPreferences: users.emailPreferences })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u ? { ...u, emailPreferences: (u.emailPreferences ?? {}) as Record<string, unknown> } : null;
}

/** Returns true if the user has opted in to this notification type (default: opted in). */
function optedIn(prefs: Record<string, unknown>, key: string): boolean {
  const v = prefs[key];
  return v === undefined || v === true;
}

function ticketUrl(ctx: TicketContext): string {
  return `${ctx.webUrl}/projects/${ctx.orgId}/requests/${ctx.id}`;
}

function ticketRef(ctx: TicketContext): string {
  return `${ctx.projectKey}-${ctx.ticketNumber}: ${ctx.title}`;
}

// ── Email HTML template ───────────────────────────────────────────────────────

function emailHtml(opts: {
  headline: string;
  intro: string;
  ticketRef: string;
  ticketUrl: string;
  details: [string, string][];
  body?: string;
  ctaLabel: string;
}): string {
  const { headline, intro, ticketUrl, details, body, ctaLabel } = opts;
  const rows = details
    .map(([k, v]) =>
      `<tr><td style="padding:5px 16px 5px 0;color:#6b7280;font-size:13px;white-space:nowrap">${k}</td>` +
      `<td style="padding:5px 0;font-size:13px">${v}</td></tr>`,
    )
    .join('');

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#111;max-width:580px;margin:auto;padding:28px">
<h2 style="margin:0 0 6px">${headline}</h2>
<p style="color:#6b7280;font-size:14px;margin:0 0 20px">${intro}</p>
<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:20px">
  <a href="${ticketUrl}" style="font-weight:600;color:#2563eb;font-size:15px;text-decoration:none">${opts.ticketRef}</a>
  <table style="border-collapse:collapse;margin-top:10px;width:100%">${rows}</table>
</div>
${body ? `<blockquote style="border-left:3px solid #e5e7eb;margin:0 0 20px;padding:10px 16px;color:#374151;font-size:14px">${body}</blockquote>` : ''}
<a href="${ticketUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">${ctaLabel}</a>
<p style="color:#9ca3af;font-size:12px;margin-top:28px;border-top:1px solid #e5e7eb;padding-top:14px">Sent by Enlight ITSM</p>
</body></html>`;
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function doTicketCreated(requestId: string): Promise<void> {
  const ctx = await loadTicketCtx(requestId);
  if (!ctx) return;

  // Webhook — always fire regardless of email config
  deliverWebhooks(ctx.orgId, 'request.created', {
    id: ctx.id, ticketNumber: ctx.ticketNumber, title: ctx.title,
    priority: ctx.priority, status: ctx.status, projectKey: ctx.projectKey,
  });

  if (!isEmailConfigured(ctx.emailCfg)) return;
  const requester = await loadUser(ctx.requesterId);
  if (!requester?.email) return;

  // Confirmation to the requester.
  if (optedIn(requester.emailPreferences, 'ticketCreated')) await sendEmail({
    to: requester.email,
    subject: `[${ctx.projectKey}-${ctx.ticketNumber}] Ticket received: ${ctx.title}`,
    html: emailHtml({
      headline: 'Your ticket was received',
      intro: `We've logged your request and our team will be in touch shortly.`,
      ticketRef: ticketRef(ctx),
      ticketUrl: ticketUrl(ctx),
      details: [
        ['Project', ctx.projectName],
        ['Priority', ctx.priority],
        ['Status', ctx.status],
      ],
      ctaLabel: 'View ticket →',
    }),
    orgEmailConfig: ctx.emailCfg,
  });

  // Assignment alert to the assignee (if the ticket started assigned).
  if (ctx.assigneeId && ctx.assigneeId !== ctx.requesterId) {
    const assignee = await loadUser(ctx.assigneeId);
    if (assignee?.email && optedIn(assignee.emailPreferences, 'assigned')) {
      await sendEmail({
        to: assignee.email,
        subject: `[${ctx.projectKey}-${ctx.ticketNumber}] New ticket assigned to you: ${ctx.title}`,
        html: emailHtml({
          headline: 'A ticket was assigned to you',
          intro: `A new ${ctx.priority}-priority ticket in ${ctx.projectName} has been assigned to you.`,
          ticketRef: ticketRef(ctx),
          ticketUrl: ticketUrl(ctx),
          details: [
            ['Project', ctx.projectName],
            ['Priority', ctx.priority],
            ['Requester', requester.name],
          ],
          ctaLabel: 'View ticket →',
        }),
        orgEmailConfig: ctx.emailCfg,
      });
    }
  }
}

async function doAgentReplied(requestId: string, commentId: string): Promise<void> {
  const ctx = await loadTicketCtx(requestId);
  if (!ctx || !isEmailConfigured(ctx.emailCfg)) return;

  const requester = await loadUser(ctx.requesterId);
  if (!requester?.email || !optedIn(requester.emailPreferences, 'agentReplied')) return;

  // Load the comment body for the email preview.
  const [commentRow] = await db
    .select({ body: comments.body, authorId: comments.authorId })
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.requestId, requestId)))
    .limit(1);

  const author = commentRow?.authorId ? await loadUser(commentRow.authorId) : null;

  await sendEmail({
    to: requester.email,
    subject: `[${ctx.projectKey}-${ctx.ticketNumber}] New reply: ${ctx.title}`,
    html: emailHtml({
      headline: 'Your ticket has a new reply',
      intro: `${author?.name ?? 'An agent'} replied to your ticket in ${ctx.projectName}.`,
      ticketRef: ticketRef(ctx),
      ticketUrl: ticketUrl(ctx),
      details: [
        ['Project', ctx.projectName],
        ['Priority', ctx.priority],
        ['Status', ctx.status.replace('_', ' ')],
      ],
      ...(commentRow?.body ? { body: escapeHtml(commentRow.body).replace(/\n/g, '<br>') } : {}),
      ctaLabel: 'Reply →',
    }),
    orgEmailConfig: ctx.emailCfg,
  });
}

async function doRequesterReplied(requestId: string, commentId: string): Promise<void> {
  const ctx = await loadTicketCtx(requestId);
  if (!ctx || !isEmailConfigured(ctx.emailCfg) || !ctx.assigneeId) return;

  const assignee = await loadUser(ctx.assigneeId);
  if (!assignee?.email || !optedIn(assignee.emailPreferences, 'requesterReplied')) return;

  const requester = await loadUser(ctx.requesterId);

  const [commentRow] = await db
    .select({ body: comments.body })
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.requestId, requestId)))
    .limit(1);

  await sendEmail({
    to: assignee.email,
    subject: `[${ctx.projectKey}-${ctx.ticketNumber}] Requester replied: ${ctx.title}`,
    html: emailHtml({
      headline: 'The requester replied to a ticket',
      intro: `${requester?.name ?? 'The requester'} posted a new comment on a ticket assigned to you.`,
      ticketRef: ticketRef(ctx),
      ticketUrl: ticketUrl(ctx),
      details: [
        ['Project', ctx.projectName],
        ['Priority', ctx.priority],
        ['Requester', requester?.name ?? ''],
      ],
      ...(commentRow?.body ? { body: escapeHtml(commentRow.body).replace(/\n/g, '<br>') } : {}),
      ctaLabel: 'View & reply →',
    }),
    orgEmailConfig: ctx.emailCfg,
  });
}

async function doTicketResolved(requestId: string): Promise<void> {
  const ctx = await loadTicketCtx(requestId);
  if (!ctx) return;
  deliverWebhooks(ctx.orgId, 'request.resolved', {
    id: ctx.id, ticketNumber: ctx.ticketNumber, title: ctx.title,
    priority: ctx.priority, status: ctx.status, projectKey: ctx.projectKey,
  });
  if (!isEmailConfigured(ctx.emailCfg)) return;

  const requester = await loadUser(ctx.requesterId);
  if (!requester?.email || !optedIn(requester.emailPreferences, 'ticketResolved')) return;

  const statusLabel = ctx.status === 'closed' ? 'closed' : 'resolved';

  // Create a CSAT survey and include its link in the resolution email.
  const csatToken = crypto.randomBytes(16).toString('hex');
  try {
    await db.insert(csatSurveys).values({ requestId, token: csatToken })
      .onConflictDoNothing(); // one survey per request
  } catch { /* ignore — survey already exists */ }

  const csatUrl = `${ctx.webUrl}/csat/${csatToken}`;

  await sendEmail({
    to: requester.email,
    subject: `[${ctx.projectKey}-${ctx.ticketNumber}] Ticket ${statusLabel}: ${ctx.title}`,
    html: emailHtml({
      headline: `Your ticket was ${statusLabel}`,
      intro: `Your support request in ${ctx.projectName} has been marked as ${statusLabel}.`,
      ticketRef: ticketRef(ctx),
      ticketUrl: ticketUrl(ctx),
      details: [
        ['Project', ctx.projectName],
        ['Status', statusLabel],
      ],
      ctaLabel: 'View ticket →',
    }) + `
<div style="margin-top:24px;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;text-align:center">
  <p style="font-size:13px;color:#374151;margin:0 0 12px">How did we do? Rate your experience:</p>
  <div style="display:inline-flex;gap:8px">
    ${[1,2,3,4,5].map(n =>
      `<a href="${csatUrl}?rating=${n}" style="display:inline-block;width:36px;height:36px;line-height:36px;border-radius:50%;background:#e5e7eb;color:#374151;text-decoration:none;font-size:16px;text-align:center">${['😞','😕','😐','🙂','😄'][n-1]}</a>`
    ).join('')}
  </div>
</div>`,
    orgEmailConfig: ctx.emailCfg,
  });
}

async function doAssigned(requestId: string, assigneeId: string): Promise<void> {
  const ctx = await loadTicketCtx(requestId);
  if (!ctx || !isEmailConfigured(ctx.emailCfg)) return;

  const assignee = await loadUser(assigneeId);
  if (!assignee?.email || !optedIn(assignee.emailPreferences, 'assigned')) return;

  const requester = await loadUser(ctx.requesterId);

  await sendEmail({
    to: assignee.email,
    subject: `[${ctx.projectKey}-${ctx.ticketNumber}] Ticket assigned to you: ${ctx.title}`,
    html: emailHtml({
      headline: 'A ticket was assigned to you',
      intro: `A ${ctx.priority}-priority ticket in ${ctx.projectName} has been assigned to you.`,
      ticketRef: ticketRef(ctx),
      ticketUrl: ticketUrl(ctx),
      details: [
        ['Project', ctx.projectName],
        ['Priority', ctx.priority],
        ['Requester', requester?.name ?? ''],
        ['Status', ctx.status.replace('_', ' ')],
      ],
      ctaLabel: 'View ticket →',
    }),
    orgEmailConfig: ctx.emailCfg,
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
