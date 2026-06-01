/**
 * Seeds the built-in RBAC roles for an org and backfills role assignments.
 *
 * Built-in roles mirror the pre-RBAC behavior exactly (see shared/permissions.ts).
 * `ensureBuiltinRoles` is idempotent and is called both by the one-time backfill
 * and by /auth/setup when a new org is created.
 */
import { db } from '../db/client.js';
import { roles, users, projectMembers } from '../db/schema.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  BUILTIN_GLOBAL_ROLE_META,
  BUILTIN_PROJECT_ROLE_META,
  BUILTIN_GLOBAL_ROLE_PERMISSIONS,
  BUILTIN_PROJECT_ROLE_PERMISSIONS,
  type BuiltinGlobalRole,
  type BuiltinProjectRole,
} from '@enlight/shared';

/** Insert the org's built-in global + project roles if they don't already exist. */
export async function ensureBuiltinRoles(orgId: string): Promise<void> {
  const existing = await db
    .select({ scope: roles.scope, key: roles.key })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.isBuiltin, true), isNull(roles.projectId)));
  const have = new Set(existing.map((r) => `${r.scope}:${r.key}`));

  const rows: (typeof roles.$inferInsert)[] = [];

  for (const key of Object.keys(BUILTIN_GLOBAL_ROLE_META) as BuiltinGlobalRole[]) {
    if (have.has(`global:${key}`)) continue;
    const meta = BUILTIN_GLOBAL_ROLE_META[key];
    rows.push({
      orgId, scope: 'global', projectId: null, key,
      name: meta.name, description: meta.description, color: meta.color, baseTier: key,
      permissions: BUILTIN_GLOBAL_ROLE_PERMISSIONS[key],
      isBuiltin: true, protected: key === 'super_admin',
    });
  }
  for (const key of Object.keys(BUILTIN_PROJECT_ROLE_META) as BuiltinProjectRole[]) {
    if (have.has(`project:${key}`)) continue;
    const meta = BUILTIN_PROJECT_ROLE_META[key];
    rows.push({
      orgId, scope: 'project', projectId: null, key,
      name: meta.name, description: meta.description, color: meta.color, baseTier: key,
      permissions: BUILTIN_PROJECT_ROLE_PERMISSIONS[key],
      isBuiltin: true, protected: false,
    });
  }

  if (rows.length > 0) await db.insert(roles).values(rows);
}

/** Point users.roleId / project_members.roleId at the matching built-in role. */
export async function backfillRoleAssignments(orgId: string): Promise<void> {
  // Global: users.role_id = builtin global role whose key = users.global_role
  await db.execute(sql`
    UPDATE users u
    SET role_id = r.id
    FROM roles r
    WHERE u.org_id = ${orgId}
      AND u.role_id IS NULL
      AND r.org_id = ${orgId}
      AND r.scope = 'global'
      AND r.is_builtin = true
      AND r.project_id IS NULL
      AND r.key = u.global_role::text
  `);
  // Project: project_members.role_id = builtin project role whose key = members.role
  await db.execute(sql`
    UPDATE project_members pm
    SET role_id = r.id
    FROM roles r, projects p
    WHERE pm.project_id = p.id
      AND p.org_id = ${orgId}
      AND pm.role_id IS NULL
      AND r.org_id = ${orgId}
      AND r.scope = 'project'
      AND r.is_builtin = true
      AND r.project_id IS NULL
      AND r.key = pm.role::text
  `);
}

/** Seed built-ins + backfill assignments for a single org. */
export async function setupOrgRoles(orgId: string): Promise<void> {
  await ensureBuiltinRoles(orgId);
  await backfillRoleAssignments(orgId);
}
