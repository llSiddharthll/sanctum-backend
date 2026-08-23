import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, gte, inArray, isNotNull, isNull, ne, or, sql, sum } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  projects,
  projectTasks,
  taskAssignees,
  timeLogs,
} from '../db/schema.js';
import { ok, toIso } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModule } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';

// Current-user ("/me") aggregates that span every project in the agency, as a
// counterpart to the per-project routes under '/projects/:id'. Read-only.
export const meRouter = Router();
meRouter.use(requireAuth);
meRouter.use(requireModule('projects', 'view'));

const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
] as const;

// GET /me/tasks?status=&includeDone=
// The caller's assigned tasks across ALL projects in their agency. Done tasks
// are excluded unless an explicit ?status=done or ?includeDone=true is given.
const listTasksQuery = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  includeDone: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // "true" → the caller's month-wise archive (incomplete past-month tasks).
  archived: z.enum(['true', 'false']).optional(),
});

const myTaskSelection = {
  id: projectTasks.id,
  title: projectTasks.title,
  status: projectTasks.status,
  priority: projectTasks.priority,
  dueDate: projectTasks.dueDate,
  projectId: projectTasks.projectId,
  projectName: projects.name,
  clientName: clients.name,
  archivedMonth: projectTasks.archivedMonth,
};

type MyTaskRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: Date | null;
  projectId: string;
  projectName: string;
  clientName: string | null;
  archivedMonth: string | null;
};

meRouter.get('/tasks', async (req, res) => {
  const ctx = getAuth(req);
  const q = listTasksQuery.parse(req.query);

  // Task ids the caller is on via the M:N join (the primary `assigneeId`
  // mirror is checked separately below so either form matches).
  const assignedTaskIds = db
    .select({ taskId: taskAssignees.taskId })
    .from(taskAssignees)
    .where(
      and(
        eq(taskAssignees.agencyId, ctx.agencyId),
        eq(taskAssignees.userId, ctx.userId),
      ),
    );

  const filters = [
    eq(projectTasks.agencyId, ctx.agencyId),
    // Active list excludes archived; ?archived=true returns ONLY the caller's
    // month-wise archive.
    q.archived === 'true'
      ? isNotNull(projectTasks.archivedAt)
      : isNull(projectTasks.archivedAt),
    or(
      eq(projectTasks.assigneeId, ctx.userId),
      inArray(projectTasks.id, assignedTaskIds),
    )!,
  ];

  if (q.status) {
    filters.push(eq(projectTasks.status, q.status));
  } else if (!q.includeDone && q.archived !== 'true') {
    filters.push(ne(projectTasks.status, 'done'));
  }

  // Order: nearest due date first (nulls last), then by priority rank. The enum
  // is stored as text so priority needs an explicit rank.
  const priorityRank = sql`case ${projectTasks.priority}
    when 'urgent' then 0 when 'high' then 1 when 'medium' then 2
    when 'low' then 3 else 4 end`;

  const rows = await db
    .select(myTaskSelection)
    .from(projectTasks)
    .innerJoin(projects, eq(projects.id, projectTasks.projectId))
    .leftJoin(clients, eq(clients.id, projects.clientId))
    .where(and(...filters))
    .orderBy(sql`${projectTasks.dueDate} is null`, asc(projectTasks.dueDate), priorityRank);

  ok(
    res,
    (rows as MyTaskRow[]).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      dueDate: toIso(r.dueDate),
      projectId: r.projectId,
      projectName: r.projectName,
      clientName: r.clientName,
      archivedMonth: r.archivedMonth,
    })),
  );
});

// GET /me/overview — headline numbers for the "My day" (employee) dashboard:
// my open/overdue/due-today task counts + minutes logged today + this week.
meRouter.get('/overview', async (req, res) => {
  const ctx = getAuth(req);
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfToday.getDate() + 1);
  const mondayOffset = (startOfToday.getDay() + 6) % 7; // Mon=0
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - mondayOffset);

  const assignedTaskIds = db
    .select({ taskId: taskAssignees.taskId })
    .from(taskAssignees)
    .where(
      and(
        eq(taskAssignees.agencyId, ctx.agencyId),
        eq(taskAssignees.userId, ctx.userId),
      ),
    );
  const mine = or(
    eq(projectTasks.assigneeId, ctx.userId),
    inArray(projectTasks.id, assignedTaskIds),
  )!;

  const openRows = await db
    .select({ id: projectTasks.id, dueDate: projectTasks.dueDate })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        mine,
        isNull(projectTasks.archivedAt),
        ne(projectTasks.status, 'done'),
      ),
    );
  let overdueTasks = 0;
  let dueTodayTasks = 0;
  for (const r of openRows) {
    if (!r.dueDate) continue;
    const d = r.dueDate.getTime();
    if (d < startOfToday.getTime()) overdueTasks++;
    else if (d < startOfTomorrow.getTime()) dueTodayTasks++;
  }

  const [wk] = await db
    .select({ v: sum(timeLogs.minutes) })
    .from(timeLogs)
    .where(
      and(
        eq(timeLogs.agencyId, ctx.agencyId),
        eq(timeLogs.userId, ctx.userId),
        gte(timeLogs.workDate, startOfWeek),
      ),
    );
  const [td] = await db
    .select({ v: sum(timeLogs.minutes) })
    .from(timeLogs)
    .where(
      and(
        eq(timeLogs.agencyId, ctx.agencyId),
        eq(timeLogs.userId, ctx.userId),
        gte(timeLogs.workDate, startOfToday),
      ),
    );

  ok(res, {
    openTasks: openRows.length,
    overdueTasks,
    dueTodayTasks,
    todayMinutes: Number(td?.v ?? 0),
    weekMinutes: Number(wk?.v ?? 0),
  });
});
