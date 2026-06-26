import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agencies, customRoles, users } from '../db/schema.js';
import { forbidden } from '../lib/errors.js';
import { getAuth } from './tenant.js';
import {
  resolvePermissions,
  meetsLevel,
  fullAccess,
  MODULE_LABELS,
  type AccessLevel,
  type ModuleKey,
  type PermissionMap,
} from '../lib/permissions.js';

/** HTTP methods that only READ — they require `view`; everything else `manage`. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Load (and memoize on the request) the caller's effective permission map.
 * Owner short-circuits to full access without a DB hit. Everyone else has their
 * stored overrides resolved against role defaults.
 */
export async function loadPermissions(req: Request): Promise<PermissionMap> {
  const cached = (req as Request & { _permissions?: PermissionMap })
    ._permissions;
  if (cached) return cached;

  const ctx = getAuth(req);
  let perms: PermissionMap;
  if (ctx.role === 'owner') {
    perms = fullAccess();
  } else {
    // One indexed lookup: the user's overrides + agency role defaults + the
    // user's custom role permissions (if any).
    const [row] = await db
      .select({
        permissionsJson: users.permissionsJson,
        rolePermissionsJson: agencies.rolePermissionsJson,
        customRolePermissionsJson: customRoles.permissionsJson,
      })
      .from(users)
      .innerJoin(agencies, eq(agencies.id, users.agencyId))
      .leftJoin(customRoles, eq(customRoles.id, users.customRoleId))
      .where(eq(users.id, ctx.userId))
      .limit(1);
    perms = resolvePermissions(
      ctx.role,
      row?.permissionsJson ?? null,
      row?.rolePermissionsJson ?? null,
      row?.customRolePermissionsJson ?? null,
    );
  }
  (req as Request & { _permissions?: PermissionMap })._permissions = perms;
  return perms;
}

/**
 * Require at least `level` access to `module`. Must run after requireAuth.
 * Defaults to `view`.
 */
export function requireModule(module: ModuleKey, level: AccessLevel = 'view') {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const perms = await loadPermissions(req);
      if (!meetsLevel(perms[module], level)) {
        next(
          forbidden(
            `You don't have ${level} access to ${MODULE_LABELS[module]}.`,
          ),
        );
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Method-aware module gate for a whole router: GET/HEAD/OPTIONS need `view`,
 * any mutating method needs `manage`. Mount once at the top of a module router
 * (after requireAuth) to enforce read/write access uniformly.
 */
export function requireModuleRW(module: ModuleKey) {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const needed: AccessLevel = SAFE_METHODS.has(req.method)
        ? 'view'
        : 'manage';
      const perms = await loadPermissions(req);
      if (!meetsLevel(perms[module], needed)) {
        next(
          forbidden(
            `You don't have ${needed} access to ${MODULE_LABELS[module]}.`,
          ),
        );
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
