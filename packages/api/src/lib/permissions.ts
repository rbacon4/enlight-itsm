/**
 * Permission resolution for RBAC. Resolves a user's effective global and
 * project permission sets from their assigned role (roleId), with safe
 * fallbacks to the built-in defaults keyed by the denormalized tier columns.
 */
import { db } from '../db/client.js';
import { roles, projectMembers } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ALL_GLOBAL_PERMISSIONS,
  ALL_PROJECT_PERMISSIONS,
  BUILTIN_GLOBAL_ROLE_PERMISSIONS,
  BUILTIN_PROJECT_ROLE_PERMISSIONS,
  type BuiltinGlobalRole,
  type BuiltinProjectRole,
} from '@enlight/shared';

interface GlobalRoleSource {
  roleId?: string | null;
  globalRole: string;
}

/** Look up the org's built-in global role id by tier key (for provisioning). */
export async function builtinGlobalRoleId(orgId: string, key: string): Promise<string | null> {
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(
      eq(roles.orgId, orgId), eq(roles.scope, 'global'), eq(roles.isBuiltin, true),
      isNull(roles.projectId), eq(roles.key, key),
    ))
    .limit(1);
  return role?.id ?? null;
}

/** Resolve a user's global permission set. Protected roles always get everything. */
export async function resolveGlobalPermissions(user: GlobalRoleSource): Promise<string[]> {
  if (user.roleId) {
    const [role] = await db
      .select({ permissions: roles.permissions, protected: roles.protected })
      .from(roles)
      .where(eq(roles.id, user.roleId))
      .limit(1);
    if (role) {
      if (role.protected) return [...ALL_GLOBAL_PERMISSIONS];
      return (role.permissions as string[]) ?? [];
    }
  }
  // Fallback: built-in defaults by tier (covers rows not yet backfilled).
  if (user.globalRole === 'super_admin') return [...ALL_GLOBAL_PERMISSIONS];
  return BUILTIN_GLOBAL_ROLE_PERMISSIONS[user.globalRole as BuiltinGlobalRole] ?? [];
}

/**
 * Resolve a user's permission set within a project. A global `projects.manage_all`
 * grants full project access (the old super_admin/admin bypass). Otherwise the
 * member's project role governs; non-members get nothing.
 */
export async function resolveProjectPermissions(
  userId: string,
  projectId: string,
  globalPermissions: string[],
): Promise<string[]> {
  if (globalPermissions.includes('projects.manage_all')) return [...ALL_PROJECT_PERMISSIONS];

  const [membership] = await db
    .select({ roleId: projectMembers.roleId, role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  if (!membership) return [];

  if (membership.roleId) {
    const [role] = await db
      .select({ permissions: roles.permissions })
      .from(roles)
      .where(eq(roles.id, membership.roleId))
      .limit(1);
    if (role) return (role.permissions as string[]) ?? [];
  }
  return BUILTIN_PROJECT_ROLE_PERMISSIONS[membership.role as BuiltinProjectRole] ?? [];
}
