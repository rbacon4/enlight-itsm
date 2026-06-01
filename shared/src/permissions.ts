/**
 * RBAC permission catalog — the single source of truth for granular permissions,
 * shared by the API (enforcement) and the web (UI permission matrix + gating).
 *
 * Two scopes:
 *  - "global" permissions govern org-wide actions and are resolved from a user's
 *    global role (users.roleId / users.globalRole).
 *  - "project" permissions govern within-a-project actions and are resolved from
 *    a member's project role (project_members.roleId / .role). A user with the
 *    global `projects.manage_all` permission bypasses project checks.
 *
 * The built-in role permission sets below are chosen so that, after migration,
 * authorization behaves identically to the previous hard-coded role checks.
 */

export type RoleScope = 'global' | 'project';

/** The five/four hard-coded tiers that every role maps back to (cosmetics + back-compat). */
export type BuiltinGlobalRole = 'super_admin' | 'admin' | 'agent' | 'viewer' | 'customer';
export type BuiltinProjectRole = 'admin' | 'agent' | 'viewer' | 'customer';

export interface PermissionCatalogEntry {
  key: string;
  label: string;
  description: string;
  /** UI grouping header. */
  group: string;
}

// ── Global permission catalog ───────────────────────────────────────────────

export const GLOBAL_PERMISSIONS: PermissionCatalogEntry[] = [
  { key: 'org.manage_settings', group: 'Organization', label: 'Manage org settings', description: 'Edit organization settings: branding, AI keys, email, Slack, SAML/SCIM, Google Cloud, MCP keys.' },
  { key: 'roles.manage',        group: 'Organization', label: 'Manage global roles', description: 'Create, edit, and delete global custom roles.' },
  { key: 'users.manage',        group: 'Users',        label: 'Manage users', description: 'View the user list and edit user profiles.' },
  { key: 'users.assign_roles',  group: 'Users',        label: 'Assign user roles', description: "Change a user's global role." },
  { key: 'projects.create',     group: 'Projects',     label: 'Create projects', description: 'Create new projects.' },
  { key: 'projects.manage_all', group: 'Projects',     label: 'Manage all projects', description: 'Full admin access to every project (bypasses project-level checks).' },
  { key: 'offboarding.run',     group: 'Offboarding',  label: 'Run offboarding', description: 'Offboard employees and view offboarding history/config.' },
  { key: 'slack.read_usergroups', group: 'Slack',      label: 'Read Slack user groups', description: 'List Slack user groups (used when configuring project access).' },
];

// ── Project permission catalog ──────────────────────────────────────────────

export const PROJECT_PERMISSIONS: PermissionCatalogEntry[] = [
  { key: 'requests.view',         group: 'Requests',   label: 'View requests', description: 'View the project and its requests.' },
  { key: 'requests.create',       group: 'Requests',   label: 'Create requests', description: 'Submit new requests.' },
  { key: 'requests.edit',         group: 'Requests',   label: 'Edit requests', description: 'Update request status, priority, assignee, and fields.' },
  { key: 'requests.comment',      group: 'Requests',   label: 'Comment on requests', description: 'Add comments to requests.' },
  { key: 'members.view',          group: 'Members',    label: 'View members', description: 'See the project member list.' },
  { key: 'members.manage',        group: 'Members',    label: 'Manage members', description: 'Add and remove project members and set their roles.' },
  { key: 'project.manage_settings', group: 'Project',  label: 'Manage project settings', description: 'Edit project settings, SLAs, categories, and Slack access.' },
  { key: 'project.manage_roles',  group: 'Project',    label: 'Manage project roles', description: 'Create, edit, and delete this project\'s custom roles.' },
  { key: 'knowledge.view',        group: 'Knowledge',  label: 'View knowledge', description: 'View knowledge base sources.' },
  { key: 'knowledge.manage',      group: 'Knowledge',  label: 'Manage knowledge', description: 'Add, sync, and remove knowledge base sources.' },
  { key: 'oncall.view',           group: 'On-call',    label: 'View on-call', description: 'View on-call schedules.' },
  { key: 'oncall.manage',         group: 'On-call',    label: 'Manage on-call', description: 'Create and edit on-call schedules.' },
  { key: 'automations.view',      group: 'Automations', label: 'View automations', description: 'View automation rules and run history.' },
  { key: 'automations.manage',    group: 'Automations', label: 'Manage automations', description: 'Create, edit, and delete automation rules.' },
];

