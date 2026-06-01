import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Errors } from '../lib/errors.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { GlobalRole } from '@enlight/shared';
import { resolveGlobalPermissions } from '../lib/permissions.js';

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  /** Resolved global permission keys (RBAC). */
  permissions: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret-change-me';

/** JWT carries identity only; permissions are resolved from the DB per request. */
export type TokenIdentity = Omit<AuthUser, 'permissions'>;

export function signToken(user: TokenIdentity): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
}

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers['authorization'];
  const token =
    authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.token;

  if (!token) {
    next(Errors.unauthorized());
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthUser;
    // Verify user still exists
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.id))
      .limit(1);

    if (!user || !user.active) {
      next(Errors.unauthorized());
      return;
    }

    const permissions = await resolveGlobalPermissions({
      roleId: user.roleId,
      globalRole: user.globalRole,
    });

    req.user = {
      id: user.id,
      orgId: user.orgId,
      email: user.email,
      name: user.name,
      globalRole: user.globalRole,
      permissions,
    };
    next();
  } catch {
    next(Errors.unauthorized());
  }
}

/** Gate a route on one or more global permissions (any of them grants access). */
export function requirePermission(...perms: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(Errors.unauthorized());
      return;
    }
    if (!perms.some((p) => req.user!.permissions.includes(p))) {
      next(Errors.forbidden());
      return;
    }
    next();
  };
}

/** @deprecated Back-compat shim; prefer requirePermission. Kept for any stragglers. */
export function requireGlobalRole(...roles: GlobalRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(Errors.unauthorized());
      return;
    }
    if (!roles.includes(req.user.globalRole)) {
      next(Errors.forbidden());
      return;
    }
    next();
  };
}
