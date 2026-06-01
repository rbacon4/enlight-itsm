// Automation/workflow engine. Shared by the API (event triggers, enqueued to the
// worker) and the worker (event jobs + periodic time-based scans).
import { db } from '../db/client.js';
import { automationRules, automationRuns, requests, comments, projects, users, organizations } from '../db/schema.js';
import { eq, and, lt, isNull, sql } from 'drizzle-orm';
import { agentQueue } from '../queues/index.js';
import { logger } from './logger.js';
import { isBlockedHost } from './samlMetadata.js';
import { decryptOrgSettings } from './secretCrypto.js';
import type {
  AutomationRule, AutomationTrigger, AutomationCondition, AutomationAction,
  AutomationTriggerType, OrganizationSettings,
} from '@enlight/shared';

type RequestRow = typeof requests.$inferSelect;
type RuleRow = typeof automationRules.$inferSelect;

const AUTOMATION_EMAIL = 'enlight-automation@system.internal';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Comment fields needed to evaluate comment_* conditions. `hour`/`weekday` are
 *  derived in SQL from the stored wall-clock so they don't depend on the Node
 *  process timezone (a `timestamp without time zone` column is otherwise
 *  ambiguous when parsed by the driver). */
interface CommentEval {
  body: string;
  isInternal: boolean;
  hour: number | null;      // 0–23, server-recorded local hour
  weekday: string | null;   // 'sun' … 'sat'
}

// ── Condition evaluation ───────────────────────────────────────────────────────

/** Resolves the comparison value for a condition field against the request and
 *  (for comment_added triggers) the comment that fired it. */
function fieldValue(field: AutomationCondition['field'], request: RequestRow, comment?: CommentEval): string {
  if (field.startsWith('comment_')) {
    if (!comment) return ''; // no comment context → comment conditions can't match
    switch (field) {
      case 'comment_body':        return comment.body ?? '';
      case 'comment_is_internal': return comment.isInternal ? 'true' : 'false';
      case 'comment_hour':        return comment.hour == null ? '' : String(comment.hour);
      case 'comment_weekday':     return comment.weekday ?? '';
      default:                    return '';
    }
  }
  const v = (request as unknown as Record<string, unknown>)[field];
  return v == null ? '' : String(v);
}

function evalCondition(c: AutomationCondition, request: RequestRow, comment?: CommentEval): boolean {
  const actual = fieldValue(c.field, request, comment);
  const expected = String(c.value ?? '');
  switch (c.op) {
    case 'eq':           return actual === expected;
    case 'neq':          return actual !== expected;
    case 'contains':     return actual.toLowerCase().includes(expected.toLowerCase());
    case 'in':           return Array.isArray(c.value) && c.value.map(String).includes(actual);
    case 'is_empty':     return actual === '';
    case 'is_not_empty': return actual !== '';
    case 'gt':           return Number(actual) >  Number(expected);
    case 'lt':           return Number(actual) <  Number(expected);
    case 'gte':          return Number(actual) >= Number(expected);
    case 'lte':          return Number(actual) <= Number(expected);
    default:             return false;
  }
}

function conditionsMatch(request: RequestRow, conditions: AutomationCondition[], comment?: CommentEval): boolean {
  return conditions.every((c) => evalCondition(c, request, comment));
}

// ── Timezone helpers ───────────────────────────────────────────────────────────

const DEFAULT_TZ = 'UTC';

/** Hour (0–23) and short weekday ('mon'…'sun') of an instant in a given IANA tz. */
function zonedParts(date: Date, timezone: string): { hour: number; weekday: string } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false, hour: '2-digit', weekday: 'short',
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24; // '24' → 0 at midnight
    const weekday = (parts.find((p) => p.type === 'weekday')?.value ?? '').toLowerCase().slice(0, 3);
    return { hour: Number.isFinite(hour) ? hour : 0, weekday };
  } catch {
    return { hour: date.getUTCHours(), weekday: WEEKDAYS[date.getUTCDay()] ?? '' };
  }
}

/** time_based business-hours gate: is "now" within the trigger's active window? */
function withinSchedule(trigger: AutomationTrigger, now = new Date()): boolean {
  const tz = trigger.timezone || DEFAULT_TZ;
  const { hour, weekday } = zonedParts(now, tz);
  if (trigger.activeDays && trigger.activeDays.length > 0 && !trigger.activeDays.includes(weekday)) {
    return false;
  }
  const { activeFromHour: from, activeToHour: to } = trigger;
  if (typeof from === 'number' && typeof to === 'number' && from !== to) {
    if (from < to) { if (hour < from || hour >= to) return false; }   // same-day window
    else { if (hour < from && hour >= to) return false; }             // overnight window (e.g. 22→6)
  }
  return true;
}

/** Loads the comment that fired a comment_added event: its text, internal flag,
 *  and the absolute instant it was posted (so hour/weekday can be resolved in any
 *  timezone). The instant is recovered from the wall-clock column via the DB's
 *  session timezone, then formatted per-rule in the rule's chosen timezone. */
