import type { NextFunction, Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clientUserProjects, projects } from '../db/schema.js';
import { forbidden, unauthenticated } from '../lib/errors.js';
import { getAuth } from './tenant.js';
import type { ClientContext } from '../types/index.js';

/**
 * Gate a route to a logged-in `client` user and resolve their scope. Must run
 * after requireAuth. Loads the set of project ids the client may see:
 *   - explicit rows in `client_user_projects` → exactly those projects
 *   - no rows → ALL of the client's (brand's) projects
 * Populates req.clientCtx. Any non-client role → 403.
 */
export async function requireClientAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx = getAuth(req);
    if (ctx.role !== 'client' || !ctx.clientId) {
      throw forbidden('Client access only.');
    }

    const scoped = await db
      .select({ projectId: clientUserProjects.projectId })
      .from(clientUserProjects)
      .where(
        and(
          eq(clientUserProjects.agencyId, ctx.agencyId),
          eq(clientUserProjects.userId, ctx.userId),
        ),
      );

    let projectIds: string[];
    let allProjects: boolean;
    if (scoped.length > 0) {
      projectIds = scoped.map((r) => r.projectId);
      allProjects = false;
    } else {
      const all = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.agencyId, ctx.agencyId),
            eq(projects.clientId, ctx.clientId),
          ),
        );
      projectIds = all.map((r) => r.id);
      allProjects = true;
    }

    const clientCtx: ClientContext = {
      userId: ctx.userId,
      agencyId: ctx.agencyId,
      clientId: ctx.clientId,
      projectIds,
      allProjects,
    };
    req.clientCtx = clientCtx;
    next();
  } catch (err) {
    next(err);
  }
}

/** Pull the resolved client context off the request (throws if absent). */
export function getClientCtx(req: Request): ClientContext {
  if (!req.clientCtx) throw unauthenticated();
  return req.clientCtx;
}
