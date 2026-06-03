import type { Response } from 'express';
import { isProd } from '../env.js';
import { tokenTtl } from './jwt.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../middleware/auth.js';

/**
 * httpOnly Secure SameSite cookies. Cross-site (Vercel -> Render) needs
 * SameSite=None in production; in dev we use Lax over http://localhost.
 */
function baseOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
  };
}

export function setAuthCookies(
  res: Response,
  tokens: { access: string; refresh: string },
): void {
  res.cookie(ACCESS_COOKIE, tokens.access, {
    ...baseOptions(),
    maxAge: tokenTtl.accessSeconds * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refresh, {
    ...baseOptions(),
    maxAge: tokenTtl.refreshSeconds * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  const opts = baseOptions();
  res.clearCookie(ACCESS_COOKIE, opts);
  res.clearCookie(REFRESH_COOKIE, opts);
}
