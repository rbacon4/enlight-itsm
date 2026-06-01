import { Router } from 'express';
import { db } from '../db/client.js';
import { automationRules, automationRuns } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { Errors } from '../lib/errors.js';
import { z } from 'zod';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// ── Validation ─────────────────────────────────────────────────────────────────

/** Validates an IANA timezone string is one the runtime recognises. */
function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const triggerSchema = z.object({
  type: z.enum(['request_created', 'request_updated', 'comment_added', 'time_based']),
  metric: z.enum(['hours_since_created', 'hours_since_updated']).optional(),
  hours: z.number().min(0).max(8760).optional(),
  timezone: z.string().max(64).refine(isValidTimezone, 'Unknown timezone').optional(),
  activeFromHour: z.number().int().min(0).max(23).optional(),
  activeToHour: z.number().int().min(0).max(23).optional(),
  activeDays: z.array(z.enum(WEEKDAYS)).max(7).optional(),
}).refine((t) => t.type !== 'time_based' || (t.metric && typeof t.hours === 'number'), {
  message: 'time_based triggers require metric and hours',
});

const conditionSchema = z.object({
  field: z.enum([
    'status', 'priority', 'category', 'subcategory', 'assigneeId', 'title', 'description',
    'comment_body', 'comment_is_internal', 'comment_hour', 'comment_weekday',
  ]),
  op: z.enum(['eq', 'neq', 'contains', 'in', 'is_empty', 'is_not_empty', 'gt', 'lt', 'gte', 'lte']),
  value: z.union([z.string(), z.array(z.string())]).optional(),
});

const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set_fields'),
    status: z.enum(['open', 'in_progress', 'pending_user', 'resolved', 'closed']).optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    assigneeId: z.string().optional(),
    category: z.string().optional(),
  }),
  z.object({ type: z.literal('add_comment'), body: z.string().min(1).max(5000), isInternal: z.boolean().optional() }),
  z.object({ type: z.literal('notify_slack'), target: z.string().min(1).max(50), message: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('trigger_ai') }),
  z.object({
    type: z.literal('http_request'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    url: z.string().url().max(2000),
    headers: z.record(z.string()).optional(),
    body: z.string().max(10_000).optional(),
  }),
]);

const ruleBodySchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).max(20).default([]),
  actions: z.array(actionSchema).min(1).max(20),
});

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /projects/:projectId/automations
router.get('/', requireProjectPermission('automations.view'), async (req, res, next) => {
  try {
    const rows = await db.select().from(automationRules)
      .where(eq(automationRules.projectId, req.params['projectId'] as string))
      .orderBy(desc(automationRules.createdAt));
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /projects/:projectId/automations
router.post('/', requireProjectPermission('automations.manage'), async (req, res, next) => {
  try {
    const body = ruleBodySchema.parse(req.body);
    const [rule] = await db.insert(automationRules).values({
      projectId: req.params['projectId'] as string,
      name: body.name,
      enabled: body.enabled,
      trigger: body.trigger,
      conditions: body.conditions,
      actions: body.actions,
    }).returning();
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

// PATCH /projects/:projectId/automations/:id
router.patch('/:id', requireProjectPermission('automations.manage'), async (req, res, next) => {
  try {
    const body = ruleBodySchema.partial().parse(req.body);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined)       updates['name'] = body.name;
    if (body.enabled !== undefined)    updates['enabled'] = body.enabled;
    if (body.trigger !== undefined)    updates['trigger'] = body.trigger;
    if (body.conditions !== undefined) updates['conditions'] = body.conditions;
    if (body.actions !== undefined)    updates['actions'] = body.actions;

    const [updated] = await db.update(automationRules).set(updates)
      .where(and(
        eq(automationRules.id, req.params['id'] as string),
        eq(automationRules.projectId, req.params['projectId'] as string),
      )).returning();
    if (!updated) { next(Errors.notFound('Automation rule')); return; }
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /projects/:projectId/automations/:id
router.delete('/:id', requireProjectPermission('automations.manage'), async (req, res, next) => {
  try {
    const [deleted] = await db.delete(automationRules)
      .where(and(
        eq(automationRules.id, req.params['id'] as string),
        eq(automationRules.projectId, req.params['projectId'] as string),
      )).returning({ id: automationRules.id });
    if (!deleted) { next(Errors.notFound('Automation rule')); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /projects/:projectId/automations/:id/runs — recent execution history
router.get('/:id/runs', requireProjectPermission('automations.view'), async (req, res, next) => {
  try {
    const rows = await db.select().from(automationRuns)
      .where(eq(automationRuns.ruleId, req.params['id'] as string))
      .orderBy(desc(automationRuns.createdAt))
      .limit(50);
    res.json(rows);
  } catch (err) { next(err); }
});

export { router as automationsRouter };
