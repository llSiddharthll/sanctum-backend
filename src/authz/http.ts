/**
 * HTTP adapter: authentication → Actor, and declarative permission guards.
 *
 *   router.use(authenticate)
 *   router.get('/', requires('projects.view'), handler)
 *   const actor = getActor(req)
 *
 * Every request re-validates the session (revocation), the principal's status
 * (disable/delete) and resolves grants by authz_version (permission changes are
 * effective on the next request). Nothing mutable is trusted from the token.
 */
import type { NextFunction, Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clientUserProjects,
  portalTokenProjects,
  portalTokens,
  users,
} from '../db/schema.js';
import { unauthenticated } from '../lib/errors.js';
import type { Role } from '../lib/jwt.js';
import {
  GrantSet,
  type Actor,
  type PortalLinkActor,
  type ProjectAccess,
} from './actor.js';
import { can, requirePermission } from './engine.js';
import { grantsForRole, grantsForUser } from './resolver.js';
import {
  getSession,
  sessionIsLive,
  verifyAnyAccessToken,
} from './sessions.js';

export const ACCESS_COOKIE = 'sanctum_at';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

export function readAccessToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return req.cookies?.[ACCESS_COOKIE] as string | undefined;
}

async function clientProjectAccess(
  userId: string,
  mode: 'all' | 'selected' | null,
): Promise<ProjectAccess> {
  const rows = await db
    .select({ projectId: clientUserProjects.projectId })
    .from(clientUserProjects)
    .where(eq(clientUserProjects.userId, userId));
  // NULL mode = not yet backfilled: preserve legacy semantics (rows restrict).
  const effective = mode ?? (rows.length ? 'selected' : 'all');
  return { mode: effective, projectIds: rows.map((r) => r.projectId) };
}

type UserRow = Pick<
  typeof users.$inferSelect,
  'id' | 'agencyId' | 'status' | 'kind' | 'authzVersion' | 'clientId' | 'clientProjectAccess' | 'role'
>;

async function loadUser(userId: string, agencyId: string): Promise<UserRow | null> {
  const [u] = await db
    .select({
      id: users.id,
      agencyId: users.agencyId,
      status: users.status,
      kind: users.kind,
      authzVersion: users.authzVersion,
      clientId: users.clientId,
      clientProjectAccess: users.clientProjectAccess,
      role: users.role,
    })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.agencyId, agencyId)))
    .limit(1);
  return u ?? null;
}

async function userActor(u: UserRow, sessionId: string | null): Promise<Actor> {
  if (u.status !== 'active') throw unauthenticated('Account is not active.');
  const grants = await grantsForUser({ id: u.id, kind: u.kind, authzVersion: u.authzVersion });
  if (u.kind === 'client') {
    if (!u.clientId) throw unauthenticated('Client account is not linked to a client.');
    return {
      type: 'client',
      userId: u.id,
      agencyId: u.agencyId,
      sessionId,
      authzVersion: u.authzVersion,
      clientId: u.clientId,
      projectAccess: await clientProjectAccess(u.id, u.clientProjectAccess),
      grants,
    };
  }
  return {
    type: 'staff',
    userId: u.id,
    agencyId: u.agencyId,
    sessionId,
    authzVersion: u.authzVersion,
    grants,
  };
}

export async function portalLinkActor(
  tokenId: string,
  agencyId: string,
  sessionId: string | null,
): Promise<PortalLinkActor> {
  const [t] = await db
    .select()
    .from(portalTokens)
    .where(and(eq(portalTokens.id, tokenId), eq(portalTokens.agencyId, agencyId)))
    .limit(1);
  if (!t || t.revoked || (t.expiresAt && t.expiresAt.getTime() <= Date.now())) {
    throw unauthenticated('This link is no longer valid.');
  }
  const projectIds =
    t.projectAccess === 'selected'
      ? (
          await db
            .select({ projectId: portalTokenProjects.projectId })
            .from(portalTokenProjects)
            .where(eq(portalTokenProjects.tokenId, t.id))
        ).map((r) => r.projectId)
      : [];
  return {
    type: 'portal_link',
    tokenId: t.id,
    agencyId: t.agencyId,
    sessionId,
    clientId: t.clientId,
    roleId: t.roleId,
    projectAccess: { mode: t.projectAccess, projectIds },
    grants: t.roleId ? await grantsForRole(t.roleId, t.agencyId, 'client') : GrantSet.empty(),
  };
}

