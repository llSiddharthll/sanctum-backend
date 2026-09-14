import crypto from 'node:crypto';
import type { Request } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env.js';
import type { MetaPage } from './meta.js';

const STATE_KEY = new TextEncoder().encode(`${env.JWT_ACCESS_SECRET}:meta-oauth-state`);
const STATE_AUD = 'sanctum:meta-oauth';

export interface OAuthState {
  agencyId: string;
  clientId: string;
  userId: string;
}

/**
 * Signed, 10-minute `state` for the Meta login round-trip. It carries who is
 * connecting which client, so the callback needs no cookie — the API and the
 * web app are on different sites, where third-party cookies are unreliable.
 */
export async function signOAuthState(s: OAuthState): Promise<string> {
  return new SignJWT({
    a: s.agencyId,
    c: s.clientId,
    u: s.userId,
    n: crypto.randomBytes(8).toString('hex'),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(STATE_AUD)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(STATE_KEY);
}

export async function verifyOAuthState(token: string): Promise<OAuthState | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, STATE_KEY, { audience: STATE_AUD });
    const { a, c, u } = payload as Record<string, unknown>;
    if (typeof a !== 'string' || typeof c !== 'string' || typeof u !== 'string') {
      return null;
    }
    return { agencyId: a, clientId: c, userId: u };
  } catch {
    return null;
  }
}

/** Public origin of this API as the browser reaches it (trust proxy is on behind nginx). */
export function apiOrigin(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

/** Must be byte-identical in the login dialog and the code exchange. */
export function metaRedirectUri(req: Request): string {
  return env.META_REDIRECT_URI ?? `${apiOrigin(req)}/api/v1/oauth/meta/callback`;
}

/** Sealed contents of a social_connect_sessions row. Page tokens never leave the server. */
export interface ConnectSessionPayload {
  metaUserId: string;
  pages: MetaPage[];
}
