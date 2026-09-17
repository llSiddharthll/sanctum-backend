import type { NextFunction, Request, Response } from 'express';
import { legacyPermissionMap } from '../authz/compat.js';
import { forbidden } from '../lib/errors.js';
import { getAuth } from './tenant.js';
import {
  meetsLevel,
  noAccess,
  MODULE_LABELS,
  type AccessLevel,
  type ModuleKey,
  type PermissionMap,
} from '../lib/permissions.js';

/** HTTP methods that only READ — they require `view`. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Map an HTTP method to the CRUD access tier it requires:
 *   GET/HEAD/OPTIONS → view (Read)
 *   POST/PUT/PATCH   → edit (Create / Update)
 *   DELETE           → manage (Delete)
 */
function levelForMethod(method: string): AccessLevel {
  if (SAFE_METHODS.has(method)) return 'view';
  if (method === 'DELETE') return 'manage';
  return 'edit';
}

/** Friendly verb for a denied tier, used in 403 messages. */
const LEVEL_VERB: Record<AccessLevel, string> = {
  none: 'access',
  view: 'view',
  edit: 'edit',
  manage: 'manage or delete in',
};

/**
 * Legacy module-level view of the caller's authorization, DERIVED from the new
 * grant set (src/authz). Kept only for routers not yet migrated to
 * `requires(...)` + policies. TODO(authz phase 10): delete this file.
 */
export async function loadPermissions(req: Request): Promise<PermissionMap> {
  const actor = req.actor;
  if (!actor) {
    getAuth(req); // throws unauthenticated
    return noAccess();
  }
  return legacyPermissionMap(actor) as PermissionMap;
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
 * POST/PUT/PATCH need `edit`, and DELETE needs `manage`. Mount once at the top
 * of a module router (after requireAuth) to enforce CRUD access uniformly.
 */
export function requireModuleRW(module: ModuleKey) {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const needed = levelForMethod(req.method);
      const perms = await loadPermissions(req);
      if (!meetsLevel(perms[module], needed)) {
        next(
          forbidden(
            `You don't have permission to ${LEVEL_VERB[needed]} ${MODULE_LABELS[module]}.`,
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
