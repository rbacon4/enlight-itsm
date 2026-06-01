import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import crypto from 'crypto';
import { db } from '../db/client.js';
import { users, organizations, groups, groupMembers } from '../db/schema.js';
import { eq, and, count, inArray } from 'drizzle-orm';
import { logger } from '../lib/logger.js';
import { builtinGlobalRoleId } from '../lib/permissions.js';
import type { OrganizationSettings, GlobalRole } from '@enlight/shared';

// SCIM v2 (RFC 7643 / 7644) provisioning server. One base URL per org:
//   /scim/v2/:orgId/...
// Authenticated with the org's SCIM bearer token (hash compared to scim_token_hash).

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const ENTERPRISE_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SPC_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';

type UserRow = typeof users.$inferSelect;
type GroupRow = typeof groups.$inferSelect;

function scimError(res: Response, status: number, detail: string, scimType?: string): void {
  res.status(status).type('application/scim+json').json({
    schemas: [ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  });
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ── Auth: validate the org's SCIM bearer token ────────────────────────────────

async function requireScim(req: Request, res: Response, next: NextFunction): Promise<void> {
  const orgId = req.params['orgId'] as string;
  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    scimError(res, 401, 'Missing bearer token.');
    return;
  }
  const presented = sha256(header.slice(7).trim());

  try {
    const [org] = await db
      .select({ id: organizations.id, scimTokenHash: organizations.scimTokenHash, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org?.scimTokenHash) { scimError(res, 401, 'SCIM is not enabled for this organization.'); return; }

    const a = Buffer.from(presented, 'hex');
    const b = Buffer.from(org.scimTokenHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      scimError(res, 401, 'Invalid bearer token.');
      return;
    }

    res.locals['scimOrgId'] = orgId;
    res.locals['scimSettings'] = (org.settings ?? {}) as OrganizationSettings;
    next();
  } catch (err) {
    logger.error('SCIM auth error', { orgId, err });
    scimError(res, 500, 'Authentication error.');
  }
}

// ── User <-> SCIM mapping ──────────────────────────────────────────────────────

function toScimUser(u: UserRow, baseUrl: string): Record<string, unknown> {
  const schemas = [USER_SCHEMA];
  const out: Record<string, unknown> = {
    schemas,
    id: u.id,
    externalId: u.externalId ?? undefined,
    userName: u.email,
    name: { formatted: u.name },
    displayName: u.name,
    title: u.jobTitle ?? undefined,
    active: u.active,
    emails: [{ value: u.email, primary: true, type: 'work' }],
    meta: {
      resourceType: 'User',
      created: u.createdAt?.toISOString(),
      lastModified: u.updatedAt?.toISOString(),
      location: `${baseUrl}/Users/${u.id}`,
    },
  };
  if (u.city || u.state || u.country) {
    out['addresses'] = [{
      type: 'work',
      locality: u.city ?? undefined,
      region: u.state ?? undefined,
      country: u.country ?? undefined,
    }];
  }
  // Enterprise extension carries department + manager.
  if (u.department || u.managerId) {
    schemas.push(ENTERPRISE_SCHEMA);
    out[ENTERPRISE_SCHEMA] = {
      ...(u.department ? { department: u.department } : {}),
      ...(u.managerId ? { manager: { value: u.managerId, $ref: `${baseUrl}/Users/${u.managerId}` } } : {}),
    };
  }
  return out;
}

/** Resolves a manager reference (our user id, externalId, or email) to a local user id. */
async function resolveManagerId(ref: string | undefined, orgId: string): Promise<string | null> {
  const r = (ref ?? '').trim();
  if (!r) return null;
  if (UUID_RE.test(r)) {
    const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.orgId, orgId), eq(users.id, r))).limit(1);
    if (u) return u.id;
  }
  if (r.includes('@')) {
    const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.orgId, orgId), eq(users.email, r.toLowerCase()))).limit(1);
    if (u) return u.id;
  }
  const [byExt] = await db.select({ id: users.id }).from(users).where(and(eq(users.orgId, orgId), eq(users.externalId, r))).limit(1);
  return byExt?.id ?? null;
}

