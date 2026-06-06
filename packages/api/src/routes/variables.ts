/**
 * Global variables manager routes.
 * All routes gated with requirePermission('org.manage_settings').
 *
 * GET    /variables       — list all
 * POST   /variables       — create
 * PUT    /variables/:id   — update
 * DELETE /variables/:id   — delete
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { orgVariables } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { Errors } from '../lib/errors.js';

const NAME_RE = /^[A-Z0-9_]+$/;

const router = Router();
router.use(requireAuth);
router.use(requirePermission('org.manage_settings'));

// GET /variables
router.get('/', async (req, res, next) => {
  try {
    const rows = await db.select().from(orgVariables).where(eq(orgVariables.orgId, req.user!.orgId));
    res.json(rows.map(r => ({
      id: r.id,
      name: r.name,
      value: r.value,
      description: r.description,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })));
  } catch (err) { next(err); }
});

const createVariableSchema = z.object({
  name: z.string().min(1).max(128).regex(NAME_RE, 'Name must be uppercase letters, numbers, and underscores only'),
  value: z.string().max(10_000).default(''),
  description: z.string().max(500).default(''),
});

// POST /variables
router.post('/', async (req, res, next) => {
  try {
    const body = createVariableSchema.parse(req.body);
    const [row] = await db.insert(orgVariables)
      .values({ orgId: req.user!.orgId, name: body.name, value: body.value, description: body.description })
      .returning();
    res.status(201).json(row);
  } catch (err) { next(err); }
});

const updateVariableSchema = z.object({
  name: z.string().min(1).max(128).regex(NAME_RE).optional(),
  value: z.string().max(10_000).optional(),
  description: z.string().max(500).optional(),
});

// PUT /variables/:id
router.put('/:id', async (req, res, next) => {
  try {
    const body = updateVariableSchema.parse(req.body);
    const [existing] = await db.select({ id: orgVariables.id }).from(orgVariables)
      .where(and(eq(orgVariables.id, req.params['id']!), eq(orgVariables.orgId, req.user!.orgId)))
      .limit(1);
    if (!existing) { next(Errors.notFound('Variable')); return; }
    const updates: Partial<{ name: string; value: string; description: string; updatedAt: Date }> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.value !== undefined) updates.value = body.value;
    if (body.description !== undefined) updates.description = body.description;
    const [updated] = await db.update(orgVariables).set(updates).where(eq(orgVariables.id, existing.id)).returning();
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /variables/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const [row] = await db.select({ id: orgVariables.id }).from(orgVariables)
      .where(and(eq(orgVariables.id, req.params['id']!), eq(orgVariables.orgId, req.user!.orgId)))
      .limit(1);
    if (!row) { next(Errors.notFound('Variable')); return; }
    await db.delete(orgVariables).where(eq(orgVariables.id, row.id));
    res.status(204).send();
  } catch (err) { next(err); }
});

export { router as variablesRouter };
