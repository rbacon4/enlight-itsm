import { Router } from 'express';
import { db } from '../db/client.js';
import { oncallSchedules } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { Errors } from '../lib/errors.js';
import { z } from 'zod';
import { computeOnCall } from '../lib/oncall.js';
import type { OnCallSchedule } from '@enlight/shared';

const router = Router({ mergeParams: true });
router.use(requireAuth);

function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const scheduleSchema = z.object({
  name: z.string().min(1).max(120),
  timezone: z.string().max(64).refine(isValidTimezone, 'Unknown timezone'),
  rotationDays: z.number().int().min(1).max(365),
  handoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'handoffTime must be HH:MM'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
  participants: z.array(z.string().uuid()).max(50).default([]),
});

/** Attaches computed current-on-call fields to a schedule row. */
function withComputed(row: typeof oncallSchedules.$inferSelect): OnCallSchedule {
  const computed = computeOnCall(row as unknown as OnCallSchedule);
  return { ...(row as unknown as OnCallSchedule), ...computed };
}

// GET /projects/:projectId/oncall
router.get('/', requireProjectPermission('oncall.view'), async (req, res, next) => {
  try {
    const rows = await db.select().from(oncallSchedules)
      .where(eq(oncallSchedules.projectId, req.params['projectId'] as string))
      .orderBy(desc(oncallSchedules.createdAt));
    res.json(rows.map(withComputed));
  } catch (err) { next(err); }
});

// POST /projects/:projectId/oncall
router.post('/', requireProjectPermission('oncall.manage'), async (req, res, next) => {
  try {
    const body = scheduleSchema.parse(req.body);
    const [row] = await db.insert(oncallSchedules).values({
      projectId: req.params['projectId'] as string,
      name: body.name,
      timezone: body.timezone,
      rotationDays: body.rotationDays,
      handoffTime: body.handoffTime,
      startDate: body.startDate,
      participants: body.participants,
    }).returning();
    res.status(201).json(withComputed(row!));
  } catch (err) { next(err); }
});

// PATCH /projects/:projectId/oncall/:id
router.patch('/:id', requireProjectPermission('oncall.manage'), async (req, res, next) => {
  try {
    const body = scheduleSchema.partial().parse(req.body);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ['name', 'timezone', 'rotationDays', 'handoffTime', 'startDate', 'participants'] as const) {
      if (body[k] !== undefined) updates[k] = body[k];
    }
    const [row] = await db.update(oncallSchedules).set(updates)
      .where(and(
        eq(oncallSchedules.id, req.params['id'] as string),
        eq(oncallSchedules.projectId, req.params['projectId'] as string),
      )).returning();
    if (!row) { next(Errors.notFound('Schedule')); return; }
    res.json(withComputed(row));
  } catch (err) { next(err); }
});

// DELETE /projects/:projectId/oncall/:id
router.delete('/:id', requireProjectPermission('oncall.manage'), async (req, res, next) => {
  try {
    const [row] = await db.delete(oncallSchedules)
      .where(and(
        eq(oncallSchedules.id, req.params['id'] as string),
        eq(oncallSchedules.projectId, req.params['projectId'] as string),
      )).returning({ id: oncallSchedules.id });
    if (!row) { next(Errors.notFound('Schedule')); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export { router as oncallRouter };
