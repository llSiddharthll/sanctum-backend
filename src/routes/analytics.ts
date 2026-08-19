import { Router } from 'express';
import {
  and,
  count,
  eq,
  ne,
  gte,
  lt,
  lte,
  inArray,
  isNotNull,
} from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  contentPosts,
  projectTasks,
  projects,
  users,
  taskAssignees,
  timeLogs,
  attendanceRecords,
  leaveRequests,
} from '../db/schema.js';
import { ok } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW, requireModule } from '../middleware/permissions.js';
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

/* ------------------------------------------------------------------ */
/* Team efficiency leaderboard (owner + managers).                     */
/* A read-only, on-demand ranking of employees by a composite score    */
/* built from tasks + time + attendance already in the DB — no new     */
/* tables, no cron, no persisted "winner". See the score model below.  */
/* ------------------------------------------------------------------ */

// Priority → points (finishing harder work counts for more; capped per task).
const PRIORITY_WEIGHT: Record<string, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0.5,
};
// Component weights (sum = 1). Quality/rework is intentionally deferred.
const W_ONTIME = 0.4;
const W_THROUGHPUT = 0.35;
const W_TIME = 0.15;
const W_ATTENDANCE = 0.1;
// A missing signal (no due dates / no estimates / no attendance) scores neutral
// rather than zero, so people aren't punished for gaps in tracking.
const NEUTRAL = 0.7;
// Minimum completed tasks in the month to be ranked (keeps a one-off out of #1).
const MIN_COMPLETED = 3;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const isWeekday = (d: Date) => {
  const g = d.getUTCDay();
  return g !== 0 && g !== 6;
};
/** Count Mon–Fri days in [from, toExclusive). */
function weekdaysBetween(from: Date, toExclusive: Date): number {
  let n = 0;
  const d = new Date(from);
  while (d < toExclusive) {
    if (isWeekday(d)) n += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

analyticsRouter.get(
  '/leaderboard',
  // Owner/admin + managers only (projects:manage) — employees (projects:edit)
  // can't see the ranking of their peers.
  requireModule('projects', 'manage'),
  async (req, res) => {
    const ctx = getAuth(req);
    const now = new Date();

    // Month = ?month=YYYY-MM, default current month (UTC).
    const monthParam =
      typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)
        ? req.query.month
        : `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
    const [year, mon] = monthParam.split('-').map(Number);
    const start = new Date(Date.UTC(year, mon - 1, 1));
    const end = new Date(Date.UTC(year, mon, 1)); // exclusive
    const startStr = ymd(start);
    const endStr = ymd(new Date(end.getTime() - 86_400_000)); // last day inclusive
    // For working-day math, only count elapsed days when it's the current month.
    const elapsedEnd =
      end < now
        ? end
        : new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate() + 1,
            ),
          );
    const elapsedWeekdays = Math.max(1, weekdaysBetween(start, elapsedEnd));

    const emptyOut = {
      month: monthParam,
      generatedAt: now.toISOString(),
      teamAvgScore: 0,
      entries: [] as unknown[],
      ineligible: [] as unknown[],
    };

    // Employees = active member-tier users (owner/admin/client excluded).
    const employees = await db
      .select({
        id: users.id,
        name: users.fullName,
        designation: users.designation,
      })
      .from(users)
      .where(
        and(
          eq(users.agencyId, ctx.agencyId),
          eq(users.role, 'member'),
          eq(users.status, 'active'),
        ),
      );
    if (employees.length === 0) return ok(res, emptyOut);

    // Tasks completed within the month.
    const completed = await db
      .select({
        id: projectTasks.id,
        assigneeId: projectTasks.assigneeId,
        priority: projectTasks.priority,
        dueDate: projectTasks.dueDate,
        completedAt: projectTasks.completedAt,
        estimateMinutes: projectTasks.estimateMinutes,
      })
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.agencyId, ctx.agencyId),
          eq(projectTasks.status, 'done'),
          isNotNull(projectTasks.completedAt),
          gte(projectTasks.completedAt, start),
          lt(projectTasks.completedAt, end),
        ),
      );

    // Currently-overdue open tasks (penalty; not month-scoped).
    const overdue = await db
      .select({ id: projectTasks.id, assigneeId: projectTasks.assigneeId })
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.agencyId, ctx.agencyId),
          ne(projectTasks.status, 'done'),
          isNotNull(projectTasks.dueDate),
          lt(projectTasks.dueDate, now),
        ),
      );

    // Extra (multi-)assignees for the relevant tasks.
    const relevantIds = [
      ...new Set([...completed.map((t) => t.id), ...overdue.map((t) => t.id)]),
    ];
    const assigneeRows = relevantIds.length
      ? await db
          .select({
            taskId: taskAssignees.taskId,
            userId: taskAssignees.userId,
          })
          .from(taskAssignees)
          .where(
            and(
              eq(taskAssignees.agencyId, ctx.agencyId),
              inArray(taskAssignees.taskId, relevantIds),
            ),
          )
      : [];
    const extra = new Map<string, Set<string>>();
    for (const r of assigneeRows) {
      if (!extra.has(r.taskId)) extra.set(r.taskId, new Set());
      extra.get(r.taskId)!.add(r.userId);
    }
    const assigneesOf = (taskId: string, primary: string | null): string[] => {
      const s = new Set<string>(extra.get(taskId) ?? []);
      if (primary) s.add(primary);
      return [...s];
    };

    // Actual minutes logged per task this month (for time efficiency).
    const logs = await db
      .select({ taskId: timeLogs.taskId, minutes: timeLogs.minutes })
      .from(timeLogs)
      .where(
        and(
          eq(timeLogs.agencyId, ctx.agencyId),
          gte(timeLogs.workDate, start),
          lt(timeLogs.workDate, end),
        ),
      );
    const actualMin = new Map<string, number>();
    for (const l of logs) {
      if (l.taskId)
        actualMin.set(l.taskId, (actualMin.get(l.taskId) ?? 0) + l.minutes);
    }

    // Attendance for the month.
    const att = await db
      .select({
        userId: attendanceRecords.userId,
        status: attendanceRecords.status,
        isLate: attendanceRecords.isLate,
      })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.agencyId, ctx.agencyId),
          gte(attendanceRecords.day, startStr),
          lte(attendanceRecords.day, endStr),
        ),
      );

    // Approved leaves overlapping the month (reduce expected working days).
    const leaves = await db
      .select({
        userId: leaveRequests.userId,
        startDay: leaveRequests.startDay,
        endDay: leaveRequests.endDay,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.agencyId, ctx.agencyId),
          eq(leaveRequests.status, 'approved'),
          lte(leaveRequests.startDay, endStr),
          gte(leaveRequests.endDay, startStr),
        ),
      );
    const leaveDaysByUser = new Map<string, number>();
    for (const lv of leaves) {
      const from = new Date(
        `${lv.startDay > startStr ? lv.startDay : startStr}T00:00:00.000Z`,
      );
      const toIncl =
        lv.endDay < ymd(new Date(elapsedEnd.getTime() - 86_400_000))
          ? lv.endDay
          : ymd(new Date(elapsedEnd.getTime() - 86_400_000));
      const toExcl = new Date(`${toIncl}T00:00:00.000Z`);
      toExcl.setUTCDate(toExcl.getUTCDate() + 1);
      const wd = from <= toExcl ? weekdaysBetween(from, toExcl) : 0;
      leaveDaysByUser.set(
        lv.userId,
        (leaveDaysByUser.get(lv.userId) ?? 0) + Math.max(0, wd),
      );
    }

    // ---- Per-user accumulation ----
    type Acc = {
      completed: number;
      points: number;
      dueCount: number;
      onTimeCount: number;
      effSum: number;
      effCount: number;
      overdue: number;
    };
    const acc = new Map<string, Acc>();
    const ensure = (id: string): Acc => {
      let a = acc.get(id);
      if (!a) {
        a = {
          completed: 0,
          points: 0,
          dueCount: 0,
          onTimeCount: 0,
          effSum: 0,
          effCount: 0,
          overdue: 0,
        };
        acc.set(id, a);
      }
      return a;
    };
    const empIds = new Set(employees.map((e) => e.id));

    for (const t of completed) {
      const pts = PRIORITY_WEIGHT[t.priority ?? 'none'] ?? 0.5;
      for (const uid of assigneesOf(t.id, t.assigneeId)) {
        if (!empIds.has(uid)) continue;
        const a = ensure(uid);
        a.completed += 1;
        a.points += pts;
        if (t.dueDate) {
          a.dueCount += 1;
          if (t.completedAt && t.completedAt.getTime() <= t.dueDate.getTime())
            a.onTimeCount += 1;
        }
        const est = t.estimateMinutes ?? 0;
        const actual = actualMin.get(t.id) ?? 0;
        if (est > 0 && actual > 0) {
          a.effSum += clamp01(est / actual);
          a.effCount += 1;
        }
      }
    }
    for (const t of overdue) {
      for (const uid of assigneesOf(t.id, t.assigneeId)) {
        if (!empIds.has(uid)) continue;
        ensure(uid).overdue += 1;
      }
    }

    const attByUser = new Map<
      string,
      { worked: number; late: number }
    >();
    for (const r of att) {
      if (!empIds.has(r.userId)) continue;
      const e = attByUser.get(r.userId) ?? { worked: 0, late: 0 };
      if (r.status === 'present' || r.status === 'late') e.worked += 1;
      else if (r.status === 'half_day') e.worked += 0.5;
      if (r.isLate) e.late += 1;
      attByUser.set(r.userId, e);
    }

    // First pass: raw component values per user.
    const raw = employees.map((e) => {
      const a = acc.get(e.id) ?? {
        completed: 0,
        points: 0,
        dueCount: 0,
        onTimeCount: 0,
        effSum: 0,
        effCount: 0,
        overdue: 0,
      };
      const available = Math.max(
        1,
        elapsedWeekdays - (leaveDaysByUser.get(e.id) ?? 0),
      );
      const pointsPerDay = a.points / available;
      const onTime = a.dueCount > 0 ? a.onTimeCount / a.dueCount : null;
      const timeEff = a.effCount > 0 ? a.effSum / a.effCount : null;
      const attRec = attByUser.get(e.id);
      const attendance = attRec
        ? clamp01(attRec.worked / available - attRec.late * 0.02)
        : null;
      return {
        userId: e.id,
        name: e.name ?? 'Teammate',
        designation: e.designation ?? null,
        completed: a.completed,
        pointsPerDay,
        onTime,
        timeEff,
        attendance,
        overdue: a.overdue,
        estimateCoverage:
          a.completed > 0 ? a.effCount / a.completed : 0,
      };
    });

    // Normalise throughput against the strongest eligible performer.
    const maxPPD = Math.max(
      0,
      ...raw.filter((r) => r.completed >= MIN_COMPLETED).map((r) => r.pointsPerDay),
    );

    const scored = raw.map((r) => {
      const throughput = maxPPD > 0 ? clamp01(r.pointsPerDay / maxPPD) : 0;
      const onTime = r.onTime ?? NEUTRAL;
      const timeEff = r.timeEff ?? NEUTRAL;
      const attendance = r.attendance ?? NEUTRAL;
      const penalty = Math.min(0.15, r.overdue * 0.03);
      const composite = clamp01(
        W_ONTIME * onTime +
          W_THROUGHPUT * throughput +
          W_TIME * timeEff +
          W_ATTENDANCE * attendance -
          penalty,
      );
      return {
        userId: r.userId,
        name: r.name,
        designation: r.designation,
        score: Math.round(composite * 100),
        completedTasks: r.completed,
        onTimeRate: r.onTime === null ? null : Math.round(r.onTime * 100),
        throughput: Math.round(throughput * 100),
        pointsPerDay: Math.round(r.pointsPerDay * 100) / 100,
        timeEfficiency: r.timeEff === null ? null : Math.round(r.timeEff * 100),
        attendance: r.attendance === null ? null : Math.round(r.attendance * 100),
        estimateCoverage: Math.round(r.estimateCoverage * 100),
        overdueOpen: r.overdue,
        eligible: r.completed >= MIN_COMPLETED,
      };
    });

    const entries = scored
      .filter((s) => s.eligible)
      .sort((a, b) => b.score - a.score || b.completedTasks - a.completedTasks)
      .map((s, i) => ({ rank: i + 1, ...s }));
    const ineligible = scored
      .filter((s) => !s.eligible)
      .sort((a, b) => b.completedTasks - a.completedTasks)
      .map((s) => ({
        userId: s.userId,
        name: s.name,
        designation: s.designation,
        completedTasks: s.completedTasks,
      }));

    const teamAvgScore = entries.length
      ? Math.round(entries.reduce((n, e) => n + e.score, 0) / entries.length)
      : 0;

    ok(res, {
      month: monthParam,
      generatedAt: now.toISOString(),
      minCompleted: MIN_COMPLETED,
      teamAvgScore,
      entries,
      ineligible,
    });
  },
);
