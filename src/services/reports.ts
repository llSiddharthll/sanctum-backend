import { and, eq, ne, or, gte, lte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, timeLogs, projectTasks, taskAssignees } from '../db/schema.js';
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

/** Active non-client staff of an agency (for iterating report recipients). */
export async function activeStaff(agencyId: string) {
  return db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      role: users.role,
      weeklyCapacityHrs: users.weeklyCapacityHrs,
    })
    .from(users)
    .where(
      and(
        eq(users.agencyId, agencyId),
        eq(users.status, 'active'),
        ne(users.role, 'client'),
      ),
    );
}

/** Build reports for every non-owner staff member over a range. */
export async function buildAgencyReports(
  agencyId: string,
  fromKey: string,
  toKey: string,
): Promise<EmployeeReport[]> {
  const policy = await loadPolicy(agencyId);
  const staff = (await activeStaff(agencyId)).filter((u) => u.role !== 'owner');
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

/**
 * Email each employee their own report AND every owner a combined team
 * overview, for [fromKey, toKey]. Best-effort per recipient.
 */
export async function emailEmployeeReports(
  agencyId: string,
  fromKey: string,
  toKey: string,
): Promise<{ employees: number; owners: number }> {
  const reports = await buildAgencyReports(agencyId, fromKey, toKey);
  const periodLabel = formatPeriod(fromKey, toKey);

  let employees = 0;
  for (const rep of reports) {
    const r = await sendEmployeeReport({ periodLabel, report: rep });
    if (r.ok) employees++;
  }

  const owners = (await activeStaff(agencyId)).filter((u) => u.role === 'owner');
  let ownerCount = 0;
  for (const o of owners) {
    const r = await sendTeamReport({
      to: o.email,
      name: o.fullName ?? o.email,
      periodLabel,
      members: reports,
    });
    if (r.ok) ownerCount++;
  }

  return { employees, owners: ownerCount };
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
