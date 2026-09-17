import { and, eq, or, gte, lte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roles, userRoles, users, timeLogs, projectTasks, taskAssignees } from '../db/schema.js';
import { forbidden } from '../lib/errors.js';
import type { Actor } from '../authz/actor.js';
import { canOrg } from '../authz/engine.js';
import { usersWithPermission } from '../authz/resolver.js';
import { loadPolicy, buildRange, summarizeDays, daysInRange } from './attendance.js';
import { sendEmployeeReport, sendTeamReport } from './email.js';

export interface EmployeeReport {
  userId: string;
  name: string;
  email: string;
  attendance: ReturnType<typeof summarizeDays>;
  timeMinutes: number;
  tasks: { open: number; overdue: number; completed: number };
  utilizationPct: number;
}

/** Fractional weeks in an inclusive day range (min 1) — for scaling capacity. */
function weeksInRange(fromKey: string, toKey: string): number {
  return Math.max(1, daysInRange(fromKey, toKey).length / 7);
}

/**
 * Build one employee's report for a date range: attendance rollup, minutes
 * logged, task counts (open/overdue/completed-in-range) and utilization
 * (logged time vs weekly capacity scaled across the range).
 */
export async function buildEmployeeReport(
  agencyId: string,
  user: {
    id: string;
    name: string;
    email: string;
    weeklyCapacityHrs: number | null;
  },
  policy: Awaited<ReturnType<typeof loadPolicy>>,
  fromKey: string,
  toKey: string,
): Promise<EmployeeReport> {
  const fromDate = new Date(`${fromKey}T00:00:00.000Z`);
  const toDate = new Date(`${toKey}T23:59:59.999Z`);

  const attendance = summarizeDays(
    await buildRange(agencyId, user.id, policy, fromKey, toKey),
  );

  const [{ total: timeMinutes } = { total: 0 }] = await db
    .select({ total: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)` })
    .from(timeLogs)
    .where(
      and(
        eq(timeLogs.agencyId, agencyId),
        eq(timeLogs.userId, user.id),
        gte(timeLogs.workDate, fromDate),
        lte(timeLogs.workDate, toDate),
      ),
    );

  // Tasks assigned to this user (primary mirror OR the M:N join).
  const assignedIds = db
    .select({ taskId: taskAssignees.taskId })
    .from(taskAssignees)
    .where(eq(taskAssignees.userId, user.id));
  const taskRows = await db
    .select({
      status: projectTasks.status,
      completedAt: projectTasks.completedAt,
      dueDate: projectTasks.dueDate,
    })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, agencyId),
        or(
          eq(projectTasks.assigneeId, user.id),
          inArray(projectTasks.id, assignedIds),
        ),
      ),
    );

  const now = Date.now();
  let open = 0;
  let overdue = 0;
  let completed = 0;
  for (const t of taskRows) {
    if (t.status === 'done') {
      if (t.completedAt && t.completedAt >= fromDate && t.completedAt <= toDate) {
        completed++;
      }
    } else {
      open++;
      if (t.dueDate && t.dueDate.getTime() < now) overdue++;
    }
  }

  const capacityMin =
    (user.weeklyCapacityHrs ?? 0) * 60 * weeksInRange(fromKey, toKey);
  const utilizationPct = capacityMin
    ? Math.round((Number(timeMinutes) / capacityMin) * 100)
    : 0;

  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    attendance,
    timeMinutes: Number(timeMinutes ?? 0),
    tasks: { open, overdue, completed },
    utilizationPct,
  };
}

/** Active staff of an agency (report subjects / recipients). */
export async function activeStaff(agencyId: string) {
  return db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      weeklyCapacityHrs: users.weeklyCapacityHrs,
    })
    .from(users)
    .where(
      and(
        eq(users.agencyId, agencyId),
        eq(users.status, 'active'),
        eq(users.kind, 'staff'),
      ),
    );
}

/** Holders of the agency's Owner role (they are not report subjects). */
async function ownerHolderIds(agencyId: string): Promise<Set<string>> {
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.agencyId, agencyId), eq(roles.key, 'owner')));
  return new Set(rows.map((r) => r.userId));
}

function requireOrg(actor: Actor, permissions: string[]): void {
  for (const p of permissions) {
    if (!canOrg(actor, p)) throw forbidden("You don't have permission to do that.");
  }
}

/**
 * Build reports for every active staff member except Owner-role holders over a
 * range. Requires `attendance.view_reports` (organization). Callers that expose
 * the result must mask time/task data the actor may not see.
 */
export async function buildAgencyReports(
  actor: Actor,
  fromKey: string,
  toKey: string,
): Promise<EmployeeReport[]> {
  requireOrg(actor, ['attendance.view_reports']);
  const agencyId = actor.agencyId;
  const policy = await loadPolicy(agencyId);
  const owners = await ownerHolderIds(agencyId);
  const staff = (await activeStaff(agencyId)).filter((u) => !owners.has(u.id));
  const reports: EmployeeReport[] = [];
  for (const u of staff) {
    reports.push(
      await buildEmployeeReport(
        agencyId,
        {
          id: u.id,
          name: u.fullName ?? u.email,
          email: u.email,
          weeklyCapacityHrs: u.weeklyCapacityHrs,
        },
        policy,
        fromKey,
        toKey,
      ),
    );
  }
  return reports;
}

/** Permissions (organization scope) a person needs to receive the team overview. */
export const TEAM_OVERVIEW_PERMISSIONS = [
  'attendance.view_reports',
  'time_logs.view',
  'tasks.view',
] as const;

/**
 * Email each employee their own report AND a combined team overview to every
 * active staff member holding TEAM_OVERVIEW_PERMISSIONS at organization scope
 * (recipients by capability, not role), for [fromKey, toKey]. The actor (a user
 * or the monthly system job) needs `attendance.email_reports` +
 * `attendance.view_reports`. Best-effort per recipient.
 *
 * `owners` in the result counts overview recipients (name kept for API compat).
 */
export async function emailEmployeeReports(
  actor: Actor,
  fromKey: string,
  toKey: string,
): Promise<{ employees: number; owners: number }> {
  requireOrg(actor, ['attendance.email_reports', 'attendance.view_reports']);
  const agencyId = actor.agencyId;
  const reports = await buildAgencyReports(actor, fromKey, toKey);
  const periodLabel = formatPeriod(fromKey, toKey);

  let employees = 0;
  for (const rep of reports) {
    const r = await sendEmployeeReport({ periodLabel, report: rep });
    if (r.ok) employees++;
  }

  const holderSets = await Promise.all(
    TEAM_OVERVIEW_PERMISSIONS.map(
      async (p) => new Set(await usersWithPermission(agencyId, p, { scope: 'organization' })),
    ),
  );
  const recipientIds = [...holderSets[0]!].filter((id) => holderSets.every((s) => s.has(id)));
  const staff = await activeStaff(agencyId);
  let overviewCount = 0;
  for (const o of staff.filter((u) => recipientIds.includes(u.id))) {
    const r = await sendTeamReport({
      to: o.email,
      name: o.fullName ?? o.email,
      periodLabel,
      members: reports,
    });
    if (r.ok) overviewCount++;
  }

  return { employees, owners: overviewCount };
}

/** "1 Aug 2026 → 19 Aug 2026" style label from two day keys. */
export function formatPeriod(fromKey: string, toKey: string): string {
  const fmt = (k: string) =>
    new Date(`${k}T00:00:00.000Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  return `${fmt(fromKey)} → ${fmt(toKey)}`;
}