/** Resolve the actor behind a live session row (REST + realtime), or throw 401. */
export async function actorFromSessionId(sessionId: string): Promise<{ actor: Actor; legacyRole: Role | null }> {
  const session = await getSession(sessionId);
  if (!sessionIsLive(session)) throw unauthenticated('Session is no longer valid.');
  if (session.actorType === 'portal_link') {
    if (!session.portalTokenId) throw unauthenticated('Session is no longer valid.');
    return {
      actor: await portalLinkActor(session.portalTokenId, session.agencyId, session.id),
      legacyRole: 'client',
    };
  }
  if (!session.userId) throw unauthenticated('Session is no longer valid.');
  const u = await loadUser(session.userId, session.agencyId);
  if (!u || u.kind !== session.actorType) throw unauthenticated('Session is no longer valid.');
  return { actor: await userActor(u, session.id), legacyRole: u.role };
}

/**
 * Actor for a user id WITHOUT a session (server-side flows that must re-check a
 * specific user's current authority, e.g. an OAuth callback). Validates status.
 */
export async function actorForUser(userId: string, agencyId: string): Promise<Actor> {
  const u = await loadUser(userId, agencyId);
  if (!u) throw unauthenticated('Session is no longer valid.');
  return userActor(u, null);
}

/** Legacy (session-less) token principal. TODO(authz phase 10): remove. */
export async function actorFromLegacyUser(userId: string, agencyId: string): Promise<{ actor: Actor; legacyRole: Role | null }> {
  const u = await loadUser(userId, agencyId);
  if (!u) throw unauthenticated('Session is no longer valid.');
  return { actor: await userActor(u, null), legacyRole: u.role };
}

/** Resolve the actor for a raw access token, or throw 401. */
export async function actorFromAccessToken(token: string): Promise<{ actor: Actor; legacyRole: Role | null }> {
  let claims;
  try {
    claims = await verifyAnyAccessToken(token);
  } catch {
    throw unauthenticated('Invalid or expired access token.');
  }
  if (claims.v === 2) {
    const r = await actorFromSessionId(claims.sid as string);
    const expectedSub = r.actor.type === 'portal_link' ? r.actor.tokenId : 'userId' in r.actor ? r.actor.userId : null;
    if (r.actor.agencyId !== claims.aid || expectedSub !== claims.sub) {
      throw unauthenticated('Session is no longer valid.');
    }
    return r;
  }
  // Legacy role-claim token (issued before sessions existed). Accepted only
  // until it expires (≤15 min after rollout); identity re-validated from DB and
  // authority comes from the new grants, never from the claim.
  // TODO(authz phase 10): remove legacy token acceptance.
  return actorFromLegacyUser(claims.sub as string, claims.agencyId as string);
}

/** Authentication middleware. Sets req.actor (and the legacy req.auth shim). */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (req.actor) return next();
    const token = readAccessToken(req);
    if (!token) throw unauthenticated('No access token.');
    const { actor, legacyRole } = await actorFromAccessToken(token);
    req.actor = actor;
    // Compatibility for routers not yet migrated to the engine.
    // TODO(authz phase 10): delete req.auth.
    if (actor.type === 'staff' || actor.type === 'client') {
      req.auth = {
        userId: actor.userId,
        agencyId: actor.agencyId,
        role: legacyRole ?? (actor.type === 'client' ? 'client' : 'member'),
        clientId: actor.type === 'client' ? actor.clientId : null,
      };
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function getActor(req: Request): Actor {
  if (!req.actor) throw unauthenticated();
  return req.actor;
}

export function getUserActor(req: Request) {
  const a = getActor(req);
  if (a.type !== 'staff' && a.type !== 'client') throw unauthenticated();
  return a;
}

/** Staff-only surface (agency app APIs). Client-side actors get 403 by permission anyway. */
export function getStaffActor(req: Request) {
  const a = getActor(req);
  if (a.type !== 'staff') {
    throw unauthenticated('Staff session required.');
  }
  return a;
}

/** Route guard: the actor must hold the permission at some scope. */
export function requires(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const actor = getActor(req);
      for (const p of permissions) requirePermission(actor, p);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Route guard: the actor must hold at least one of the permissions. */
export function requiresAny(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const actor = getActor(req);
      if (!permissions.some((p) => can(actor, p))) {
        requirePermission(actor, permissions[0]!);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
