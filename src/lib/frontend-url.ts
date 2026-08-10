import type { Request } from 'express';
import { env } from '../env.js';

/**
 * Returns the public, live frontend URL origin (e.g. "https://app.thecreativemonk.in"),
 * stripped of trailing slashes.
 *
 * All user-facing links (invites, password resets, client portal links) MUST use
 * a publicly accessible domain so recipients opening emails or links on phones/laptops
 * can reach the app.
 */
export function getFrontendOrigin(req?: Request): string {
  // 1. Check incoming request Origin / Referer (if it's a real public web domain)
  if (req?.headers) {
    const rawOrigin =
      typeof req.headers.origin === 'string'
        ? req.headers.origin
        : typeof req.headers.referer === 'string'
          ? req.headers.referer
          : undefined;

    if (rawOrigin) {
      try {
        const u = new URL(rawOrigin);
        if (
          u.protocol.startsWith('http') &&
          u.hostname !== 'localhost' &&
          u.hostname !== '127.0.0.1' &&
          !u.hostname.startsWith('192.168.') &&
          !u.hostname.startsWith('10.')
        ) {
          return u.origin.replace(/\/$/, '');
        }
      } catch {
        // ignore invalid URL
      }
    }
  }

  // 2. Check FRONTEND_ORIGIN env var for any non-localhost URL
  const rawEnv = env.FRONTEND_ORIGIN || process.env.FRONTEND_ORIGIN || '';
  const origins = rawEnv
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const live = origins.find((o) => {
    try {
      const u = new URL(o);
      return (
        u.hostname !== 'localhost' &&
        u.hostname !== '127.0.0.1' &&
        !u.hostname.startsWith('192.168.') &&
        !u.hostname.startsWith('10.')
      );
    } catch {
      return false;
    }
  });

  if (live) return live;

  // 3. In automated tests (Vitest), allow localhost if no live origin exists
  if (process.env.NODE_ENV === 'test' && origins.length > 0) {
    return origins[0];
  }

  // 4. Default live domain for production and all email/invite links
  return 'https://app.thecreativemonk.in';
}
