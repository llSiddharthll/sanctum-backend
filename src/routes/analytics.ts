import { Router } from 'express';
import { and, count, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  contentPosts,
  projectTasks,
  projects,
  users,
} from '../db/schema.js';
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

// GET /analytics/team-overview — projects (by status/health) + tasks (by status)
// + team size, for the Manager dashboard. Gated on the Projects module (view),
// which the Manager preset grants.
analyticsRouter.get(
  '/team-overview',
  requireModuleRW('projects'),
  async (req, res) => {
    const ctx = getAuth(req);
    const toMap = <T extends { n: number }>(rows: T[], key: keyof T) =>
      rows.reduce<Record<string, number>>((acc, r) => {
        acc[String(r[key])] = Number(r.n);
        return acc;
      }, {});

    const projByStatus = await db
      .select({ status: projects.status, n: count() })
      .from(projects)
      .where(eq(projects.agencyId, ctx.agencyId))
      .groupBy(projects.status);
    const projByHealth = await db
      .select({ health: projects.health, n: count() })
      .from(projects)
      .where(eq(projects.agencyId, ctx.agencyId))
      .groupBy(projects.health);
    const taskByStatus = await db
      .select({ status: projectTasks.status, n: count() })
      .from(projectTasks)
      .where(eq(projectTasks.agencyId, ctx.agencyId))
      .groupBy(projectTasks.status);
    const [members] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.agencyId, ctx.agencyId), ne(users.role, 'client')));
    const [activeProjects] = await db
      .select({ n: count() })
      .from(projects)
      .where(
        and(eq(projects.agencyId, ctx.agencyId), eq(projects.status, 'active')),
      );

    ok(res, {
      projectsByStatus: toMap(projByStatus, 'status'),
      projectsByHealth: toMap(projByHealth, 'health'),
      tasksByStatus: toMap(taskByStatus, 'status'),
      memberCount: members?.n ?? 0,
      activeProjects: activeProjects?.n ?? 0,
    });
  },
);
