/**
 * Request templates — pre-filled ticket forms per project.
 * Mounted at /projects/:projectId/templates.
 */
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requestTemplates } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { Errors } from '../lib/errors.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

const templateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  title: z.string().max(500).default(''),
  body: z.string().default(''),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  customFields: z.record(z.unknown()).default({}),
});

// GET /projects/:projectId/templates
router.get('/', requireProjectPermission('requests.view'), async (req, res, next) => {
  try {
    const rows = await db.select().from(requestTemplates)
      .where(eq(requestTemplates.projectId, req.params['projectId'] as string));
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /projects/:projectId/templates
router.post('/', requireProjectPermission('project.manage_settings'), async (req, res, next) => {
  try {
    const body = templateSchema.parse(req.body);
    const [created] = await db.insert(requestTemplates).values({
      projectId: req.params['projectId'] as string,
      ...body,
      description: body.description ?? null,
      category: body.category ?? null,
      subcategory: body.subcategory ?? null,
    }).returning();
    res.status(201).json(created);
  } catch (err) { next(err); }
});

// PATCH /projects/:projectId/templates/:id
router.patch('/:id', requireProjectPermission('project.manage_settings'), async (req, res, next) => {
  try {
    const body = templateSchema.partial().parse(req.body);
    const [updated] = await db.update(requestTemplates)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(requestTemplates.id, req.params['id'] as string))
      .returning();
    if (!updated) { next(Errors.notFound('Template')); return; }
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /projects/:projectId/templates/:id
router.delete('/:id', requireProjectPermission('project.manage_settings'), async (req, res, next) => {
  try {
    const [deleted] = await db.delete(requestTemplates)
      .where(eq(requestTemplates.id, req.params['id'] as string))
      .returning({ id: requestTemplates.id });
    if (!deleted) { next(Errors.notFound('Template')); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export { router as templatesRouter };