/** Extracts profile fields (title/address/department/manager) from a SCIM body.
 *  Only keys present in the payload are returned, so it's safe for create + replace. */
async function scimProfileValues(body: IncomingScimUser, orgId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (typeof body.title === 'string') out['jobTitle'] = body.title || null;
  if (Array.isArray(body.addresses)) {
    const a = body.addresses.find(x => x.type === 'work') ?? body.addresses[0];
    out['city'] = a?.locality ?? null;
    out['state'] = a?.region ?? null;
    out['country'] = a?.country ?? null;
  }
  const ext = (body as unknown as Record<string, unknown>)[ENTERPRISE_SCHEMA] as Record<string, unknown> | undefined;
  if (ext) {
    if ('department' in ext) out['department'] = typeof ext['department'] === 'string' ? ext['department'] : null;
    if ('manager' in ext) {
      const mgr = ext['manager'];
      const refVal = typeof mgr === 'string' ? mgr
        : (mgr && typeof mgr === 'object' ? String((mgr as Record<string, unknown>)['value'] ?? '') : '');
      out['managerId'] = await resolveManagerId(refVal, orgId);
    }
  }
  return out;
}

function scimBaseUrl(orgId: string): string {
  const apiUrl = (process.env['API_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${apiUrl}/scim/v2/${orgId}`;
}

function toScimGroup(g: GroupRow, members: { userId: string; email: string }[], baseUrl: string): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    externalId: g.externalId ?? undefined,
    displayName: g.displayName,
    members: members.map((m) => ({
      value: m.userId,
      display: m.email,
      $ref: `${baseUrl}/Users/${m.userId}`,
    })),
    meta: {
      resourceType: 'Group',
      created: g.createdAt?.toISOString(),
      lastModified: g.updatedAt?.toISOString(),
      location: `${baseUrl}/Groups/${g.id}`,
    },
  };
}

/** Loads members (userId + email) for a group, scoped to the org. */
async function loadGroupMembers(groupId: string, orgId: string): Promise<{ userId: string; email: string }[]> {
  return db
    .select({ userId: groupMembers.userId, email: users.email })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(and(eq(groupMembers.groupId, groupId), eq(users.orgId, orgId)));
}

interface IncomingScimGroup {
  displayName?: string;
  externalId?: string;
  members?: { value?: string }[];
}

/** Resolves SCIM member entries to valid user IDs within the org (silently drops unknowns). */
async function resolveMemberIds(members: { value?: string }[] | undefined, orgId: string): Promise<string[]> {
  const ids = (members ?? []).map((m) => m.value).filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (ids.length === 0) return [];
  const rows = await db.select({ id: users.id }).from(users).where(and(eq(users.orgId, orgId), inArray(users.id, ids)));
  return rows.map((r) => r.id);
}

async function setGroupMembers(groupId: string, userIds: string[]): Promise<void> {
  await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
  if (userIds.length > 0) {
    await db.insert(groupMembers).values(userIds.map((userId) => ({ groupId, userId }))).onConflictDoNothing();
  }
}

interface IncomingScimUser {
  userName?: string;
  externalId?: string;
  displayName?: string;
  active?: boolean;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  emails?: { value?: string; primary?: boolean }[];
  title?: string;
  addresses?: { type?: string; locality?: string; region?: string; country?: string }[];
  // Enterprise extension is a top-level key on the body; read dynamically.
}

function emailFromScim(body: IncomingScimUser): string | undefined {
  if (typeof body.userName === 'string' && body.userName.includes('@')) return body.userName.trim().toLowerCase();
  const primary = body.emails?.find((e) => e.primary) ?? body.emails?.[0];
  if (primary?.value?.includes('@')) return primary.value.trim().toLowerCase();
  if (typeof body.userName === 'string' && body.userName.trim()) return body.userName.trim().toLowerCase();
  return undefined;
}

