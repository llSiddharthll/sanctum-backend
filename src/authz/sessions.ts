/**
 * Server-side sessions (design §I.2).
 *
 * Access token (JWT, 15 min): { sub, sid, aid, at, typ:'access', v:2 } — identity
 * only, never role/permissions. Refresh token: opaque random string; only its
 * sha256 is stored. Every refresh rotates it; presenting the previous refresh
 * token again (reuse) revokes the session.
 */
import crypto from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import { db } from '../db/client.js';
import { portalTokens, sessions, users } from '../db/schema.js';
import { env } from '../env.js';
import { newId, hashToken } from '../lib/ids.js';
import { unauthenticated } from '../lib/errors.js';

export const ACCESS_TTL_SECONDS = 15 * 60;
const USER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const LINK_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export type SessionActorType = 'staff' | 'client' | 'portal_link';

export interface AccessClaimsV2 extends JWTPayload {
  sub: string;
  sid: string;
  aid: string;
  at: SessionActorType;
  typ: 'access';
  v: 2;
}

export async function signSessionAccessToken(input: {
  sessionId: string;
  subject: string;
  agencyId: string;
  actorType: SessionActorType;
}): Promise<string> {
  return new SignJWT({
    sid: input.sessionId,
    aid: input.agencyId,
    at: input.actorType,
    typ: 'access',
    v: 2,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(accessKey);
}

/** Verify any access JWT (v2 session token or legacy role token). */
export async function verifyAnyAccessToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, accessKey);
  if (typeof payload.sub !== 'string') throw new Error('bad token');
  const isV2 = payload.v === 2 && payload.typ === 'access' && typeof payload.sid === 'string';
  const isLegacy = payload.type === 'access' && typeof payload.role === 'string';
  if (!isV2 && !isLegacy) throw new Error('bad token');
  return payload;
}

function newRefreshToken(): { raw: string; hash: string } {
  const raw = `rft_${crypto.randomBytes(32).toString('base64url')}`;
  return { raw, hash: hashToken(raw) };
}

export interface IssuedSession {
  sessionId: string;
  access: string;
  refresh: string;
  expiresAt: Date;
}

export async function createSession(input: {
  actorType: SessionActorType;
  agencyId: string;
  userId?: string;
  portalTokenId?: string;
  /** Hard cap (e.g. the share link's own expiry). */
  notAfter?: Date | null;
  req?: Request;
}): Promise<IssuedSession> {
  const ttl =
    input.actorType === 'portal_link' ? LINK_SESSION_TTL_SECONDS : USER_SESSION_TTL_SECONDS;
  let expiresAt = new Date(Date.now() + ttl * 1000);
  if (input.notAfter && input.notAfter < expiresAt) expiresAt = input.notAfter;
  const sessionId = newId('ses');
  const { raw, hash } = newRefreshToken();
  await db.insert(sessions).values({
    id: sessionId,
    agencyId: input.agencyId,
    actorType: input.actorType,
    userId: input.userId ?? null,
    portalTokenId: input.portalTokenId ?? null,
    refreshHash: hash,
    expiresAt,
    lastSeenAt: new Date(),
    ip: input.req?.ip ?? null,
    userAgent: input.req?.headers['user-agent']?.slice(0, 300) ?? null,
  });
  const access = await signSessionAccessToken({
    sessionId,
    subject: input.userId ?? input.portalTokenId!,
    agencyId: input.agencyId,
    actorType: input.actorType,
  });
  return { sessionId, access, refresh: raw, expiresAt };
}

// ------------------------------------------------------------ lookup (cached)

type SessionRow = typeof sessions.$inferSelect;
const SESSION_CACHE_MS = 3_000;
const sessionCache = new Map<string, { row: SessionRow | null; at: number }>();

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const hit = sessionCache.get(sessionId);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.row;
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  sessionCache.set(sessionId, { row: row ?? null, at: Date.now() });
  if (sessionCache.size > 10_000) {
    const first = sessionCache.keys().next().value;
    if (first !== undefined) sessionCache.delete(first);
  }
  return row ?? null;
}

