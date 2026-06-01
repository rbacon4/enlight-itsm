import { Router } from 'express';
import { db } from '../db/client.js';
import { projects, projectMembers, users, roles } from '../db/schema.js';
import { eq, and, isNull, or, count } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { resolveProjectPermissions } from '../lib/permissions.js';
import { Errors } from '../lib/errors.js';
import { projectKey as deriveKey, normaliseKey, ALL_PROJECT_PERMISSIONS } from '@enlight/shared';
import type { ProjectRole } from '@enlight/shared';

/** Resolve a project role row usable in a project: a shared built-in (projectId null) or this project's custom role. */
async function resolveProjectRoleRow(orgId: string, projectId: string, roleId?: string, key?: string) {
  if (roleId) {
    const [r] = await db.select().from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.orgId, orgId), eq(roles.scope, 'project'),
        or(isNull(roles.projectId), eq(roles.projectId, projectId))))
      .limit(1);
    return r;
  }
  if (key) {
    const [r] = await db.select().from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.scope, 'project'), eq(roles.isBuiltin, true), isNull(roles.projectId), eq(roles.key, key)))
      .limit(1);
    return r;
  }
  return undefined;
}

/** Normalise allowedSlackUserGroups — handles legacy string[] and new {id,role}[] format. */
function normalizeGroups(raw: unknown[]): Array<{ id: string; role: ProjectRole }> {
  return raw.filter(Boolean).map(item =>
    typeof item === 'string'
      ? { id: item, role: 'customer' as ProjectRole }
      : { id: (item as { id: string; role: ProjectRole }).id, role: (item as { id: string; role: ProjectRole }).role ?? 'customer' as ProjectRole },
  );
}
import { z } from 'zod';

const router = Router();
router.use(requireAuth);

/** 2–6 uppercase alphanumeric characters */
const keySchema = z
  .string()
  .min(2)
  .max(6)
  .regex(/^[A-Z0-9]+$/, 'Key must be 2–6 uppercase letters or numbers');

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  key: keySchema.optional(), // auto-derived from slug if omitted
  description: z.string().optional(),
  aiModel: z.enum(['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']).default('claude-sonnet-4-5'),
  aiInstructions: z.string().optional(),
});

// GET /projects
router.get('/', async (req, res, next) => {
  try {
    const user = req.user!;

    if (user.globalRole === 'super_admin' || user.globalRole === 'admin') {
      const all = await db
        .select()
        .from(projects)
        .where(eq(projects.orgId, user.orgId));
      res.json(all);
      return;
    }

    // Return only projects the user is a member of
    const memberships = await db
      .select({ project: projects })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(
        and(
          eq(projectMembers.userId, user.id),
          eq(projects.orgId, user.orgId),
        ),
      );

    res.json(memberships.map((m) => m.project));
  } catch (err) {
    next(err);
  }
});

// POST /projects
router.post('/', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.permissions.includes('projects.create')) {
      next(Errors.forbidden());
      return;
    }

    const body = createProjectSchema.parse(req.body);

    // Use provided key or derive from slug; normalise just in case
    const key = body.key
      ? normaliseKey(body.key)
      : deriveKey(body.slug);

    const [project] = await db
      .insert(projects)
      .values({ ...body, key, orgId: user.orgId })
      .returning();

    if (!project) throw Errors.internal();

    // Creator becomes project admin
    const adminRole = await resolveProjectRoleRow(user.orgId, project.id, undefined, 'admin');
    await db.insert(projectMembers).values({
      projectId: project.id,
      userId: user.id,
      role: 'admin',
      roleId: adminRole?.id ?? null,
    });

    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId
router.get('/:projectId', requireProjectPermission('requests.view'), async (req, res, next) => {
  try {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, req.params['projectId'] as string))
      .limit(1);

    if (!project) {
      next(Errors.notFound('Project'));
      return;
    }

    res.json(project);
  } catch (err) {
    next(err);
  }
});

