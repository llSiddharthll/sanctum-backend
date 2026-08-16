import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken, ROLE_RANK, type Role } from '../lib/jwt.js';
import { AppError, forbidden, unauthenticated } from '../lib/errors.js';

export const ACCESS_COOKIE = 'sanctum_at';
export const REFRESH_COOKIE = 'sanctum_rt';

/**
 * Require a valid access token (from the httpOnly cookie, or a Bearer header
 * as a fallback for non-browser clients). Populates req.auth.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cookieToken = req.cookies?.[ACCESS_COOKIE] as string | undefined;
    const header = req.headers.authorization;
    const bearer =
      header && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : undefined;
    const token = cookieToken ?? bearer;

    if (!token) {
      throw unauthenticated('No access token.');
    }

    const claims = await verifyAccessToken(token);
    req.auth = {
      userId: claims.sub,
      agencyId: claims.agencyId,
      role: claims.role,
      clientId: claims.clientId ?? null,
    };
    next();
  } catch (err) {
    // Pass our own typed errors through untouched. Anything else (notably
    // jose's JWTExpired/JWS errors, which also carry a `.code`) is an expired
    // or malformed token → 401, so the client's refresh-on-401 flow can run.
    if (err instanceof AppError) return next(err);
    next(unauthenticated('Invalid or expired access token.'));
  }
}

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
