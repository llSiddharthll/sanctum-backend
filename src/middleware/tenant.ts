import type { NextFunction, Request, Response } from 'express';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clientAssignments,
  clients,
  portalTokens,
} from '../db/schema.js';
import { gone, notFound, unauthenticated } from '../lib/errors.js';
import { hashToken } from '../lib/ids.js';
import type { AuthContext } from '../types/index.js';
import { portalLinkActor } from '../authz/http.js';

/** Pull the verified auth context off the request (throws if absent). */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}

/** Owner/admin see all clients; members are restricted to assignments. */
export function isPrivileged(role: AuthContext['role']): boolean {
  return role === 'owner' || role === 'admin';
}

/** Client ids a member is assigned to (tenant-scoped). */
export async function assignedClientIds(
  ctx: AuthContext,
): Promise<string[]> {
  const rows = await db
    .select({ clientId: clientAssignments.clientId })
    .from(clientAssignments)
    .where(
      and(
        eq(clientAssignments.agencyId, ctx.agencyId),
        eq(clientAssignments.userId, ctx.userId),
      ),
    );
  return rows.map((r) => r.clientId);
}

/**
 * Verify a client belongs to the caller's agency. Returns the client row or
 * throws 404 — cross-tenant existence is never revealed. Access within the
 * agency is governed by the 'clients' module permission (the route gate), not
 * by per-member assignment: any teammate who can use the Clients module reaches
 * every client in their agency.
 */
export async function requireClientAccess(
  ctx: AuthContext,
  clientId: string,
) {
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);

  if (!client) throw notFound('Client not found.');
  return client;
}

/**
 * Share-link middleware (token-only /portal API): resolve
 * `Authorization: Bearer <rawToken>` to a `portal_link` ACTOR (req.actor) whose
 * grants come from the link's client role and whose project access is the
 * link's. Unknown → 404, revoked/expired → 410. No session is created.
 */
export async function requirePortalToken(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    const raw =
      header && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : undefined;
    if (!raw) throw unauthenticated('Portal token required.');

    const [tok] = await db
      .select({
        id: portalTokens.id,
        agencyId: portalTokens.agencyId,
        revoked: portalTokens.revoked,
        expiresAt: portalTokens.expiresAt,
      })
      .from(portalTokens)
      .where(eq(portalTokens.tokenHash, hashToken(raw)))
      .limit(1);

    if (!tok) throw notFound('Invalid link.');
    if (tok.revoked) throw gone('This link has been revoked.');
    if (tok.expiresAt && tok.expiresAt.getTime() <= Date.now()) {
      throw gone('This link has expired.');
    }

    // Grants = the link role's grants (empty when the link has no role).
    req.actor = await portalLinkActor(tok.id, tok.agencyId, null);

    // Best-effort touch of last-used.
    void db
      .update(portalTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(portalTokens.id, tok.id))
      .catch(() => undefined);

    next();
  } catch (err) {
    next(err);
  }
}

/** Active-token resolution predicate (reusable in queries). */
export function activeTokenWhere(tokenHash: string) {
  return and(
    eq(portalTokens.tokenHash, tokenHash),
    eq(portalTokens.revoked, false),
    or(isNull(portalTokens.expiresAt), gt(portalTokens.expiresAt, new Date())),
  );
}
