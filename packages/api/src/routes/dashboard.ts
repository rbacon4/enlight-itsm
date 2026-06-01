import { Router } from 'express';
import { db } from '../db/client.js';
import { requests, projects, dashboardLayouts } from '../db/schema.js';
import { eq, inArray, desc, sql, and, gte } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { Errors } from '../lib/errors.js';
import { z } from 'zod';
import { validateQuerySQL, runOrgQuery } from '../lib/queryRunner.js';
import type { DashboardLayoutConfig } from '@enlight/shared';

const router = Router();
router.use(requireAuth);

// GET /dashboard/stats
router.get('/stats', async (req, res, next) => {
  try {
    const orgId = req.user!.orgId;

    // Get all project IDs for this org
    const orgProjects = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.orgId, orgId));

    if (orgProjects.length === 0) {
      res.json({
        openCount: 0,
        inProgressCount: 0,
        resolvedTodayCount: 0,
        slaBreachCount: 0,
        recentRequests: [],
        projectSummary: [],
      });
      return;
    }

    const projectIds = orgProjects.map((p) => p.id);

    // Today's start (midnight UTC)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [
      openRow,
      inProgressRow,
      resolvedTodayRow,
      slaBreachRow,
      recentRows,
      summaryRows,
    ] = await Promise.all([
      // Open count
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(requests)
        .where(and(inArray(requests.projectId, projectIds), eq(requests.status, 'open'))),

      // In-progress count
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(requests)
        .where(and(inArray(requests.projectId, projectIds), eq(requests.status, 'in_progress'))),

      // Resolved today
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(requests)
        .where(
          and(
            inArray(requests.projectId, projectIds),
            eq(requests.status, 'resolved'),
            gte(requests.resolvedAt, todayStart),
          ),
        ),

      // SLA breaches: open/in_progress requests past their response-time SLA
      db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM requests r
        JOIN projects p ON r.project_id = p.id
        WHERE p.org_id = ${orgId}
          AND r.status IN ('open', 'in_progress')
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(p.sla_policies) AS policy
            WHERE policy->>'priority' = r.priority::text
              AND r.created_at + (policy->>'responseTimeMinutes')::int * interval '1 minute' < now()
          )
      `),

      // Recent requests (last 10 across all projects)
      db
        .select({
          id: requests.id,
          title: requests.title,
          status: requests.status,
          priority: requests.priority,
          projectId: requests.projectId,
          createdAt: requests.createdAt,
        })
        .from(requests)
        .where(inArray(requests.projectId, projectIds))
        .orderBy(desc(requests.createdAt))
        .limit(10),

      // Per-project counts (LEFT JOIN so projects with no requests are included)
      db.execute(sql`
        SELECT
          p.id                                                                                         AS "projectId",
          COUNT(r.id) FILTER (WHERE r.status = 'open')::int                                           AS "openCount",
          COUNT(r.id) FILTER (WHERE r.status = 'in_progress')::int                                    AS "inProgressCount",
          COUNT(r.id) FILTER (WHERE r.status NOT IN ('closed'))::int                                  AS "activeCount",
          COUNT(r.id) FILTER (WHERE r.status = 'resolved' AND r.resolved_at >= ${todayStart})::int    AS "resolvedTodayCount",
          COUNT(r.id) FILTER (
            WHERE r.status IN ('open', 'in_progress')
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(p.sla_policies) AS policy
                WHERE policy->>'priority' = r.priority::text
                  AND r.created_at + (policy->>'responseTimeMinutes')::int * interval '1 minute' < now()
              )
          )::int                                                                                       AS "slaBreachCount"
        FROM projects p
        LEFT JOIN requests r ON r.project_id = p.id
        WHERE p.org_id = ${orgId}
        GROUP BY p.id
      `),
    ]);

    // Build project name map
    const projectMap = Object.fromEntries(orgProjects.map((p) => [p.id, p.name]));

    // Annotate recent requests with project name
    const recentRequests = recentRows.map((r) => ({
      ...r,
      projectName: projectMap[r.projectId] ?? 'Unknown',
    }));

    // Annotate project summary with names
    const projectSummary = (summaryRows.rows as Array<{
      projectId: string;
      openCount: number;
      inProgressCount: number;
      activeCount: number;
      resolvedTodayCount: number;
      slaBreachCount: number;
    }>)
      .map((row) => ({ ...row, projectName: projectMap[row.projectId] ?? 'Unknown' }))
      .sort((a, b) => b.activeCount - a.activeCount);

    res.json({
      openCount:         openRow[0]?.count         ?? 0,
      inProgressCount:   inProgressRow[0]?.count   ?? 0,
      resolvedTodayCount: resolvedTodayRow[0]?.count ?? 0,
      slaBreachCount: (slaBreachRow.rows[0] as { count: number } | undefined)?.count ?? 0,
      recentRequests,
      projectSummary,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /dashboard/query — execute an org-scoped read-only query ─────────────

router.post('/query', async (req, res, next) => {
  try {
    const { query } = z.object({ query: z.string().min(1).max(10_000) }).parse(req.body);

    const validationError = validateQuerySQL(query);
    if (validationError) {
      res.status(400).json({ error: 'INVALID_QUERY', message: validationError });
      return;
    }

    const result = await runOrgQuery(query, req.user!.orgId);
    res.json(result);
  } catch (err: unknown) {
    // Surface the pg error message to the user — it's helpful (e.g. column not found)
    const pgMsg = (err as { message?: string })?.message;
    res.status(400).json({ error: 'QUERY_ERROR', message: pgMsg ?? 'Query failed.' });
  }
});

// ── Dashboard layout CRUD ─────────────────────────────────────────────────────

const widgetSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'stat_open',
    'stat_in_progress',
    'stat_resolved_today',
    'stat_sla_breaches',
    'recent_requests',
    'project_summary',
    'custom_query',
  ]),
  title: z.string().max(100).optional(),
  colspan: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  filters: z.object({
    projectIds: z.array(z.string().uuid()).optional(),
    statuses:   z.array(z.enum(['open', 'in_progress', 'pending_user', 'resolved', 'closed'])).optional(),
    priorities: z.array(z.enum(['critical', 'high', 'medium', 'low'])).optional(),
    limit:      z.number().int().min(1).max(50).optional(),
  }).optional(),
  query: z.string().max(10_000).optional(),
  chartConfig: z.object({
    chartType:  z.enum(['bar', 'line', 'area', 'pie']),
    xKey:       z.string().min(1).max(100),
    yKeys:      z.array(z.string().min(1).max(100)).min(1).max(10),
    horizontal: z.boolean().optional(),
  }).optional(),
});

const layoutConfigSchema = z.object({
  widgets: z.array(widgetSchema).max(20),
});

// GET /dashboard/layouts — list this user's layouts
router.get('/layouts', async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, req.user!.id))
      .orderBy(dashboardLayouts.createdAt);

    res.json(rows);
  } catch (err) { next(err); }
});

// POST /dashboard/layouts — create a layout
router.post('/layouts', async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().min(1).max(100),
      isDefault: z.boolean().default(false),
      config: layoutConfigSchema,
    }).parse(req.body);

    // If setting as default, clear other defaults first
    if (body.isDefault) {
      await db
        .update(dashboardLayouts)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(dashboardLayouts.userId, req.user!.id));
    }

    const [layout] = await db
      .insert(dashboardLayouts)
      .values({
        userId: req.user!.id,
        orgId: req.user!.orgId,
        name: body.name,
        isDefault: body.isDefault,
        config: body.config as unknown as DashboardLayoutConfig,
      })
      .returning();

    res.status(201).json(layout);
  } catch (err) { next(err); }
});

// PATCH /dashboard/layouts/:id — update a layout
router.patch('/layouts/:id', async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().min(1).max(100).optional(),
      isDefault: z.boolean().optional(),
      config: layoutConfigSchema.optional(),
    }).parse(req.body);

    // If setting as default, clear others first
    if (body.isDefault === true) {
      await db
        .update(dashboardLayouts)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(dashboardLayouts.userId, req.user!.id));
    }

    const updates: Partial<typeof dashboardLayouts.$inferInsert> & { updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (body.name !== undefined)      updates.name      = body.name;
    if (body.isDefault !== undefined) updates.isDefault = body.isDefault;
    if (body.config !== undefined)    updates.config    = body.config as unknown as DashboardLayoutConfig;

    const [updated] = await db
      .update(dashboardLayouts)
      .set(updates)
      .where(
        and(
          eq(dashboardLayouts.id, req.params['id'] as string),
          eq(dashboardLayouts.userId, req.user!.id),
        ),
      )
      .returning();

    if (!updated) { next(Errors.notFound('Layout')); return; }
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /dashboard/layouts/:id — delete a layout
router.delete('/layouts/:id', async (req, res, next) => {
  try {
    const [deleted] = await db
      .delete(dashboardLayouts)
      .where(
        and(
          eq(dashboardLayouts.id, req.params['id'] as string),
          eq(dashboardLayouts.userId, req.user!.id),
        ),
      )
      .returning({ id: dashboardLayouts.id, isDefault: dashboardLayouts.isDefault });

    if (!deleted) { next(Errors.notFound('Layout')); return; }

    // If we deleted the default, promote the most recent remaining layout to default
    if (deleted.isDefault) {
      const [next_] = await db
        .select({ id: dashboardLayouts.id })
        .from(dashboardLayouts)
        .where(eq(dashboardLayouts.userId, req.user!.id))
        .orderBy(desc(dashboardLayouts.createdAt))
        .limit(1);

      if (next_) {
        await db
          .update(dashboardLayouts)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(dashboardLayouts.id, next_.id));
      }
    }

    res.status(204).send();
  } catch (err) { next(err); }
});

export { router as dashboardRouter };