export function sessionIsLive(s: SessionRow | null): s is SessionRow {
  return !!s && !s.revokedAt && s.expiresAt.getTime() > Date.now();
}

// ------------------------------------------------------------ refresh

export async function rotateRefresh(
  rawRefresh: string,
): Promise<{ session: SessionRow; access: string; refresh: string }> {
  const hash = hashToken(rawRefresh);
  const [current] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshHash, hash))
    .limit(1);

  if (!current) {
    // Reuse of an already-rotated token → the token was stolen or replayed.
    const [reused] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.prevRefreshHash, hash))
      .limit(1);
    if (reused && !reused.revokedAt) {
      await revokeSessions([reused.id], 'refresh_reuse');
    }
    throw unauthenticated('Invalid refresh token.');
  }
  if (!sessionIsLive(current)) throw unauthenticated('Session expired.');

  // Principal must still be valid.
  if (current.userId) {
    const [u] = await db
      .select({ status: users.status, agencyId: users.agencyId })
      .from(users)
      .where(eq(users.id, current.userId))
      .limit(1);
    if (!u || u.status !== 'active' || u.agencyId !== current.agencyId) {
      await revokeSessions([current.id], 'principal_inactive');
      throw unauthenticated('Session no longer valid.');
    }
  }
  if (current.portalTokenId) {
    const [t] = await db
      .select({ revoked: portalTokens.revoked, expiresAt: portalTokens.expiresAt })
      .from(portalTokens)
      .where(eq(portalTokens.id, current.portalTokenId))
      .limit(1);
    if (!t || t.revoked || (t.expiresAt && t.expiresAt.getTime() <= Date.now())) {
      await revokeSessions([current.id], 'link_revoked');
      throw unauthenticated('This link is no longer valid.');
    }
  }

  const next = newRefreshToken();
  const updated = await db
    .update(sessions)
    .set({ refreshHash: next.hash, prevRefreshHash: hash, lastSeenAt: new Date() })
    .where(and(eq(sessions.id, current.id), eq(sessions.refreshHash, hash)))
    .returning({ id: sessions.id });
  if (!updated.length) throw unauthenticated('Invalid refresh token.'); // raced
  sessionCache.delete(current.id);

  const access = await signSessionAccessToken({
    sessionId: current.id,
    subject: current.userId ?? current.portalTokenId!,
    agencyId: current.agencyId,
    actorType: current.actorType,
  });
  return { session: current, access, refresh: next.raw };
}

// ------------------------------------------------------------ revocation

let onRevoked: ((sessionIds: string[]) => void) | undefined;
export function setSessionRevokeHook(fn: (sessionIds: string[]) => void): void {
  onRevoked = fn;
}

export async function revokeSessions(ids: string[], reason: string): Promise<void> {
  if (!ids.length) return;
  for (const id of ids) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
    sessionCache.delete(id);
  }
  onRevoked?.(ids);
}

async function liveIds(where: ReturnType<typeof and>): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(where, isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  return rows.map((r) => r.id);
}

export async function revokeUserSessions(
  userId: string,
  reason: string,
  exceptSessionId?: string | null,
): Promise<number> {
  const ids = (await liveIds(and(eq(sessions.userId, userId)))).filter(
    (id) => id !== exceptSessionId,
  );
  await revokeSessions(ids, reason);
  return ids.length;
}

export async function revokePortalTokenSessions(tokenId: string, reason: string): Promise<number> {
  const ids = await liveIds(and(eq(sessions.portalTokenId, tokenId)));
  await revokeSessions(ids, reason);
  return ids.length;
}

export async function listUserSessions(userId: string) {
  return db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        or(gt(sessions.expiresAt, new Date()), sql`0`),
      ),
    );
}

/** Test/maintenance helper. */
export function clearSessionCache(): void {
  sessionCache.clear();
}