async function loadCommentBase(commentId: string): Promise<{ body: string; isInternal: boolean; instant: Date } | undefined> {
  const result = await db.execute(sql`
    SELECT body,
           is_internal AS is_internal,
           EXTRACT(EPOCH FROM (created_at AT TIME ZONE current_setting('TimeZone')))::double precision AS epoch
    FROM comments WHERE id = ${commentId} LIMIT 1
  `);
  const row = (result.rows?.[0] ?? undefined) as
    { body: string; is_internal: boolean; epoch: number } | undefined;
  if (!row) return undefined;
  return { body: row.body, isInternal: row.is_internal, instant: new Date(Number(row.epoch) * 1000) };
}

function commentEvalFor(base: { body: string; isInternal: boolean; instant: Date }, trigger: AutomationTrigger): CommentEval {
  const { hour, weekday } = zonedParts(base.instant, trigger.timezone || DEFAULT_TZ);
  return { body: base.body, isInternal: base.isInternal, hour, weekday };
}

// ── Templating ─────────────────────────────────────────────────────────────────

function render(template: string, request: RequestRow, webUrl: string): string {
  const map: Record<string, string> = {
    ticket_number: String(request.ticketNumber),
    title: request.title,
    description: request.description ?? '',
    status: request.status,
    priority: request.priority,
    category: request.category ?? '',
    id: request.id,
    url: `${webUrl}/requests?id=${request.id}`,
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => map[key] ?? '');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function resolveAutomationUserId(orgId: string): Promise<string> {
  const [existing] = await db.select({ id: users.id }).from(users)
    .where(eq(users.email, AUTOMATION_EMAIL)).limit(1);
  if (existing) return existing.id;
  const [created] = await db.insert(users).values({
    orgId, email: AUTOMATION_EMAIL, name: 'Automation', globalRole: 'agent',
  }).onConflictDoNothing().returning({ id: users.id });
  if (created) return created.id;
  const [refetch] = await db.select({ id: users.id }).from(users)
    .where(eq(users.email, AUTOMATION_EMAIL)).limit(1);
  return refetch?.id ?? '';
}

async function orgSettingsFor(orgId: string): Promise<OrganizationSettings> {
  const [org] = await db.select({ settings: organizations.settings }).from(organizations)
    .where(eq(organizations.id, orgId)).limit(1);
  return decryptOrgSettings((org?.settings ?? {}) as OrganizationSettings);
}

// ── Action execution ───────────────────────────────────────────────────────────

async function postSlack(token: string, target: string, text: string): Promise<void> {
  // For a user ID, open an IM channel first; channel IDs are used as-is.
  let channel = target;
  if (/^U[A-Z0-9]/i.test(target)) {
    const open = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ users: target }),
    }).then((r) => r.json() as Promise<{ ok: boolean; channel?: { id: string } }>);
    if (open.ok && open.channel?.id) channel = open.channel.id;
  }
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text }),
  }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);
  if (!resp.ok) throw new Error(`Slack: ${resp.error ?? 'postMessage failed'}`);
}

async function runHttpRequest(action: Extract<AutomationAction, { type: 'http_request' }>, request: RequestRow, webUrl: string): Promise<void> {
  const url = render(action.url, request, webUrl);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('URL must be http(s).');
  if (isBlockedHost(parsed.hostname)) throw new Error('Refusing to call internal/private addresses.');

  const headers: Record<string, string> = { ...(action.headers ?? {}) };
  const method = action.method ?? 'POST';
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'DELETE') {
    init.body = action.body ? render(action.body, request, webUrl) : '';
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    init.signal = controller.signal;
    const resp = await fetch(url, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Executes one rule's actions against a request. Returns per-action outcome notes. */
async function executeActions(rule: RuleRow, request: RequestRow, orgId: string): Promise<{ ok: boolean; notes: string[] }> {
  const webUrl = (process.env['WEB_URL'] ?? 'http://localhost:5173').replace(/\/+$/, '');
  const actions = (rule.actions ?? []) as AutomationAction[];
  const notes: string[] = [];
  let ok = true;

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'set_fields': {
          const patch: Record<string, unknown> = { updatedAt: new Date() };
          if (action.status) patch['status'] = action.status;
          if (action.priority) patch['priority'] = action.priority;
          if (action.category !== undefined) patch['category'] = action.category;
          if (action.assigneeId) patch['assigneeId'] = action.assigneeId === 'unassign' ? null : action.assigneeId;
          if ((action.status === 'resolved' || action.status === 'closed') && !request.resolvedAt) {
            patch['resolvedAt'] = new Date();
          }
          // Direct DB write (does NOT re-enqueue automation events → no loops).
          await db.update(requests).set(patch).where(eq(requests.id, request.id));
          notes.push('set_fields ok');
          break;
        }
        case 'add_comment': {
          const authorId = await resolveAutomationUserId(orgId);
          await db.insert(comments).values({
            requestId: request.id,
            authorId,
            body: render(action.body, request, webUrl),
            isInternal: action.isInternal ?? false,
            aiGenerated: false,
          });
          notes.push('add_comment ok');
          break;
        }
        case 'notify_slack': {
          const settings = await orgSettingsFor(orgId);
          const token = settings.slackBotToken || process.env['SLACK_BOT_TOKEN'];
          if (!token) { notes.push('notify_slack skipped (no bot token)'); ok = false; break; }
          await postSlack(token, action.target, render(action.message, request, webUrl));
          notes.push('notify_slack ok');
          break;
        }
        case 'trigger_ai': {
          await agentQueue.add('triage', { requestId: request.id, projectId: request.projectId, requesterRole: 'agent' });
          notes.push('trigger_ai queued');
          break;
        }
        case 'http_request': {
          await runHttpRequest(action, request, webUrl);
          notes.push('http_request ok');
          break;
        }
        default:
          notes.push(`unknown action ${(action as { type?: string }).type}`);
      }
    } catch (err) {
      ok = false;
      notes.push(`${action.type} error: ${err instanceof Error ? err.message : 'failed'}`);
      logger.error('Automation action failed', { ruleId: rule.id, action: action.type, err });
    }
  }
  return { ok, notes };
}

