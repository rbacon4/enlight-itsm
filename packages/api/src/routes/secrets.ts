/**
 * Centralized secrets manager routes.
 * All routes are gated with requirePermission('org.manage_settings').
 *
 * GET    /secrets                — list (values always redacted, last 4 chars only)
 * POST   /secrets                — create
 * PUT    /secrets/:id            — update (blank value keeps existing)
 * DELETE /secrets/:id            — delete
 * POST   /secrets/:id/reveal     — returns decrypted value (requires body: { confirm: true })
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { orgSecrets } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { encryptSecret, decryptSecret } from '../lib/secretCrypto.js';
import { Errors } from '../lib/errors.js';

const NAME_RE = /^[A-Z0-9_]+$/;

const router = Router();
router.use(requireAuth);
router.use(requirePermission('org.manage_settings'));

function redactValue(encrypted: string): string {
  const plain = decryptSecret(encrypted);
  if (!plain || plain.length <= 4) return '••••';
  return `••••${plain.slice(-4)}`;
}

// GET /secrets
router.get('/', async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(orgSecrets)
      .where(eq(orgSecrets.orgId, req.user!.orgId));
    res.json(rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      valuePreview: redactValue(r.value),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastUsedAt: r.lastUsedAt,
    })));
  } catch (err) { next(err); }
});

const createSecretSchema = z.object({
  name: z.string().min(1).max(128).regex(NAME_RE, 'Name must be uppercase letters, numbers, and underscores only'),
  description: z.string().max(500).default(''),
  value: z.string().min(1, 'Value is required'),
});

// POST /secrets
router.post('/', async (req, res, next) => {
  try {
    const body = createSecretSchema.parse(req.body);
    const encrypted = encryptSecret(body.value);
    const [row] = await db
      .insert(orgSecrets)
      .values({ orgId: req.user!.orgId, name: body.name, description: body.description, value: encrypted })
      .returning();
    res.status(201).json({ id: row!.id, name: row!.name, description: row!.description, createdAt: row!.createdAt });
  } catch (err) { next(err); }
});

const updateSecretSchema = z.object({
  name: z.string().min(1).max(128).regex(NAME_RE).optional(),
  description: z.string().max(500).optional(),
  value: z.string().optional(), // blank = keep existing
});

// PUT /secrets/:id
router.put('/:id', async (req, res, next) => {
  try {
    const body = updateSecretSchema.parse(req.body);
    const [existing] = await db.select().from(orgSecrets)
      .where(and(eq(orgSecrets.id, req.params['id']!), eq(orgSecrets.orgId, req.user!.orgId)))
      .limit(1);
    if (!existing) { next(Errors.notFound('Secret')); return; }

    const updates: Partial<typeof existing> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.value && body.value.trim()) {
      updates.value = encryptSecret(body.value);
    }

    const [updated] = await db.update(orgSecrets).set(updates).where(eq(orgSecrets.id, existing.id)).returning();
    res.json({ id: updated!.id, name: updated!.name, description: updated!.description, updatedAt: updated!.updatedAt });
  } catch (err) { next(err); }
});

// DELETE /secrets/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const [row] = await db.select({ id: orgSecrets.id }).from(orgSecrets)
      .where(and(eq(orgSecrets.id, req.params['id']!), eq(orgSecrets.orgId, req.user!.orgId)))
      .limit(1);
    if (!row) { next(Errors.notFound('Secret')); return; }
    await db.delete(orgSecrets).where(eq(orgSecrets.id, row.id));
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /secrets/:id/reveal
router.post('/:id/reveal', async (req, res, next) => {
  try {
    const { confirm } = z.object({ confirm: z.literal(true) }).parse(req.body);
    if (!confirm) { res.status(400).json({ error: 'CONFIRM_REQUIRED', message: 'Pass { confirm: true } to reveal' }); return; }
    const [row] = await db.select().from(orgSecrets)
      .where(and(eq(orgSecrets.id, req.params['id']!), eq(orgSecrets.orgId, req.user!.orgId)))
      .limit(1);
    if (!row) { next(Errors.notFound('Secret')); return; }
    // Update lastUsedAt
    await db.update(orgSecrets).set({ lastUsedAt: new Date() }).where(eq(orgSecrets.id, row.id));
    res.json({ value: decryptSecret(row.value) });
  } catch (err) { next(err); }
});

export { router as secretsRouter };
