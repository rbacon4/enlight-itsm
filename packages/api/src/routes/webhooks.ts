/**
 * Outbound webhook CRUD — mounted at /org/webhooks.
 * Only org managers may create/edit/delete webhooks.
 */
import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { db } from '../db/client.js';
import { webhooks, webhookDeliveries } from '../db/schema.js';
import { eq, sql, desc } from 'drizzle-orm';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { Errors } from '../lib/errors.js';

const router = Router();
router.use(requireAuth);

const WEBHOOK_EVENTS = [
  'request.created',
  'request.updated',
  'request.resolved',
  'comment.added',
] as const;

const webhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(WEBHOOK_EVENTS)).default([]),
  description: z.string().max(255).optional(),
  active: z.boolean().default(true),
});

// Row scope — scoped to this org + this id
const scope = (id: string, orgId: string) =>
  sql`id = ${id} AND org_id = ${orgId}`;

// GET /org/webhooks
router.get('/', async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.orgId, req.user!.orgId));
    res.json(rows.map((h) => ({ ...h, secret: undefined, secretConfigured: true })));
  } catch (err) { next(err); }
});

// POST /org/webhooks
router.post('/', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const body = webhookSchema.parse(req.body);
    const secret = crypto.randomBytes(32).toString('hex');
    const [created] = await db.insert(webhooks).values({
      orgId: req.user!.orgId,
      url: body.url,
      events: body.events,
      description: body.description ?? null,
      active: body.active,
      secret,
    }).returning();
    res.status(201).json(created); // secret returned once on creation
  } catch (err) { next(err); }
});

// PATCH /org/webhooks/:id
router.patch('/:id', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const body = webhookSchema.partial().parse(req.body);
    const [updated] = await db.update(webhooks)
      .set({ ...body, updatedAt: new Date() })
      .where(scope(req.params['id'] as string, req.user!.orgId))
      .returning();
    if (!updated) { next(Errors.notFound('Webhook')); return; }
    res.json({ ...updated, secret: undefined, secretConfigured: true });
  } catch (err) { next(err); }
});

// POST /org/webhooks/:id/rotate-secret
router.post('/:id/rotate-secret', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const secret = crypto.randomBytes(32).toString('hex');
    const [updated] = await db.update(webhooks)
      .set({ secret, updatedAt: new Date() })
      .where(scope(req.params['id'] as string, req.user!.orgId))
      .returning();
    if (!updated) { next(Errors.notFound('Webhook')); return; }
    res.json({ ...updated });
  } catch (err) { next(err); }
});

// DELETE /org/webhooks/:id
router.delete('/:id', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const [deleted] = await db.delete(webhooks)
      .where(scope(req.params['id'] as string, req.user!.orgId))
      .returning();
    if (!deleted) { next(Errors.notFound('Webhook')); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /org/webhooks/:id/deliveries — last 50 delivery attempts for this hook
router.get('/:id/deliveries', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(sql`webhook_id = ${req.params['id'] as string}`)
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(50);
    res.json(rows);
  } catch (err) { next(err); }
});

export { router as webhooksRouter };
