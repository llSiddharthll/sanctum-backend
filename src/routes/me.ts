import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, projects, projectTasks, taskAssignees } from '../db/schema.js';
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
    or(
      eq(projectTasks.assigneeId, ctx.userId),
      inArray(projectTasks.id, assignedTaskIds),
    )!,
  ];

  if (q.status) {
    filters.push(eq(projectTasks.status, q.status));
  } else if (!q.includeDone) {
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
    })),
  );
});
