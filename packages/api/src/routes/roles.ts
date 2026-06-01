/**
 * Role management — global roles + the org's shared built-in project roles.
 * Per-project custom roles are managed under /projects/:projectId/roles.
 *
 * Listing is available to anyone who manages users/roles (to populate pickers);
 * mutations require `roles.manage` (super_admin by default).
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { roles, users } from '../db/schema.js';
import { and, eq, isNull, count } from 'drizzle-orm';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { Errors } from '../lib/errors.js';
import {
  GLOBAL_PERMISSIONS,
  PROJECT_PERMISSIONS,
  ALL_GLOBAL_PERMISSIONS,
  ALL_PROJECT_PERMISSIONS,
} from '@enlight/shared';

const router = Router();
router.use(requireAuth);

const GLOBAL_TIERS = ['super_admin', 'admin', 'agent', 'viewer', 'customer'] as const;

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'role';
}

// GET /roles/catalog — the full permission catalog for the UI.
router.get('/catalog', (_req, res) => {
  res.json({ global: GLOBAL_PERMISSIONS, project: PROJECT_PERMISSIONS });
});

// GET /roles?scope=global|project — list org roles (projectId IS NULL).
router.get('/', requirePermission('users.manage', 'roles.manage', 'users.assign_roles'), async (req, res, next) => {
  try {
    const scope = req.query['scope'] === 'project' ? 'project' : 'global';
    const list = await db
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, req.user!.orgId), eq(roles.scope, scope), isNull(roles.projectId)));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(300).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  baseTier: z.enum(GLOBAL_TIERS).default('agent'),
  permissions: z.array(z.string()).default([]),
});

// POST /roles — create a global custom role.
router.post('/', requirePermission('roles.manage'), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const invalid = body.permissions.filter((p) => !ALL_GLOBAL_PERMISSIONS.includes(p));
    if (invalid.length) { next(Errors.badRequest(`Unknown permissions: ${invalid.join(', ')}`)); return; }

    // Custom roles never grant the protected super_admin tier.
    const baseTier = body.baseTier === 'super_admin' ? 'admin' : body.baseTier;
    let key = slugify(body.name);
    const existing = await db.select({ key: roles.key }).from(roles)
      .where(and(eq(roles.orgId, req.user!.orgId), eq(roles.scope, 'global'), isNull(roles.projectId)));
    const keys = new Set(existing.map((r) => r.key));
    if (keys.has(key)) { let i = 2; while (keys.has(`${key}_${i}`)) i++; key = `${key}_${i}`; }

    const [role] = await db.insert(roles).values({
      orgId: req.user!.orgId, scope: 'global', projectId: null, key,
      name: body.name, description: body.description ?? null, color: body.color ?? '#6366f1',
      baseTier, permissions: body.permissions, isBuiltin: false, protected: false,
    }).returning();
    res.status(201).json(role);
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(300).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  permissions: z.array(z.string()).optional(),
});

// PATCH /roles/:id — update a global role or shared built-in project role.
router.patch('/:id', requirePermission('roles.manage'), async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const [role] = await db.select().from(roles)
      .where(and(eq(roles.id, req.params['id'] as string), eq(roles.orgId, req.user!.orgId), isNull(roles.projectId)))
      .limit(1);
    if (!role) { next(Errors.notFound('Role')); return; }
    if (role.protected) { next(Errors.badRequest('The Super Admin role is protected and cannot be modified.')); return; }

    if (body.permissions) {
      const allowed = role.scope === 'global' ? ALL_GLOBAL_PERMISSIONS : ALL_PROJECT_PERMISSIONS;
      const invalid = body.permissions.filter((p) => !allowed.includes(p));
      if (invalid.length) { next(Errors.badRequest(`Unknown permissions: ${invalid.join(', ')}`)); return; }
    }

    const [updated] = await db.update(roles).set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
      updatedAt: new Date(),
    }).where(eq(roles.id, role.id)).returning();
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /roles/:id — delete a custom global role (not built-in, not assigned).
router.delete('/:id', requirePermission('roles.manage'), async (req, res, next) => {
  try {
    const [role] = await db.select().from(roles)
      .where(and(eq(roles.id, req.params['id'] as string), eq(roles.orgId, req.user!.orgId)))
      .limit(1);
    if (!role) { next(Errors.notFound('Role')); return; }
    if (role.isBuiltin || role.protected) { next(Errors.badRequest('Built-in roles cannot be deleted.')); return; }

    const [{ value: assigned } = { value: 0 }] = await db
      .select({ value: count() }).from(users).where(eq(users.roleId, role.id));
    if (Number(assigned) > 0) {
      next(Errors.badRequest(`This role is assigned to ${assigned} user(s). Reassign them before deleting.`));
      return;
    }
    await db.delete(roles).where(eq(roles.id, role.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export { router as rolesRouter };