// PATCH /projects/:projectId
router.patch('/:projectId', requireProjectPermission('project.manage_settings'), async (req, res, next) => {
  try {
    const allowed = ['name', 'key', 'description', 'aiModel', 'aiInstructions',
      'aiAutonomousMode', 'slaPolicies', 'slaAlertConfig', 'categories',
      'customFields', 'defaultAssigneeId', 'slackQuickActions', 'status',
      'accessType', 'allowedSlackUserGroups', 'supportHours',
      'portalEnabled', 'portalToken'];
    const updates = Object.fromEntries(
      Object.entries(req.body as Record<string, unknown>).filter(([k]) => allowed.includes(k)),
    );

    // Validate and normalise key if it's being changed
    if (typeof updates['key'] === 'string') {
      const parsed = keySchema.safeParse(updates['key']);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Invalid key' });
        return;
      }
      updates['key'] = normaliseKey(updates['key'] as string);
    }

    const [updated] = await db
      .update(projects)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(projects.id, req.params['projectId'] as string))
      .returning();

    if (!updated) {
      next(Errors.notFound('Project'));
      return;
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/sync-user-groups
// Fetches members of every Slack user group configured on the project and
// adds them as project members (viewer role).  Existing roles are preserved.
router.post('/:projectId/sync-user-groups', requireProjectPermission('project.manage_settings'), async (req, res, next) => {
  try {
    const { projectId } = req.params as { projectId: string };

    const [project] = await db
      .select({ orgId: projects.orgId, allowedSlackUserGroups: projects.allowedSlackUserGroups })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) { next(Errors.notFound('Project')); return; }

    const { isSlackRunning } = await import('../slack/app.js');
    if (!isSlackRunning()) {
      res.status(503).json({ error: 'SLACK_NOT_RUNNING', message: 'Slack integration is not connected.' });
      return;
    }

    const { syncProjectUserGroupMembers } = await import('../slack/userSync.js');
    const groups = normalizeGroups((project.allowedSlackUserGroups as unknown[]) ?? []);
    const result = await syncProjectUserGroupMembers(projectId, project.orgId, groups);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Project members ───────────────────────────────────────────────────────────

// GET /projects/:projectId/members — list members with user details
router.get('/:projectId/members', requireProjectPermission('members.view'), async (req, res, next) => {
  try {
    const members = await db
      .select({
        projectId: projectMembers.projectId,
        userId: projectMembers.userId,
        role: projectMembers.role,
        roleId: projectMembers.roleId,
        createdAt: projectMembers.createdAt,
        userName: users.name,
        userEmail: users.email,
        userGlobalRole: users.globalRole,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, req.params['projectId'] as string));

    res.json(members.map((m) => ({
      projectId: m.projectId,
      userId: m.userId,
      role: m.role,
      roleId: m.roleId,
      createdAt: m.createdAt,
      user: { id: m.userId, name: m.userName, email: m.userEmail, globalRole: m.userGlobalRole },
    })));
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/members — add or update a member's role.
// Accepts { userId, roleId } (preferred) or { userId, role } (built-in key).
router.post('/:projectId/members', requireProjectPermission('members.manage'), async (req, res, next) => {
  try {
    const projectId = req.params['projectId'] as string;
    const body = z.object({
      userId: z.string().uuid(),
      roleId: z.string().uuid().optional(),
      role: z.enum(['admin', 'agent', 'viewer', 'customer']).optional(),
    }).parse(req.body);

    const role = await resolveProjectRoleRow(req.user!.orgId, projectId, body.roleId, body.role);
    if (!role) { next(Errors.badRequest('Role not found for this project.')); return; }
    const baseTier = role.baseTier as ProjectRole;

    const [member] = await db
      .insert(projectMembers)
      .values({ projectId, userId: body.userId, role: baseTier, roleId: role.id })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: baseTier, roleId: role.id },
      })
      .returning();

    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
});

// DELETE /projects/:projectId/members/:userId — remove a member
router.delete('/:projectId/members/:userId', requireProjectPermission('members.manage'), async (req, res, next) => {
  try {
    await db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, req.params['projectId'] as string),
          eq(projectMembers.userId, req.params['userId'] as string),
        ),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/permissions — the caller's resolved project permissions (for UI gating)
router.get('/:projectId/permissions', requireProjectPermission('requests.view'), async (req, res, next) => {
  try {
    const perms = await resolveProjectPermissions(req.user!.id, req.params['projectId'] as string, req.user!.permissions);
    res.json({ permissions: perms });
  } catch (err) {
    next(err);
  }
});

// ── Project roles (custom, per-project) ─────────────────────────────────────

// GET /projects/:projectId/roles — shared built-in project roles + this project's custom roles
router.get('/:projectId/roles', requireProjectPermission('members.view', 'project.manage_roles'), async (req, res, next) => {
  try {
    const projectId = req.params['projectId'] as string;
    const list = await db.select().from(roles)
      .where(and(eq(roles.orgId, req.user!.orgId), eq(roles.scope, 'project'),
        or(isNull(roles.projectId), eq(roles.projectId, projectId))));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

const projRoleBody = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(300).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  baseTier: z.enum(['admin', 'agent', 'viewer', 'customer']).default('agent'),
  permissions: z.array(z.string()).default([]),
});

// POST /projects/:projectId/roles — create a custom role for this project
router.post('/:projectId/roles', requireProjectPermission('project.manage_roles'), async (req, res, next) => {
  try {
    const projectId = req.params['projectId'] as string;
    const body = projRoleBody.parse(req.body);
    const invalid = body.permissions.filter((p) => !ALL_PROJECT_PERMISSIONS.includes(p));
    if (invalid.length) { next(Errors.badRequest(`Unknown permissions: ${invalid.join(', ')}`)); return; }

    let key = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'role';
    const existing = await db.select({ key: roles.key }).from(roles)
      .where(and(eq(roles.orgId, req.user!.orgId), eq(roles.scope, 'project'), eq(roles.projectId, projectId)));
    const keys = new Set(existing.map((r) => r.key));
    if (keys.has(key)) { let i = 2; while (keys.has(`${key}_${i}`)) i++; key = `${key}_${i}`; }

    const [role] = await db.insert(roles).values({
      orgId: req.user!.orgId, scope: 'project', projectId, key,
      name: body.name, description: body.description ?? null, color: body.color ?? '#3b82f6',
      baseTier: body.baseTier, permissions: body.permissions, isBuiltin: false, protected: false,
    }).returning();
    res.status(201).json(role);
  } catch (err) {
    next(err);
  }
});

// PATCH /projects/:projectId/roles/:roleId — update this project's custom role
router.patch('/:projectId/roles/:roleId', requireProjectPermission('project.manage_roles'), async (req, res, next) => {
  try {
    const projectId = req.params['projectId'] as string;
    const body = z.object({
      name: z.string().min(1).max(60).optional(),
      description: z.string().max(300).nullable().optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      permissions: z.array(z.string()).optional(),
    }).parse(req.body);

    const [role] = await db.select().from(roles)
      .where(and(eq(roles.id, req.params['roleId'] as string), eq(roles.orgId, req.user!.orgId), eq(roles.projectId, projectId)))
      .limit(1);
    if (!role) { next(Errors.notFound('Role')); return; } // built-ins (projectId null) aren't editable here
    if (body.permissions) {
      const invalid = body.permissions.filter((p) => !ALL_PROJECT_PERMISSIONS.includes(p));
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

// DELETE /projects/:projectId/roles/:roleId — delete this project's custom role (if unassigned)
router.delete('/:projectId/roles/:roleId', requireProjectPermission('project.manage_roles'), async (req, res, next) => {
  try {
    const projectId = req.params['projectId'] as string;
    const [role] = await db.select().from(roles)
      .where(and(eq(roles.id, req.params['roleId'] as string), eq(roles.orgId, req.user!.orgId), eq(roles.projectId, projectId)))
      .limit(1);
    if (!role) { next(Errors.notFound('Role')); return; }
    const [{ value: assigned } = { value: 0 }] = await db
      .select({ value: count() }).from(projectMembers).where(eq(projectMembers.roleId, role.id));
    if (Number(assigned) > 0) {
      next(Errors.badRequest(`This role is assigned to ${assigned} member(s). Reassign them before deleting.`));
      return;
    }
    await db.delete(roles).where(eq(roles.id, role.id));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export { router as projectsRouter };
