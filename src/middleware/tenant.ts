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
import type { AuthContext, PortalContext } from '../types/index.js';

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
 * Portal middleware: resolve `Authorization: Bearer <rawToken>` (or :token
 * path param) to EXACTLY one { agencyId, clientId }. Populates req.portal.
 */
export async function requirePortalToken(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    const bearer =
      header && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : undefined;
    const raw = bearer ?? (req.params.token as string | undefined);

    if (!raw) throw unauthenticated('Portal token required.');

    const tokenHash = hashToken(raw);
    const [tok] = await db
      .select()
      .from(portalTokens)
      .where(eq(portalTokens.tokenHash, tokenHash))
      .limit(1);

    if (!tok) throw notFound('Invalid link.');

    if (tok.revoked) throw gone('This link has been revoked.');
    if (tok.expiresAt && tok.expiresAt.getTime() <= Date.now()) {
      throw gone('This link has expired.');
    }

    // Best-effort touch of last-used.
    void db
      .update(portalTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(portalTokens.id, tok.id))
      .catch(() => undefined);

    const portal: PortalContext = {
      tokenId: tok.id,
      agencyId: tok.agencyId,
      clientId: tok.clientId,
    };
    req.portal = portal;
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
