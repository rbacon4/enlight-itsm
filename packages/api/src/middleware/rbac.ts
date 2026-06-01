import { Request, Response, NextFunction } from 'express';
import { db } from '../db/client.js';
import { projectMembers } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { Errors } from '../lib/errors.js';
import type { ProjectRole } from '@enlight/shared';
import { resolveProjectPermissions } from '../lib/permissions.js';

/**
 * Gate a route on one or more project permissions (any of them grants access).
 * A global `projects.manage_all` permission bypasses project membership.
 */
export function requireProjectPermission(...perms: string[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      next(Errors.unauthorized());
      return;
    }
    const projectId = req.params['projectId'] as string | undefined;
    if (!projectId) {
      next(Errors.badRequest('projectId is required'));
      return;
    }
    try {
      const projectPerms = await resolveProjectPermissions(user.id, projectId, user.permissions);
      if (!perms.some((p) => projectPerms.includes(p))) {
        next(Errors.forbidden());
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** @deprecated Back-compat shim; prefer requireProjectPermission. */
export function requireProjectRole(...roles: ProjectRole[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      next(Errors.unauthorized());
      return;
    }

    // super_admin and admin bypass all project-level checks
    if (user.globalRole === 'super_admin' || user.globalRole === 'admin') {
      next();
      return;
    }

    const projectId = req.params['projectId'] as string | undefined;
    if (!projectId) {
      next(Errors.badRequest('projectId is required'));
      return;
    }

    const [membership] = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, user.id),
        ),
      )
      .limit(1);

    if (!membership || !roles.includes(membership.role)) {
      next(Errors.forbidden());
      return;
    }

    next();
  };
}