function nameFromScim(body: IncomingScimUser, email: string): string {
  if (body.displayName?.trim()) return body.displayName.trim();
  if (body.name?.formatted?.trim()) return body.name.formatted.trim();
  const parts = [body.name?.givenName, body.name?.familyName].filter((p): p is string => !!p?.trim());
  if (parts.length) return parts.join(' ');
  return email.split('@')[0] ?? email;
}

// ── Router ─────────────────────────────────────────────────────────────────────

const router = Router();

// Parse application/scim+json (and plain json) bodies for this router.
router.use(express.json({ type: ['application/json', 'application/scim+json'], limit: '1mb' }));
router.use('/:orgId', requireScim);

// Discovery endpoints — IdPs query these to test the connection.

router.get('/:orgId/ServiceProviderConfig', (req, res) => {
  res.type('application/scim+json').json({
    schemas: [SPC_SCHEMA],
    documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'Authentication via the SCIM bearer token.',
    }],
  });
});

router.get('/:orgId/ResourceTypes', (req, res) => {
  const base = scimBaseUrl(req.params['orgId'] as string);
  const types = [
    {
      id: 'User', name: 'User', endpoint: '/Users', schema: USER_SCHEMA,
      schemaExtensions: [{ schema: ENTERPRISE_SCHEMA, required: false }],
    },
    { id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP_SCHEMA },
  ];
  res.type('application/scim+json').json({
    schemas: [LIST_SCHEMA],
    totalResults: types.length,
    startIndex: 1,
    itemsPerPage: types.length,
    Resources: types.map((t) => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      ...t,
      meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/${t.id}` },
    })),
  });
});

router.get('/:orgId/Schemas', (_req, res) => {
  const resources = [
    { id: USER_SCHEMA,  name: 'User',  description: 'User Account' },
    { id: ENTERPRISE_SCHEMA, name: 'EnterpriseUser', description: 'Enterprise User (department, manager)' },
    { id: GROUP_SCHEMA, name: 'Group', description: 'Group' },
  ];
  res.type('application/scim+json').json({
    schemas: [LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  });
});

// ── Users ──────────────────────────────────────────────────────────────────────

// GET /Users — list, optionally filtered by `userName eq "..."` or `externalId eq "..."`.
router.get('/:orgId/Users', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const base = scimBaseUrl(orgId);
  try {
    const filter = typeof req.query['filter'] === 'string' ? req.query['filter'] : '';
    const startIndex = Math.max(1, parseInt(String(req.query['startIndex'] ?? '1'), 10) || 1);
    const count_ = Math.min(200, Math.max(0, parseInt(String(req.query['count'] ?? '100'), 10) || 100));

    const m = /(\w+)\s+eq\s+"([^"]+)"/i.exec(filter);
    const conds = [eq(users.orgId, orgId)];
    if (m) {
      const attr = m[1]!.toLowerCase();
      const val = m[2]!;
      if (attr === 'username') conds.push(eq(users.email, val.toLowerCase()));
      else if (attr === 'externalid') conds.push(eq(users.externalId, val));
      else if (attr === 'email' || attr === 'emails') conds.push(eq(users.email, val.toLowerCase()));
    }

    const where = and(...conds);
    const [{ total }] = await db.select({ total: count() }).from(users).where(where) as [{ total: number }];
    const rows = count_ === 0 ? [] : await db.select().from(users).where(where)
      .limit(count_).offset(startIndex - 1);

    res.type('application/scim+json').json({
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((u) => toScimUser(u, base)),
    });
  } catch (err) {
    logger.error('SCIM list users failed', { orgId, err });
    scimError(res, 500, 'Could not list users.');
  }
});

// GET /Users/:id
router.get('/:orgId/Users/:id', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  try {
    const [u] = await db.select().from(users)
      .where(and(eq(users.orgId, orgId), eq(users.id, req.params['id'] as string))).limit(1);
    if (!u) { scimError(res, 404, 'User not found.'); return; }
    res.type('application/scim+json').json(toScimUser(u, scimBaseUrl(orgId)));
  } catch (err) {
    logger.error('SCIM get user failed', { orgId, err });
    scimError(res, 500, 'Could not fetch user.');
  }
});

// POST /Users — create (or reactivate an existing match by email).
router.post('/:orgId/Users', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const base = scimBaseUrl(orgId);
  try {
    const body = req.body as IncomingScimUser;
    const email = emailFromScim(body);
    if (!email) { scimError(res, 400, 'userName or a primary email is required.', 'invalidValue'); return; }

    const settings = res.locals['scimSettings'] as OrganizationSettings;
    const role = (settings.autoProvisionRole as GlobalRole | undefined) ?? 'customer';

    // If a user with this email already exists, SCIM expects a 409 conflict.
    const [existing] = await db.select().from(users)
      .where(and(eq(users.orgId, orgId), eq(users.email, email))).limit(1);
    if (existing) {
      res.setHeader('Location', `${base}/Users/${existing.id}`);
      scimError(res, 409, 'A user with this userName already exists.', 'uniqueness');
      return;
    }

    const [created] = await db.insert(users).values({
      orgId,
      email,
      name: nameFromScim(body, email),
      externalId: body.externalId ?? null,
      globalRole: role,
      roleId: await builtinGlobalRoleId(orgId, role),
      active: body.active ?? true,
      ...(await scimProfileValues(body, orgId)),
    }).returning();

    if (!created) { scimError(res, 500, 'Could not create user.'); return; }

    res.status(201).setHeader('Location', `${base}/Users/${created.id}`);
    res.type('application/scim+json').json(toScimUser(created, base));
  } catch (err) {
    logger.error('SCIM create user failed', { orgId, err });
    scimError(res, 500, 'Could not create user.');
  }
});

// PUT /Users/:id — full replace.
router.put('/:orgId/Users/:id', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const id = req.params['id'] as string;
  const base = scimBaseUrl(orgId);
  try {
    const [u] = await db.select().from(users).where(and(eq(users.orgId, orgId), eq(users.id, id))).limit(1);
    if (!u) { scimError(res, 404, 'User not found.'); return; }

    const body = req.body as IncomingScimUser;
    const email = emailFromScim(body) ?? u.email;

    const [updated] = await db.update(users).set({
      email,
      name: nameFromScim(body, email),
      externalId: body.externalId ?? u.externalId,
      active: body.active ?? u.active,
      ...(await scimProfileValues(body, orgId)),
      updatedAt: new Date(),
    }).where(eq(users.id, id)).returning();

    res.type('application/scim+json').json(toScimUser(updated!, base));
  } catch (err) {
    logger.error('SCIM put user failed', { orgId, err });
    scimError(res, 500, 'Could not update user.');
  }
});

// PATCH /Users/:id — partial update (handles the common `active` deprovision toggle).
router.patch('/:orgId/Users/:id', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const id = req.params['id'] as string;
  const base = scimBaseUrl(orgId);
  try {
    const [u] = await db.select().from(users).where(and(eq(users.orgId, orgId), eq(users.id, id))).limit(1);
    if (!u) { scimError(res, 404, 'User not found.'); return; }

    const ops = (req.body?.Operations ?? req.body?.operations ?? []) as { op?: string; path?: string; value?: unknown }[];
    const patch: Partial<UserRow> = {};
    let managerSeen = false;
    let managerRef = '';
    const setManager = (v: unknown) => {
      managerSeen = true;
      managerRef = typeof v === 'string' ? v : (v && typeof v === 'object' ? String((v as Record<string, unknown>)['value'] ?? '') : '');
    };
    const setAddress = (arr: unknown) => {
      if (!Array.isArray(arr)) return;
      const a = arr.find((x) => x?.type === 'work') ?? arr[0];
      if (a && typeof a === 'object') {
        patch.city = (a as Record<string, string>)['locality'] ?? null;
        patch.state = (a as Record<string, string>)['region'] ?? null;
        patch.country = (a as Record<string, string>)['country'] ?? null;
      }
    };

    const applyField = (path: string | undefined, value: unknown) => {
      const p = (path ?? '').toLowerCase();
      if (p === 'active') { if (typeof value === 'boolean') patch.active = value; else if (typeof value === 'string') patch.active = value === 'true'; }
      else if (p === 'username') { if (typeof value === 'string') patch.email = value.toLowerCase(); }
      else if (p === 'displayname' || p === 'name.formatted') { if (typeof value === 'string') patch.name = value; }
      else if (p === 'externalid') { if (typeof value === 'string') patch.externalId = value; }
      else if (p === 'title') { if (typeof value === 'string') patch.jobTitle = value || null; }
      else if (p === 'addresses') { setAddress(value); }
      else if (p.includes('locality')) { if (typeof value === 'string') patch.city = value; }
      else if (p.includes('region')) { if (typeof value === 'string') patch.state = value; }
      else if (p.includes('country')) { if (typeof value === 'string') patch.country = value; }
      else if (p.endsWith(':department') || p === 'department') { if (typeof value === 'string') patch.department = value || null; }
      else if (p.includes(':manager') || p === 'manager') { setManager(value); }
      else if (p === '' && value && typeof value === 'object') {
        // No-path replace: value is an object of attributes.
        const v = value as Record<string, unknown>;
        if (typeof v['active'] === 'boolean') patch.active = v['active'] as boolean;
        if (typeof v['userName'] === 'string') patch.email = (v['userName'] as string).toLowerCase();
        if (typeof v['displayName'] === 'string') patch.name = v['displayName'] as string;
        if (typeof v['externalId'] === 'string') patch.externalId = v['externalId'] as string;
        if (typeof v['title'] === 'string') patch.jobTitle = (v['title'] as string) || null;
        if (Array.isArray(v['addresses'])) setAddress(v['addresses']);
        const ext = v[ENTERPRISE_SCHEMA] as Record<string, unknown> | undefined;
        if (ext) {
          if ('department' in ext) patch.department = typeof ext['department'] === 'string' ? (ext['department'] as string) : null;
          if ('manager' in ext) setManager(ext['manager']);
        }
      }
    };

    for (const op of ops) {
      const verb = (op.op ?? '').toLowerCase();
      if (verb === 'replace' || verb === 'add') applyField(op.path, op.value);
      // (We don't support attribute removal; IdPs deprovision via active=false.)
    }

    if (managerSeen) patch.managerId = await resolveManagerId(managerRef, orgId);

    if (Object.keys(patch).length === 0) {
      res.type('application/scim+json').json(toScimUser(u, base));
      return;
    }

    const [updated] = await db.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, id)).returning();
    res.type('application/scim+json').json(toScimUser(updated!, base));
  } catch (err) {
    logger.error('SCIM patch user failed', { orgId, err });
    scimError(res, 500, 'Could not update user.');
  }
});

// DELETE /Users/:id — deprovision. Soft-delete (active=false) to preserve request history.
router.delete('/:orgId/Users/:id', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const id = req.params['id'] as string;
  try {
    const [updated] = await db.update(users)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(users.orgId, orgId), eq(users.id, id)))
      .returning({ id: users.id });
    if (!updated) { scimError(res, 404, 'User not found.'); return; }
    res.status(204).send();
  } catch (err) {
    logger.error('SCIM delete user failed', { orgId, err });
    scimError(res, 500, 'Could not delete user.');
  }
});

// ── Groups ───────────────────────────────────────────────────────────────────

// GET /Groups — list, optionally filtered by `displayName eq "..."` or `externalId eq "..."`.
router.get('/:orgId/Groups', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const base = scimBaseUrl(orgId);
  try {
    const filter = typeof req.query['filter'] === 'string' ? req.query['filter'] : '';
    const startIndex = Math.max(1, parseInt(String(req.query['startIndex'] ?? '1'), 10) || 1);
    const count_ = Math.min(200, Math.max(0, parseInt(String(req.query['count'] ?? '100'), 10) || 100));

    const m = /(\w+)\s+eq\s+"([^"]+)"/i.exec(filter);
    const conds = [eq(groups.orgId, orgId)];
    if (m) {
      const attr = m[1]!.toLowerCase();
      const val = m[2]!;
      if (attr === 'displayname') conds.push(eq(groups.displayName, val));
      else if (attr === 'externalid') conds.push(eq(groups.externalId, val));
    }

    const where = and(...conds);
    const [{ total }] = await db.select({ total: count() }).from(groups).where(where) as [{ total: number }];
    const rows = count_ === 0 ? [] : await db.select().from(groups).where(where).limit(count_).offset(startIndex - 1);

    const resources = await Promise.all(rows.map(async (g) => toScimGroup(g, await loadGroupMembers(g.id, orgId), base)));

    res.type('application/scim+json').json({
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: rows.length,
      Resources: resources,
    });
  } catch (err) {
    logger.error('SCIM list groups failed', { orgId, err });
    scimError(res, 500, 'Could not list groups.');
  }
});

// GET /Groups/:id
router.get('/:orgId/Groups/:id', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const id = req.params['id'] as string;
  try {
    const [g] = await db.select().from(groups).where(and(eq(groups.orgId, orgId), eq(groups.id, id))).limit(1);
    if (!g) { scimError(res, 404, 'Group not found.'); return; }
    res.type('application/scim+json').json(toScimGroup(g, await loadGroupMembers(id, orgId), scimBaseUrl(orgId)));
  } catch (err) {
    logger.error('SCIM get group failed', { orgId, err });
    scimError(res, 500, 'Could not fetch group.');
  }
});

// POST /Groups — create (with optional initial members).
router.post('/:orgId/Groups', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const base = scimBaseUrl(orgId);
  try {
    const body = req.body as IncomingScimGroup;
    const displayName = body.displayName?.trim();
    if (!displayName) { scimError(res, 400, 'displayName is required.', 'invalidValue'); return; }

    const [existing] = await db.select({ id: groups.id }).from(groups)
      .where(and(eq(groups.orgId, orgId), eq(groups.displayName, displayName))).limit(1);
    if (existing) {
      res.setHeader('Location', `${base}/Groups/${existing.id}`);
      scimError(res, 409, 'A group with this displayName already exists.', 'uniqueness');
      return;
    }

    const [created] = await db.insert(groups).values({
      orgId,
      displayName,
      externalId: body.externalId ?? null,
    }).returning();
    if (!created) { scimError(res, 500, 'Could not create group.'); return; }

    const memberIds = await resolveMemberIds(body.members, orgId);
    if (memberIds.length > 0) await setGroupMembers(created.id, memberIds);

    res.status(201).setHeader('Location', `${base}/Groups/${created.id}`);
    res.type('application/scim+json').json(toScimGroup(created, await loadGroupMembers(created.id, orgId), base));
  } catch (err) {
    logger.error('SCIM create group failed', { orgId, err });
    scimError(res, 500, 'Could not create group.');
  }
});

// PUT /Groups/:id — full replace (displayName + complete member set).
router.put('/:orgId/Groups/:id', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const id = req.params['id'] as string;
  const base = scimBaseUrl(orgId);
  try {
    const [g] = await db.select().from(groups).where(and(eq(groups.orgId, orgId), eq(groups.id, id))).limit(1);
    if (!g) { scimError(res, 404, 'Group not found.'); return; }

    const body = req.body as IncomingScimGroup;
    const [updated] = await db.update(groups).set({
      displayName: body.displayName?.trim() || g.displayName,
      externalId: body.externalId ?? g.externalId,
      updatedAt: new Date(),
    }).where(eq(groups.id, id)).returning();

    await setGroupMembers(id, await resolveMemberIds(body.members, orgId));

    res.type('application/scim+json').json(toScimGroup(updated!, await loadGroupMembers(id, orgId), base));
  } catch (err) {
    logger.error('SCIM put group failed', { orgId, err });
    scimError(res, 500, 'Could not update group.');
  }
});

// PATCH /Groups/:id — partial update. Handles the membership add/remove/replace
// operations IdPs send, plus displayName changes.
router.patch('/:orgId/Groups/:id', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const id = req.params['id'] as string;
  const base = scimBaseUrl(orgId);
  try {
    const [g] = await db.select().from(groups).where(and(eq(groups.orgId, orgId), eq(groups.id, id))).limit(1);
    if (!g) { scimError(res, 404, 'Group not found.'); return; }

    const ops = (req.body?.Operations ?? req.body?.operations ?? []) as { op?: string; path?: string; value?: unknown }[];
    let displayName = g.displayName;
    let externalId = g.externalId;

    for (const op of ops) {
      const verb = (op.op ?? '').toLowerCase();
      const path = op.path ?? '';
      const pathLower = path.toLowerCase();

      // Membership operations.
      if (pathLower === 'members') {
        if (verb === 'add') {
          const ids = await resolveMemberIds(op.value as { value?: string }[] | undefined, orgId);
          if (ids.length) await db.insert(groupMembers).values(ids.map((userId) => ({ groupId: id, userId }))).onConflictDoNothing();
        } else if (verb === 'replace') {
          await setGroupMembers(id, await resolveMemberIds(op.value as { value?: string }[] | undefined, orgId));
        } else if (verb === 'remove') {
          // remove with no member filter clears all members
          await db.delete(groupMembers).where(eq(groupMembers.groupId, id));
        }
        continue;
      }

      // Remove a specific member: path like `members[value eq "userId"]`.
      const memberFilter = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
      if (memberFilter && verb === 'remove') {
        const userId = memberFilter[1]!;
        await db.delete(groupMembers).where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, userId)));
        continue;
      }

      // Attribute updates (replace/add).
      if (verb === 'replace' || verb === 'add') {
        if (pathLower === 'displayname') {
          if (typeof op.value === 'string') displayName = op.value;
        } else if (pathLower === 'externalid') {
          if (typeof op.value === 'string') externalId = op.value;
        } else if (path === '' && op.value && typeof op.value === 'object') {
          const v = op.value as IncomingScimGroup & { members?: { value?: string }[] };
          if (typeof v.displayName === 'string') displayName = v.displayName;
          if (typeof v.externalId === 'string') externalId = v.externalId;
          if (Array.isArray(v.members)) await setGroupMembers(id, await resolveMemberIds(v.members, orgId));
        }
      }
    }

    const [updated] = await db.update(groups)
      .set({ displayName, externalId, updatedAt: new Date() })
      .where(eq(groups.id, id)).returning();

    res.type('application/scim+json').json(toScimGroup(updated!, await loadGroupMembers(id, orgId), base));
  } catch (err) {
    logger.error('SCIM patch group failed', { orgId, err });
    scimError(res, 500, 'Could not update group.');
  }
});

// DELETE /Groups/:id — hard delete (memberships cascade). Groups aren't referenced
// by tickets, so removal is safe.
router.delete('/:orgId/Groups/:id', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  const id = req.params['id'] as string;
  try {
    const [deleted] = await db.delete(groups)
      .where(and(eq(groups.orgId, orgId), eq(groups.id, id)))
      .returning({ id: groups.id });
    if (!deleted) { scimError(res, 404, 'Group not found.'); return; }
    res.status(204).send();
  } catch (err) {
    logger.error('SCIM delete group failed', { orgId, err });
    scimError(res, 500, 'Could not delete group.');
  }
});

export { router as scimRouter };
