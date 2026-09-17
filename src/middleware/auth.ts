import type { NextFunction, Request, Response } from 'express';
import { ROLE_RANK, type Role } from '../lib/jwt.js';
import { forbidden, unauthenticated } from '../lib/errors.js';
import { authenticate } from '../authz/http.js';

export const ACCESS_COOKIE = 'sanctum_at';
export const REFRESH_COOKIE = 'sanctum_rt';

/**
 * Require an authenticated actor. Delegates to the authorization adapter
 * (src/authz/http.ts): validates the server-side session and principal status
 * on every request and populates req.actor (+ legacy req.auth shim).
 * TODO(authz phase 10): routers import `authenticate` directly.
 */
export const requireAuth = authenticate;

/** Restrict a route to one of the given roles. Must run after requireAuth. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthenticated());
    if (!roles.includes(req.auth.role)) {
      return next(forbidden('Insufficient role.'));
    }
    next();
  };
}

/** Numeric rank of a role (owner=3 … client=0). */
export function roleRank(role: Role): number {
  return ROLE_RANK[role] ?? 0;
}

/**
 * True when a caller of `callerRole` is allowed to assign/act on `targetRole`.
 * Owner may act on anyone (incl. granting owner). A non-owner may only act on
 * roles STRICTLY BELOW their own tier — so an admin can manage members but not
 * other admins/owners, and can never grant admin/owner. `client` never manages.
 */
export function canManageRole(callerRole: Role, targetRole: Role): boolean {
  if (callerRole === 'owner') return true;
  if (callerRole === 'client') return false;
  return roleRank(targetRole) < roleRank(callerRole);
}
