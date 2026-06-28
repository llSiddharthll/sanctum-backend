import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken, type Role } from '../lib/jwt.js';
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
