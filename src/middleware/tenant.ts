import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { portalTokens } from '../db/schema.js';
import { gone, notFound, unauthenticated } from '../lib/errors.js';
import { hashToken } from '../lib/ids.js';
import { portalLinkActor } from '../authz/http.js';

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
