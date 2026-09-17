import crypto from 'node:crypto';
import type { Request } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { socialConnectSessions } from '../db/schema.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { sealToString, unsealString } from './vault.js';
import type { MetaPage } from './meta.js';

/**
 * Purpose-bound signing key for the OAuth `state`: HMAC(secret, 'oauth-state').
 * Uses OAUTH_STATE_SECRET when set (TODO(env): declare it in env.ts), else the
 * access-token secret — derived, so a state can never verify as another token.
 */
const STATE_KEY = crypto
  .createHmac('sha256', env.OAUTH_STATE_SECRET || env.JWT_ACCESS_SECRET)
  .update('oauth-state')
  .digest();
const STATE_AUD = 'sanctum:meta-oauth';
const STATE_TTL_MS = 10 * 60_000;

export interface OAuthState {
  agencyId: string;
  clientId: string;
  userId: string;
  /** social_connect_sessions row reserved for this login (single use). */
  sessionId: string;
  nonce: string;
}

/** Sealed payload of a reserved (not yet completed) connect session. */
interface PendingPayload {
  pending: true;
  nonce: string;
}

/**
 * Start a Meta login for (agency, client, user). Reserves a single-use
 * social_connect_sessions row holding a random nonce, and returns a signed,
 * 10-minute `state` bound to that row + the initiating user and client. The
 * callback needs no cookie (API and web app are on different sites).
 */
export async function signOAuthState(s: {
  agencyId: string;
  clientId: string;
  userId: string;
}): Promise<string> {
  const nonce = crypto.randomBytes(16).toString('hex');
  const sessionId = newId('scs');
  const pending: PendingPayload = { pending: true, nonce };
  await db.insert(socialConnectSessions).values({
    id: sessionId,
    agencyId: s.agencyId,
    clientId: s.clientId,
    userId: s.userId,
    payloadEnc: sealToString(JSON.stringify(pending)),
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return new SignJWT({ a: s.agencyId, c: s.clientId, u: s.userId, s: sessionId, n: nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(STATE_AUD)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(STATE_KEY);
}

/** Verify the signature/expiry of a state (does NOT consume it). */
export async function verifyOAuthState(token: string): Promise<OAuthState | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, STATE_KEY, { audience: STATE_AUD });
    const { a, c, u, s, n } = payload as Record<string, unknown>;
    if ([a, c, u, s, n].some((v) => typeof v !== 'string' || !v)) return null;
    return {
      agencyId: a as string,
      clientId: c as string,
      userId: u as string,
      sessionId: s as string,
      nonce: n as string,
    };
  } catch {
    return null;
  }
}

/**
 * Consume a verified state exactly once: atomically deletes the reserved row
 * (bound to the same agency, client and user, unexpired) and checks its nonce.
 * A replayed or forged state returns false.
 */
export async function consumeOAuthState(state: OAuthState): Promise<boolean> {
  const rows = await db
    .delete(socialConnectSessions)
    .where(
      and(
        eq(socialConnectSessions.id, state.sessionId),
        eq(socialConnectSessions.agencyId, state.agencyId),
        eq(socialConnectSessions.clientId, state.clientId),
        eq(socialConnectSessions.userId, state.userId),
        gt(socialConnectSessions.expiresAt, new Date()),
      ),
    )
    .returning({ payloadEnc: socialConnectSessions.payloadEnc });
  if (rows.length !== 1) return false;
  try {
    const p = JSON.parse(unsealString(rows[0]!.payloadEnc)) as Partial<PendingPayload>;
    if (p.pending !== true || typeof p.nonce !== 'string') return false;
    const a = Buffer.from(p.nonce);
    const b = Buffer.from(state.nonce);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** True for a reserved-but-not-completed session payload (never selectable). */
export function isPendingPayload(p: unknown): boolean {
  return !!p && typeof p === 'object' && (p as { pending?: unknown }).pending === true;
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
