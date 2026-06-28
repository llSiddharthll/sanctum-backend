import { Router } from 'express';
import { and, count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, contentPosts } from '../db/schema.js';
import { ok } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

// GET /analytics/summary — agency-wide counts by status + client/post totals.
// Gated on the Dashboard module (view), so members see the overview too — it's
// agency content stats, consistent with members seeing all clients.
analyticsRouter.get(
  '/summary',
  requireModuleRW('dashboard'),
  async (req, res) => {
    const ctx = getAuth(req);

    const byStatus = await db
      .select({ status: contentPosts.status, n: count() })
      .from(contentPosts)
      .where(eq(contentPosts.agencyId, ctx.agencyId))
      .groupBy(contentPosts.status);

    const statusCounts: Record<string, number> = {};
    for (const row of byStatus) statusCounts[row.status] = row.n;

    const [clientTotals] = await db
      .select({ n: count() })
      .from(clients)
      .where(
        and(
          eq(clients.agencyId, ctx.agencyId),
          eq(clients.status, 'active'),
        ),
      );

    const [postTotals] = await db
      .select({ n: count() })
      .from(contentPosts)
      .where(eq(contentPosts.agencyId, ctx.agencyId));

    ok(res, {
      clients: clientTotals?.n ?? 0,
      posts: postTotals?.n ?? 0,
      postsByStatus: statusCounts,
    });
  },
);
