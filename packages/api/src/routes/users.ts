import { Router } from 'express';
import { db } from '../db/client.js';
import { users, projectMembers, roles } from '../db/schema.js';
import { eq, and, notLike, isNull } from 'drizzle-orm';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { Errors } from '../lib/errors.js';
import { z } from 'zod';

const router = Router();
router.use(requireAuth);

// Internal system accounts (AI agent, automation) use this email domain. They
// author comments but are not real people, so they're hidden from user lists.
const SYSTEM_EMAIL_PATTERN = '%@system.internal';

// GET /users/agents  — any authenticated user; returns id/name/role for all org members
// (used by the web UI to resolve assignee names and populate assignment dropdowns)
router.get('/agents', async (req, res, next) => {
  try {
    const members = await db
      .select({ id: users.id, name: users.name, email: users.email, globalRole: users.globalRole })
      .from(users)
      .where(eq(users.orgId, req.user!.orgId));
    res.json(members);
  } catch (err) {
    next(err);
  }
});

// GET /users  — admin only
router.get('/', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const all = await db
      .select({
        id: users.id,
        orgId: users.orgId,
        email: users.email,
        name: users.name,
        globalRole: users.globalRole,
        roleId: users.roleId,
        slackUserId: users.slackUserId,
        department: users.department,
        jobTitle: users.jobTitle,
        managerId: users.managerId,
        city: users.city,
        state: users.state,
        country: users.country,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(and(eq(users.orgId, req.user!.orgId), notLike(users.email, SYSTEM_EMAIL_PATTERN)));

    res.json(all);
  } catch (err) {
    next(err);
  }
});

// GET /users/me
router.get('/me', async (req, res, next) => {
  try {
    const [row] = await db
      .select({ totpEnabled: users.totpEnabled, emailPreferences: users.emailPreferences })
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);
    res.json({
      ...req.user,
      totpEnabled: row?.totpEnabled ?? false,
      emailPreferences: row?.emailPreferences ?? {},
    });
  } catch (err) { next(err); }
});

// PATCH /users/me/preferences — update email notification opt-ins for current user
router.patch('/me/preferences', async (req, res, next) => {
  try {
    const prefs = z.object({
      ticketCreated:    z.boolean().optional(),
      agentReplied:     z.boolean().optional(),
      ticketResolved:   z.boolean().optional(),
      assigned:         z.boolean().optional(),
      requesterReplied: z.boolean().optional(),
    }).parse(req.body);

    const [row] = await db.select({ emailPreferences: users.emailPreferences })
      .from(users).where(eq(users.id, req.user!.id)).limit(1);
    const current = (row?.emailPreferences ?? {}) as Record<string, unknown>;
    const merged = { ...current, ...prefs };

    await db.update(users)
      .set({ emailPreferences: merged, updatedAt: new Date() })
      .where(eq(users.id, req.user!.id));
    res.json(merged);
  } catch (err) { next(err); }
});

// PATCH /users/:userId/role  — assign a global role (built-in or custom).
// Accepts { roleId } (preferred) or { globalRole } (built-in key, back-compat).
router.patch(
  '/:userId/role',
  requirePermission('users.assign_roles'),
  async (req, res, next) => {
    try {
      const body = z.object({
        roleId: z.string().uuid().optional(),
        globalRole: z.enum(['super_admin', 'admin', 'agent', 'viewer', 'customer']).optional(),
      }).parse(req.body);

      // Resolve the target global role row (validate same-org + scope=global).
      let role;
      if (body.roleId) {
        [role] = await db.select().from(roles)
          .where(and(eq(roles.id, body.roleId), eq(roles.orgId, req.user!.orgId), eq(roles.scope, 'global'), isNull(roles.projectId)))
          .limit(1);
      } else if (body.globalRole) {
        [role] = await db.select().from(roles)
          .where(and(eq(roles.orgId, req.user!.orgId), eq(roles.scope, 'global'), eq(roles.isBuiltin, true), isNull(roles.projectId), eq(roles.key, body.globalRole)))
          .limit(1);
      } else {
        next(Errors.badRequest('roleId or globalRole is required.'));
        return;
      }
      if (!role) { next(Errors.badRequest('Role not found in this organization.')); return; }

      const [updated] = await db
        .update(users)
        // Set roleId (RBAC) and mirror globalRole = the role's baseTier.
        .set({ roleId: role.id, globalRole: role.baseTier as 'super_admin' | 'admin' | 'agent' | 'viewer' | 'customer', updatedAt: new Date() })
        .where(
          and(eq(users.id, req.params['userId'] as string), eq(users.orgId, req.user!.orgId)),
        )
        .returning({ id: users.id, email: users.email, globalRole: users.globalRole, roleId: users.roleId });

      if (!updated) {
        next(Errors.notFound('User'));
        return;
      }

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /users/:userId/profile  — admin: edit profile fields (department, title, manager, location)
router.patch('/:userId/profile', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const body = z.object({
      department: z.string().max(120).nullable().optional(),
      jobTitle: z.string().max(120).nullable().optional(),
      managerId: z.string().uuid().nullable().optional(),
      city: z.string().max(120).nullable().optional(),
      state: z.string().max(120).nullable().optional(),
      country: z.string().max(120).nullable().optional(),
    }).parse(req.body);

    // Guard: manager must be a real user in the same org, and not the user themselves.
    if (body.managerId) {
      if (body.managerId === req.params['userId']) { next(Errors.badRequest('A user cannot be their own manager.')); return; }
      const [mgr] = await db.select({ id: users.id }).from(users)
        .where(and(eq(users.id, body.managerId), eq(users.orgId, req.user!.orgId))).limit(1);
      if (!mgr) { next(Errors.badRequest('Manager must be a user in this organization.')); return; }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ['department', 'jobTitle', 'managerId', 'city', 'state', 'country'] as const) {
      if (body[k] !== undefined) updates[k] = body[k];
    }

    const [updated] = await db.update(users).set(updates)
      .where(and(eq(users.id, req.params['userId'] as string), eq(users.orgId, req.user!.orgId)))
      .returning();
    if (!updated) { next(Errors.notFound('User')); return; }
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /projects/:projectId/members  — project admin
router.post('/projects/:projectId/members', async (req, res, next) => {
  try {
    const body = z.object({
      userId: z.string().uuid(),
      role: z.enum(['admin', 'agent', 'viewer', 'customer']),
    }).parse(req.body);

    const [member] = await db
      .insert(projectMembers)
      .values({ projectId: req.params['projectId'] as string, userId: body.userId, role: body.role })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: body.role },
      })
      .returning();

    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
});

export { router as usersRouter };
