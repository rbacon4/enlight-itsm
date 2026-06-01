import { Router } from 'express';
import { db } from '../db/client.js';
import { analyticsReports } from '../db/schema.js';
import { eq, and, or, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { Errors } from '../lib/errors.js';
import { z } from 'zod';
import { validateQuerySQL, runOrgQuery } from '../lib/queryRunner.js';
import type { BuiltinReport, ExportEntity, ExportEntityMeta, DashboardChartConfig } from '@enlight/shared';

// ── Built-in reports ──────────────────────────────────────────────────────────
// Each ships with vetted SQL run through the same org-scoped sandbox as custom
// reports. The `key` is stable; the SQL lives only on the server.

interface BuiltinDef extends BuiltinReport {
  sql: string;
}

const BUILTIN_REPORTS: BuiltinDef[] = [
  {
    key: 'requests_by_status',
    name: 'Requests by Status',
    description: 'Count of all requests grouped by their current status.',
    chartConfig: { chartType: 'bar', xKey: 'status', yKeys: ['count'] },
    sql: `SELECT status, COUNT(*)::int AS count
          FROM requests
          GROUP BY status
          ORDER BY count DESC`,
  },
  {
    key: 'requests_by_priority',
    name: 'Requests by Priority',
    description: 'Distribution of requests across priority levels.',
    chartConfig: { chartType: 'pie', xKey: 'priority', yKeys: ['count'] },
    sql: `SELECT priority, COUNT(*)::int AS count
          FROM requests
          GROUP BY priority
          ORDER BY count DESC`,
  },
  {
    key: 'requests_per_day',
    name: 'Requests per Day (last 30 days)',
    description: 'Daily volume of new requests over the past month.',
    chartConfig: { chartType: 'area', xKey: 'day', yKeys: ['requests'] },
    sql: `SELECT to_char(DATE(created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS requests
          FROM requests
          WHERE created_at >= NOW() - INTERVAL '30 days'
          GROUP BY day
          ORDER BY day`,
  },
  {
    key: 'open_by_project',
    name: 'Open Requests by Project',
    description: 'How many open requests each project currently has.',
    chartConfig: { chartType: 'bar', xKey: 'project', yKeys: ['open_count'], horizontal: true },
    sql: `SELECT p.name AS project, COUNT(r.id)::int AS open_count
          FROM projects p
          LEFT JOIN requests r ON r.project_id = p.id AND r.status IN ('open', 'in_progress')
          GROUP BY p.name
          ORDER BY open_count DESC`,
  },
  {
    key: 'avg_resolution_time',
    name: 'Avg Resolution Time by Project (days)',
    description: 'Average time from creation to resolution per project.',
    chartConfig: { chartType: 'bar', xKey: 'project', yKeys: ['avg_days'] },
    sql: `SELECT p.name AS project,
                 ROUND(AVG(EXTRACT(EPOCH FROM (r.resolved_at - r.created_at)) / 86400)::numeric, 1) AS avg_days
          FROM requests r
          JOIN projects p ON p.id = r.project_id
          WHERE r.resolved_at IS NOT NULL
          GROUP BY p.name
          ORDER BY avg_days`,
  },
  {
    key: 'top_assignees',
    name: 'Top Assignees by Active Workload',
    description: 'Agents with the most open or in-progress requests assigned.',
    chartConfig: { chartType: 'bar', xKey: 'assignee', yKeys: ['active'], horizontal: true },
    sql: `SELECT u.name AS assignee, COUNT(*)::int AS active
          FROM requests r
          JOIN users u ON u.id = r.assignee_id
          WHERE r.status IN ('open', 'in_progress')
          GROUP BY u.name
          ORDER BY active DESC
          LIMIT 10`,
  },
  {
    key: 'ai_resolution_share',
    name: 'AI vs Human Resolution',
    description: 'Share of resolved requests that had an AI action versus none.',
    chartConfig: { chartType: 'pie', xKey: 'handled_by', yKeys: ['count'] },
    sql: `SELECT CASE WHEN EXISTS (
                   SELECT 1 FROM ai_actions a WHERE a.request_id = r.id
                 ) THEN 'AI assisted' ELSE 'Human only' END AS handled_by,
                 COUNT(*)::int AS count
          FROM requests r
          WHERE r.status IN ('resolved', 'closed')
          GROUP BY handled_by`,
  },
];

function builtinPublic(b: BuiltinDef): BuiltinReport {
  return { key: b.key, name: b.name, description: b.description, chartConfig: b.chartConfig };
}

// ── CSV export definitions ──────────────────────────────────────────────────
// Predefined, org-scoped SELECTs — never user SQL. Returns up to MAX_EXPORT_ROWS.

const MAX_EXPORT_ROWS = 50_000;

const EXPORT_QUERIES: Record<ExportEntity, { label: string; description: string; sql: string }> = {
  requests: {
    label: 'Requests',
    description: 'All tickets with status, priority, assignee, and timestamps.',
    sql: `SELECT r.ticket_number, r.title, r.status, r.priority, r.category, r.subcategory,
                 p.name AS project, req.name AS requester, asg.name AS assignee,
                 r.created_at, r.updated_at, r.resolved_at
          FROM requests r
          JOIN projects p   ON p.id = r.project_id
          JOIN users   req  ON req.id = r.requester_id
          LEFT JOIN users asg ON asg.id = r.assignee_id
          ORDER BY r.created_at DESC`,
  },
  comments: {
    label: 'Comments',
    description: 'All comments across requests, with author and visibility.',
    sql: `SELECT r.ticket_number, u.name AS author, c.is_internal, c.ai_generated,
                 c.body, c.created_at
          FROM comments c
          JOIN requests r ON r.id = c.request_id
          JOIN users u    ON u.id = c.author_id
          ORDER BY c.created_at DESC`,
  },
  projects: {
    label: 'Projects',
    description: 'All projects with their key settings and ticket counts.',
    sql: `SELECT p.name, p.key, p.status, p.access_type, p.ai_model,
                 p.ai_autonomous_mode, p.last_ticket_number, p.created_at
          FROM projects p
          ORDER BY p.name`,
  },
  users: {
    label: 'Users',
    description: 'All org members with their global role.',
    sql: `SELECT u.name, u.email, u.global_role, u.created_at
          FROM users u
          ORDER BY u.name`,
  },
  ai_actions: {
    label: 'AI Actions',
    description: 'AI agent actions with token usage and confidence.',
    sql: `SELECT r.ticket_number, a.action_type, a.model,
                 a.input_tokens, a.output_tokens, a.confidence, a.created_at
          FROM ai_actions a
          JOIN requests r ON r.id = a.request_id
          ORDER BY a.created_at DESC`,
  },
};

const EXPORT_META: ExportEntityMeta[] = (Object.keys(EXPORT_QUERIES) as ExportEntity[]).map((e) => ({
  entity: e,
  label: EXPORT_QUERIES[e].label,
  description: EXPORT_QUERIES[e].description,
}));

/** Escapes a single value per RFC 4180. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const header = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\r\n');
  return body ? `${header}\r\n${body}` : header;
}

// ── Validation schemas ────────────────────────────────────────────────────────

const chartConfigSchema = z.object({
  chartType:  z.enum(['bar', 'line', 'area', 'pie']),
  xKey:       z.string().min(1).max(100),
  yKeys:      z.array(z.string().min(1).max(100)).min(1).max(10),
  horizontal: z.boolean().optional(),
}).nullable();

const router = Router();
router.use(requireAuth);

// ── GET /analytics/builtins — list shipped report definitions ─────────────────
router.get('/builtins', (_req, res) => {
  res.json(BUILTIN_REPORTS.map(builtinPublic));
});

// ── GET /analytics/exports — list exportable entities ─────────────────────────
router.get('/exports', (_req, res) => {
  res.json(EXPORT_META);
});

// ── POST /analytics/run — run a custom query OR a builtin by key ──────────────
router.post('/run', async (req, res) => {
  try {
    const body = z.object({
      query:      z.string().max(10_000).optional(),
      builtinKey: z.string().max(100).optional(),
    }).parse(req.body);

    let sql: string;
    if (body.builtinKey) {
      const def = BUILTIN_REPORTS.find((b) => b.key === body.builtinKey);
      if (!def) { res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown report.' }); return; }
      sql = def.sql;
    } else if (body.query) {
      const validationError = validateQuerySQL(body.query);
      if (validationError) {
        res.status(400).json({ error: 'INVALID_QUERY', message: validationError });
        return;
      }
      sql = body.query;
    } else {
      res.status(400).json({ error: 'INVALID_QUERY', message: 'Provide a query or builtinKey.' });
      return;
    }

    const result = await runOrgQuery(sql, req.user!.orgId);
    res.json(result);
  } catch (err: unknown) {
    const pgMsg = (err as { message?: string })?.message;
    res.status(400).json({ error: 'QUERY_ERROR', message: pgMsg ?? 'Query failed.' });
  }
});

// ── GET /analytics/export?entity=requests — stream a CSV download ─────────────
router.get('/export', async (req, res, next) => {
  try {
    const { entity } = z.object({
      entity: z.enum(['requests', 'comments', 'projects', 'users', 'ai_actions']),
    }).parse(req.query);

    const def = EXPORT_QUERIES[entity];
    const result = await runOrgQuery(def.sql, req.user!.orgId, MAX_EXPORT_ROWS);
    const csv = rowsToCsv(result.columns, result.rows);

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${entity}_${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ── Report CRUD ───────────────────────────────────────────────────────────────

// GET /analytics/reports — list reports visible to this user (shared OR own)
router.get('/reports', async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(analyticsReports)
      .where(
        and(
          eq(analyticsReports.orgId, req.user!.orgId),
          or(eq(analyticsReports.shared, true), eq(analyticsReports.createdById, req.user!.id)),
        ),
      )
      .orderBy(desc(analyticsReports.createdAt));

    res.json(rows);
  } catch (err) { next(err); }
});

// POST /analytics/reports — create a custom report
router.post('/reports', async (req, res, next) => {
  try {
    const body = z.object({
      name:        z.string().min(1).max(120),
      description: z.string().max(500).optional(),
      query:       z.string().min(1).max(10_000),
      chartConfig: chartConfigSchema.optional(),
      shared:      z.boolean().default(true),
    }).parse(req.body);

    const validationError = validateQuerySQL(body.query);
    if (validationError) { next(Errors.badRequest(validationError)); return; }

    const [report] = await db
      .insert(analyticsReports)
      .values({
        orgId:       req.user!.orgId,
        createdById: req.user!.id,
        name:        body.name,
        description: body.description ?? null,
        type:        'custom',
        query:       body.query,
        chartConfig: (body.chartConfig ?? null) as unknown as DashboardChartConfig,
        shared:      body.shared,
      })
      .returning();

    res.status(201).json(report);
  } catch (err) { next(err); }
});

// PATCH /analytics/reports/:id — update a report (creator only)
router.patch('/reports/:id', async (req, res, next) => {
  try {
    const body = z.object({
      name:        z.string().min(1).max(120).optional(),
      description: z.string().max(500).nullable().optional(),
      query:       z.string().min(1).max(10_000).optional(),
      chartConfig: chartConfigSchema.optional(),
      shared:      z.boolean().optional(),
    }).parse(req.body);

    if (body.query) {
      const validationError = validateQuerySQL(body.query);
      if (validationError) { next(Errors.badRequest(validationError)); return; }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined)        updates['name']        = body.name;
    if (body.description !== undefined) updates['description'] = body.description;
    if (body.query !== undefined)       updates['query']       = body.query;
    if (body.chartConfig !== undefined) updates['chartConfig'] = body.chartConfig;
    if (body.shared !== undefined)      updates['shared']      = body.shared;

    const [updated] = await db
      .update(analyticsReports)
      .set(updates)
      .where(
        and(
          eq(analyticsReports.id, req.params['id'] as string),
          eq(analyticsReports.orgId, req.user!.orgId),
          eq(analyticsReports.createdById, req.user!.id),
        ),
      )
      .returning();

    if (!updated) { next(Errors.notFound('Report')); return; }
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /analytics/reports/:id — delete a report (creator only)
router.delete('/reports/:id', async (req, res, next) => {
  try {
    const [deleted] = await db
      .delete(analyticsReports)
      .where(
        and(
          eq(analyticsReports.id, req.params['id'] as string),
          eq(analyticsReports.orgId, req.user!.orgId),
          eq(analyticsReports.createdById, req.user!.id),
        ),
      )
      .returning({ id: analyticsReports.id });

    if (!deleted) { next(Errors.notFound('Report')); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export { router as analyticsRouter };