async function recordRun(ruleId: string, requestId: string, ok: boolean, notes: string[]): Promise<void> {
  await db.insert(automationRuns).values({
    ruleId, requestId,
    status: ok ? 'success' : 'partial',
    detail: notes.join('; ').slice(0, 1000),
  });
  await db.update(automationRules)
    .set({ lastTriggeredAt: new Date(), triggerCount: sql`${automationRules.triggerCount} + 1` })
    .where(eq(automationRules.id, ruleId));
}

// ── Public entry points ────────────────────────────────────────────────────────

/** Runs all matching event-triggered rules for one request. Called from the worker.
 *  For `comment_added`, pass the commentId so conditions can inspect the comment. */
export async function runEventAutomations(event: AutomationTriggerType, requestId: string, commentId?: string): Promise<void> {
  const [request] = await db.select().from(requests).where(eq(requests.id, requestId)).limit(1);
  if (!request) return;

  const [proj] = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, request.projectId)).limit(1);
  if (!proj) return;

  // Load the triggering comment once; hour/weekday are resolved per-rule below,
  // since each rule may use a different timezone.
  let commentBase: { body: string; isInternal: boolean; instant: Date } | undefined;
  if (event === 'comment_added' && commentId) {
    commentBase = await loadCommentBase(commentId);
  }

  const rules = await db.select().from(automationRules)
    .where(and(eq(automationRules.projectId, request.projectId), eq(automationRules.enabled, true)));

  for (const rule of rules) {
    const trigger = rule.trigger as AutomationTrigger;
    if (trigger.type !== event) continue;
    const comment = commentBase ? commentEvalFor(commentBase, trigger) : undefined;
    if (!conditionsMatch(request, (rule.conditions ?? []) as AutomationCondition[], comment)) continue;

    const { ok, notes } = await executeActions(rule, request, proj.orgId);
    await recordRun(rule.id, request.id, ok, notes);
    logger.info('Automation fired', { ruleId: rule.id, event, requestId, ok });
  }
}

/**
 * Scans all enabled time-based rules and fires them on matching requests that
 * haven't already been processed by that rule (deduped via automation_runs).
 */
export async function runTimeBasedAutomations(): Promise<void> {
  const rules = await db.select().from(automationRules).where(eq(automationRules.enabled, true));
  const timeRules = rules.filter((r) => (r.trigger as AutomationTrigger).type === 'time_based');
  if (timeRules.length === 0) return;

  for (const rule of timeRules) {
    const trigger = rule.trigger as AutomationTrigger;

    // Business-hours gate: skip rules whose active window (in their timezone)
    // doesn't include the current moment. The dedup log means an eligible request
    // simply fires on the first scan that lands inside the window.
    if (!withinSchedule(trigger)) continue;

    const hours = trigger.hours ?? 24;
    const cutoff = new Date(Date.now() - hours * 3_600_000);
    const tsCol = trigger.metric === 'hours_since_updated' ? requests.updatedAt : requests.createdAt;

    const [proj] = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, rule.projectId)).limit(1);
    if (!proj) continue;

    // Candidate requests: in this project, past the time threshold, and not yet
    // processed by this rule (left join on automation_runs is null).
    const candidates = await db.select().from(requests)
      .leftJoin(automationRuns, and(eq(automationRuns.requestId, requests.id), eq(automationRuns.ruleId, rule.id)))
      .where(and(eq(requests.projectId, rule.projectId), lt(tsCol, cutoff), isNull(automationRuns.id)));

    for (const row of candidates) {
      const request = row.requests;
      if (!conditionsMatch(request, (rule.conditions ?? []) as AutomationCondition[])) continue;
      const { ok, notes } = await executeActions(rule, request, proj.orgId);
      await recordRun(rule.id, request.id, ok, notes);
      logger.info('Time-based automation fired', { ruleId: rule.id, requestId: request.id, ok });
    }
  }
}

export type { AutomationRule };