export const ALL_GLOBAL_PERMISSIONS: string[] = GLOBAL_PERMISSIONS.map((p) => p.key);
export const ALL_PROJECT_PERMISSIONS: string[] = PROJECT_PERMISSIONS.map((p) => p.key);

// ── Built-in role permission sets (preserve pre-RBAC behavior) ──────────────

export const BUILTIN_GLOBAL_ROLE_PERMISSIONS: Record<BuiltinGlobalRole, string[]> = {
  super_admin: [...ALL_GLOBAL_PERMISSIONS], // also `protected` → always all perms
  admin: ['org.manage_settings', 'users.manage', 'projects.create', 'projects.manage_all', 'offboarding.run', 'slack.read_usergroups'],
  agent: ['slack.read_usergroups'],
  viewer: [],
  customer: [],
};

export const BUILTIN_PROJECT_ROLE_PERMISSIONS: Record<BuiltinProjectRole, string[]> = {
  admin: [...ALL_PROJECT_PERMISSIONS],
  agent: ['requests.view', 'requests.create', 'requests.edit', 'requests.comment', 'members.view', 'knowledge.view', 'knowledge.manage', 'oncall.view', 'automations.view'],
  viewer: ['requests.view', 'requests.create', 'requests.comment', 'members.view', 'knowledge.view', 'oncall.view'],
  customer: ['requests.view', 'requests.create', 'requests.comment'],
};

// ── Built-in role display metadata (source of truth for the UI badges) ──────

export interface BuiltinRoleMeta {
  key: string;
  name: string;
  description: string;
  color: string;
  /** Sort order in lists. */
  order: number;
}

export const BUILTIN_GLOBAL_ROLE_META: Record<BuiltinGlobalRole, BuiltinRoleMeta> = {
  super_admin: { key: 'super_admin', name: 'Super Admin', description: 'Full access to all settings, users, and projects.', color: '#a855f7', order: 0 },
  admin:       { key: 'admin',       name: 'Admin',       description: 'Manage projects, settings, and team.', color: '#6366f1', order: 1 },
  agent:       { key: 'agent',       name: 'Agent',       description: 'Handle and triage requests.', color: '#3b82f6', order: 2 },
  viewer:      { key: 'viewer',      name: 'Viewer',      description: 'Read-only access to requests and project settings.', color: '#64748b', order: 3 },
  customer:    { key: 'customer',    name: 'Customer',    description: 'Submit and track their own requests.', color: '#10b981', order: 4 },
};

export const BUILTIN_PROJECT_ROLE_META: Record<BuiltinProjectRole, BuiltinRoleMeta> = {
  admin:    { key: 'admin',    name: 'Admin',    description: 'Manage settings, members, and all requests.', color: '#6366f1', order: 0 },
  agent:    { key: 'agent',    name: 'Agent',    description: 'Handle and triage requests.', color: '#3b82f6', order: 1 },
  viewer:   { key: 'viewer',   name: 'Viewer',   description: 'Read-only access to the project.', color: '#64748b', order: 2 },
  customer: { key: 'customer', name: 'Customer', description: 'Submit and track requests.', color: '#10b981', order: 3 },
};

/** Permission set for a built-in role key within a scope (used by the resolver fallback + seeding). */
export function builtinPermissionsFor(scope: RoleScope, key: string): string[] {
  if (scope === 'global') return BUILTIN_GLOBAL_ROLE_PERMISSIONS[key as BuiltinGlobalRole] ?? [];
  return BUILTIN_PROJECT_ROLE_PERMISSIONS[key as BuiltinProjectRole] ?? [];
}
