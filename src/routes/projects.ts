import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  auditLog,
  clients,
  projects,
  projectTasks,
  projectMilestones,
  projectMembers,
  projectTaskLabels,
  projectTaskLabelLinks,
  projectTaskDependencies,
  projectTaskComments,
  taskAssignees,
  timeLogs,
  timers,
  users,
  contentPosts,
} from '../db/schema.js';
import { broadcastPortalRefresh } from '../realtime/io.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { AppError, notFound, conflict, forbidden } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import {
  MILESTONE_TEMPLATES,
  CONTINUOUS_SERVICES,
} from '../lib/project-milestone-templates.js';
import { sweepEndedMonths, unarchiveTask } from '../services/archive.js';
import { listProjectTimers, stopTimersForTask } from './timers.js';
import { authenticate, getActor, requires } from '../authz/http.js';
import {
  authorize,
  can,
  canOrg,
  capabilities,
  check,
  type ObjectFacts,
} from '../authz/engine.js';
import {
  actorAuditId,
  actorUserId,
  systemActor,
  type Actor,
} from '../authz/actor.js';
import { requireActiveStaff, requireInAgency } from '../authz/tenancy.js';
import { clientFacts } from '../authz/policies/clients.js';
import {
  assignedTaskIdSet,
  commentFacts,
  memberProjectIds,
  projectFacts,
  projectFactsFromRow,
  projectScopeFilter,
  requireLabelsInProject,
  requireMilestoneInProject,
  requireTaskInProject,
  taskFacts,
  taskFactsFromRow,
  taskScopeFilter,
  timeLogScopeFilter,
  timerScopeFilter,
  visibleTaskIdsSq,
  type ProjectFacts,
  type TaskFacts,
} from '../authz/policies/projects.js';

// mergeParams keeps any parent params available (none today, but consistent
// with the other nested routers).
//
// Authorization (src/authz/README.md): every route declares its permission
// with `requires(...)`; object routes authorize the project / task / comment /
// time log through the facts loaders in authz/policies/projects.ts; lists are
// filtered in SQL by scope.
export const projectsRouter = Router({ mergeParams: true });
projectsRouter.use(authenticate);

const PROJECT_TYPES = [
  'fixed_price',
  'retainer',
  'hourly',
  'milestone_based',
] as const;
const PROJECT_STATUSES = [
  'planning',
  'active',
  'on_hold',
  'completed',
  'cancelled',
] as const;
const PROJECT_HEALTH = ['on_track', 'at_risk', 'off_track'] as const;
const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
] as const;
const MILESTONE_STATUSES = ['pending', 'completed'] as const;
const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
const LABEL_COLORS = [
  'pine',
  'brass',
  'sky',
  'rose',
  'amber',
  'violet',
  'slate',
] as const;
/** Project member roles (design §G.2: an enum, not free text). */
const PROJECT_MEMBER_ROLES = ['lead', 'member'] as const;

/** Capabilities returned on project objects. */
const PROJECT_CAPS = [
  'projects.update',
  'projects.delete',
  'projects.manage_members',
  'project_milestones.manage',
  'projects.view_financials',
];
/** Capabilities returned on task objects. */
const TASK_CAPS = [
  'tasks.update',
  'tasks.delete',
  'tasks.assign',
  'task_comments.create',
];

// ---- Actor helpers ----------------------------------------------------------

/** The staff user id behind a write (tasks/comments/members are per user). */
function staffUserId(actor: Actor): string {
  const uid = actorUserId(actor);
  if (!uid || actor.type !== 'staff') {
    throw forbidden("You don't have permission to do that.");
  }
  return uid;
}

/** Business audit event attributed to the actor (actorType = actor.type). */
function auditAs(
  actor: Actor,
  req: Request | null,
  e: {
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  return audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    metadata: e.metadata,
    ip: req?.ip,
  });
}

/**
 * Load a project's facts and authorize `permission` on it. Throws 404 when the
 * project is not in the tenant or the actor cannot view it, 403 otherwise.
 */
async function authorizeProject(
  actor: Actor,
  projectId: string,
  permission: string,
  message?: string,
): Promise<ProjectFacts> {
  const facts = await projectFacts(actor, projectId);
  authorize(
    actor,
    permission,
    facts,
    permission === 'projects.view' ? {} : { view: 'projects.view', message },
  );
  return facts!;
}

/**
 * Load a task bound to the URL project and authorize `permission` on it
 * (404 when not in the project/tenant or not visible via tasks.view).
 */
async function authorizeTask(
  actor: Actor,
  projectId: string,
  taskId: string,
  permission: string,
  message?: string,
): Promise<TaskFacts> {
  const facts = await taskFacts(actor, taskId, { projectId });
  authorize(
    actor,
    permission,
    facts,
    permission === 'tasks.view' ? {} : { view: 'tasks.view', message },
  );
  return facts!;
}

// ---- Correlated count subqueries (tenant-implied via project FK) ----
const tasksTotalSq = sql<number>`(
  select count(*) from ${projectTasks}
  where ${projectTasks.projectId} = ${projects.id}
    and ${projectTasks.archivedAt} is null
)`;
const tasksDoneSq = sql<number>`(
  select count(*) from ${projectTasks}
  where ${projectTasks.projectId} = ${projects.id}
    and ${projectTasks.status} = 'done'
    and ${projectTasks.archivedAt} is null
)`;
const milestonesTotalSq = sql<number>`(
  select count(*) from ${projectMilestones}
  where ${projectMilestones.projectId} = ${projects.id}
)`;
const milestonesDoneSq = sql<number>`(
  select count(*) from ${projectMilestones}
  where ${projectMilestones.projectId} = ${projects.id}
    and ${projectMilestones.status} = 'completed'
)`;
const memberCountSq = sql<number>`(
  select count(*) from ${projectMembers}
  where ${projectMembers.projectId} = ${projects.id}
)`;

const projectSelection = {
  id: projects.id,
  clientId: projects.clientId,
  name: projects.name,
  scopeOfWork: projects.scopeOfWork,
  description: projects.description,
  services: projects.services,
  type: projects.type,
  status: projects.status,
  health: projects.health,
  contractValue: projects.contractValue,
  billingType: projects.billingType,
  recurringPaise: projects.recurringPaise,
  currency: projects.currency,
  startDate: projects.startDate,
  deadline: projects.deadline,
  createdBy: projects.createdBy,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
  clientName: clients.name,
  tasksTotal: tasksTotalSq,
  tasksDone: tasksDoneSq,
  milestonesTotal: milestonesTotalSq,
  milestonesDone: milestonesDoneSq,
  memberCount: memberCountSq,
};

type ProjectRow = {
  id: string;
  clientId: string;
  name: string;
  scopeOfWork: string | null;
  description: string | null;
  services: string;
  type: string;
  status: string;
  health: string;
  contractValue: number | null;
  billingType: 'one_time' | 'retainer';
  recurringPaise: number;
  currency: string;
  startDate: Date | null;
  deadline: Date | null;
  createdBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  clientName: string | null;
  tasksTotal: number;
  tasksDone: number;
  milestonesTotal: number;
  milestonesDone: number;
  memberCount: number;
};

/** Parse a stored JSON string array (services), tolerating bad data. */
function safeStringArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Serialize a project for `actor`. Money (contract value, billing type,
 * recurring amount) is included only with projects.view_financials on THIS
 * project; otherwise those fields are null.
 */
function serializeProject(p: ProjectRow, actor: Actor, facts: ObjectFacts) {
  const showFinance = check(actor, 'projects.view_financials', facts);
  return {
    id: p.id,
    clientId: p.clientId,
    clientName: p.clientName,
    name: p.name,
    scopeOfWork: p.scopeOfWork,
    description: p.description,
    services: safeStringArray(p.services),
    type: p.type,
    status: p.status,
    health: p.health,
    contractValue: showFinance ? (p.contractValue ?? 0) : null,
    billingType: showFinance ? p.billingType : null,
    recurringPaise: showFinance ? (p.recurringPaise ?? 0) : null,
    currency: p.currency,
    startDate: toIso(p.startDate),
    deadline: toIso(p.deadline),
    tasksTotal: Number(p.tasksTotal ?? 0),
    tasksDone: Number(p.tasksDone ?? 0),
    milestonesTotal: Number(p.milestonesTotal ?? 0),
    milestonesDone: Number(p.milestonesDone ?? 0),
    memberCount: Number(p.memberCount ?? 0),
    createdBy: p.createdBy,
    createdAt: toIso(p.createdAt),
    updatedAt: toIso(p.updatedAt),
    capabilities: capabilities(actor, facts, PROJECT_CAPS),
  };
}

/** Load the project row (with counts) for serialization; 404 when missing. */
async function loadProjectRow(actor: Actor, projectId: string): Promise<ProjectRow> {
  const [row] = await db
    .select(projectSelection)
    .from(projects)
    .leftJoin(clients, eq(clients.id, projects.clientId))
    .where(and(eq(projects.id, projectId), eq(projects.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) throw notFound('Project not found.');
  return row as ProjectRow;
}

function serializeTask(tk: typeof projectTasks.$inferSelect) {
  return {
    id: tk.id,
    projectId: tk.projectId,
    milestoneId: tk.milestoneId,
    title: tk.title,
    description: tk.description,
    status: tk.status,
    assigneeId: tk.assigneeId,
    priority: tk.priority,
    estimateMinutes: tk.estimateMinutes,
    startDate: toIso(tk.startDate),
    dueDate: toIso(tk.dueDate),
    completedAt: toIso(tk.completedAt),
    parentTaskId: tk.parentTaskId,
    position: tk.position,
    archivedAt: toIso(tk.archivedAt),
    archivedMonth: tk.archivedMonth,
    createdBy: tk.createdBy,
    createdAt: toIso(tk.createdAt),
    updatedAt: toIso(tk.updatedAt),
  };
}

/** A label as returned to the client. */
function serializeLabel(l: typeof projectTaskLabels.$inferSelect) {
  return {
    id: l.id,
    projectId: l.projectId,
    name: l.name,
    color: l.color,
    createdAt: toIso(l.createdAt),
  };
}

type SerializedLabel = ReturnType<typeof serializeLabel>;
type SerializedTask = ReturnType<typeof serializeTask>;

/** A single assignee as returned to the client. */
type Assignee = { userId: string; name: string };

/** A task enriched with computed list-view fields. */
type EnrichedTask = SerializedTask & {
  assignees: Assignee[];
  labels: SerializedLabel[];
  subtaskCount: number;
  subtaskDoneCount: number;
  blockedByCount: number;
  commentCount: number;
};

/**
 * Fold per-task `capabilities` onto serialized task rows for `actor` (one
 * membership query + one assignment query for the whole batch).
 */
async function withTaskCapabilities<
  T extends Pick<SerializedTask, 'id' | 'projectId' | 'createdBy' | 'assigneeId'>,
>(actor: Actor, tasks: T[]): Promise<(T & { capabilities: Record<string, boolean> })[]> {
  if (!tasks.length) return [];
  const [members, assigned] = await Promise.all([
    memberProjectIds(actor),
    assignedTaskIdSet(actor, tasks.map((t) => t.id)),
  ]);
  return tasks.map((t) => ({
    ...t,
    capabilities: capabilities(actor, taskFactsFromRow(actor, t, assigned, members), TASK_CAPS),
  }));
}

/**
 * Bulk-load the assignees for a set of tasks and fold them onto each row as an
 * `assignees: { userId, name }[]` array (empty when none). One query joining
 * task_assignees -> users keeps this O(1) regardless of task count.
 */
async function attachAssignees<T extends { id: string }>(
  agencyId: string,
  tasks: T[],
): Promise<(T & { assignees: Assignee[] })[]> {
  const ids = tasks.map((t) => t.id);
  if (ids.length === 0) {
    return tasks.map((t) => ({ ...t, assignees: [] as Assignee[] }));
  }

  const rows = await db
    .select({
      taskId: taskAssignees.taskId,
      userId: taskAssignees.userId,
      name: users.fullName,
    })
    .from(taskAssignees)
    .innerJoin(users, eq(users.id, taskAssignees.userId))
    .where(
      and(
        eq(taskAssignees.agencyId, agencyId),
        inArray(taskAssignees.taskId, ids),
      ),
    )
    .orderBy(asc(taskAssignees.createdAt));

  const byTask = new Map<string, Assignee[]>();
  for (const r of rows) {
    const list = byTask.get(r.taskId) ?? [];
    list.push({ userId: r.userId, name: r.name ?? 'Member' });
    byTask.set(r.taskId, list);
  }

  return tasks.map((t) => ({ ...t, assignees: byTask.get(t.id) ?? [] }));
}

/**
 * Replace the assignee set for a task with `userIds` (deduped) inside the
 * caller's agency: clears existing rows then inserts the new ones. Used by the
 * create + update handlers to keep the join table in sync with the primary
 * `assigneeId` mirror. Callers authorize (tasks.assign) and validate the ids
 * (requireActiveStaff) first.
 */
async function syncTaskAssignees(
  agencyId: string,
  taskId: string,
  userIds: string[],
): Promise<void> {
  await db
    .delete(taskAssignees)
    .where(
      and(
        eq(taskAssignees.agencyId, agencyId),
        eq(taskAssignees.taskId, taskId),
      ),
    );
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await db.insert(taskAssignees).values(
    unique.map((userId) => ({
      id: newId('tas'),
      agencyId,
      taskId,
      userId,
    })),
  );
}

/** Current assignee user ids of a task (join rows ∪ primary mirror). */
async function currentAssigneeIds(
  agencyId: string,
  task: { id: string; assigneeId: string | null },
): Promise<string[]> {
  const rows = await db
    .select({ userId: taskAssignees.userId })
    .from(taskAssignees)
    .where(and(eq(taskAssignees.agencyId, agencyId), eq(taskAssignees.taskId, task.id)));
  const set = new Set(rows.map((r) => r.userId));
  if (task.assigneeId) set.add(task.assigneeId);
  return [...set];
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/**
 * Assignment rule (design §G.2): setting assignees to anything other than
 * exactly [actor] requires tasks.assign on the task/project; every assignee
 * must be an active staff member of the agency (never a client user).
 */
async function authorizeAssignees(
  actor: Actor,
  facts: ObjectFacts,
  nextIds: string[],
): Promise<void> {
  const uid = actorUserId(actor);
  const selfOnly = nextIds.length === 1 && nextIds[0] === uid;
  if (!selfOnly) {
    authorize(actor, 'tasks.assign', facts, {
      message: "You don't have permission to assign tasks to other people.",
    });
  }
  await requireActiveStaff(actor.agencyId, nextIds);
}

/**
 * Bulk-load enrichment (labels, subtask counts, blocked-by, comments) for a
 * set of tasks and fold it onto the serialized rows. One query per facet keeps
 * this O(facets) rather than O(rows).
 */
async function enrichTasks(
  agencyId: string,
  rows: (typeof projectTasks.$inferSelect)[],
): Promise<EnrichedTask[]> {
  const ids = rows.map((r) => r.id);
  const base = rows.map(serializeTask);
  if (ids.length === 0) {
    return base.map((t) => ({
      ...t,
      assignees: [] as Assignee[],
      labels: [],
      subtaskCount: 0,
      subtaskDoneCount: 0,
      blockedByCount: 0,
      commentCount: 0,
    }));
  }

  // Labels (joined through the link table), grouped by task.
  const labelRows = await db
    .select({
      taskId: projectTaskLabelLinks.taskId,
      id: projectTaskLabels.id,
      projectId: projectTaskLabels.projectId,
      name: projectTaskLabels.name,
      color: projectTaskLabels.color,
      createdAt: projectTaskLabels.createdAt,
    })
    .from(projectTaskLabelLinks)
    .innerJoin(
      projectTaskLabels,
      eq(projectTaskLabels.id, projectTaskLabelLinks.labelId),
    )
    .where(
      and(
        eq(projectTaskLabelLinks.agencyId, agencyId),
        inArray(projectTaskLabelLinks.taskId, ids),
      ),
    )
    .orderBy(asc(projectTaskLabels.name));

  const labelsByTask = new Map<string, SerializedLabel[]>();
  for (const lr of labelRows) {
    const list = labelsByTask.get(lr.taskId) ?? [];
    list.push({
      id: lr.id,
      projectId: lr.projectId,
      name: lr.name,
      color: lr.color,
      createdAt: toIso(lr.createdAt),
    });
    labelsByTask.set(lr.taskId, list);
  }

  // Subtask totals + done counts, grouped by parent.
  const subtaskRows = await db
    .select({
      parentTaskId: projectTasks.parentTaskId,
      total: sql<number>`count(*)`,
      done: sql<number>`sum(case when ${projectTasks.status} = 'done' then 1 else 0 end)`,
    })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, agencyId),
        inArray(projectTasks.parentTaskId, ids),
      ),
    )
    .groupBy(projectTasks.parentTaskId);

  const subtaskByParent = new Map<
    string,
    { total: number; done: number }
  >();
  for (const sr of subtaskRows) {
    if (sr.parentTaskId)
      subtaskByParent.set(sr.parentTaskId, {
        total: Number(sr.total ?? 0),
        done: Number(sr.done ?? 0),
      });
  }

  // Blocked-by counts (this task is the blocked side of an edge).
  const blockedRows = await db
    .select({
      blockedTaskId: projectTaskDependencies.blockedTaskId,
      total: sql<number>`count(*)`,
    })
    .from(projectTaskDependencies)
    .where(
      and(
        eq(projectTaskDependencies.agencyId, agencyId),
        inArray(projectTaskDependencies.blockedTaskId, ids),
      ),
    )
    .groupBy(projectTaskDependencies.blockedTaskId);

  const blockedByTask = new Map<string, number>();
  for (const br of blockedRows) {
    blockedByTask.set(br.blockedTaskId, Number(br.total ?? 0));
  }

  // Comment counts (non-deleted only).
  const commentRows = await db
    .select({
      taskId: projectTaskComments.taskId,
      total: sql<number>`count(*)`,
    })
    .from(projectTaskComments)
    .where(
      and(
        eq(projectTaskComments.agencyId, agencyId),
        inArray(projectTaskComments.taskId, ids),
        isNull(projectTaskComments.deletedAt),
      ),
    )
    .groupBy(projectTaskComments.taskId);

  const commentsByTask = new Map<string, number>();
  for (const cr of commentRows) {
    commentsByTask.set(cr.taskId, Number(cr.total ?? 0));
  }

  // Assignees (joined through the M:N table), grouped by task.
  const withAssignees = await attachAssignees(agencyId, base);
  const assigneesByTask = new Map<string, Assignee[]>(
    withAssignees.map((t) => [t.id, t.assignees]),
  );

  return base.map((t) => {
    const sub = subtaskByParent.get(t.id);
    return {
      ...t,
      assignees: assigneesByTask.get(t.id) ?? [],
      labels: labelsByTask.get(t.id) ?? [],
      subtaskCount: sub?.total ?? 0,
      subtaskDoneCount: sub?.done ?? 0,
      blockedByCount: blockedByTask.get(t.id) ?? 0,
      commentCount: commentsByTask.get(t.id) ?? 0,
    };
  });
}

function serializeMilestone(m: typeof projectMilestones.$inferSelect) {
  return {
    id: m.id,
    projectId: m.projectId,
    title: m.title,
    description: m.description,
    dueDate: toIso(m.dueDate),
    status: m.status,
    completedAt: toIso(m.completedAt),
    position: m.position,
    createdAt: toIso(m.createdAt),
    updatedAt: toIso(m.updatedAt),
  };
}

// ============================================================
//  PROJECTS
// ============================================================

// GET /projects?status=&health=&clientId=&search=   — projects.view (SQL scope)
const listQuery = z.object({
  status: z.enum(PROJECT_STATUSES).optional(),
  health: z.enum(PROJECT_HEALTH).optional(),
  clientId: z.string().optional(),
  search: z.string().optional(),
});

projectsRouter.get('/', requires('projects.view'), async (req, res) => {
  const actor = getActor(req);
  const q = listQuery.parse(req.query);

  const filters: SQL[] = [
    eq(projects.agencyId, actor.agencyId),
    projectScopeFilter(actor, 'projects.view'),
  ];
  if (q.status) filters.push(eq(projects.status, q.status));
  if (q.health) filters.push(eq(projects.health, q.health));
  if (q.clientId) filters.push(eq(projects.clientId, q.clientId));
  if (q.search && q.search.trim()) {
    filters.push(like(projects.name, `%${q.search.trim()}%`));
  }

  const rows = await db
    .select(projectSelection)
    .from(projects)
    .leftJoin(clients, eq(clients.id, projects.clientId))
    .where(and(...filters))
    .orderBy(asc(projects.createdAt));

  const members = await memberProjectIds(actor);
  ok(
    res,
    (rows as ProjectRow[]).map((p) =>
      serializeProject(p, actor, projectFactsFromRow(actor, p, members)),
    ),
  );
});

// GET /projects/all-tasks — cross-project task board — tasks.view (SQL scope)
const allTasksQuery = z.object({
  projectId: z.string().optional(),
  clientId: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assigneeId: z.string().optional(),
  search: z.string().optional(),
  archived: z.string().optional(),
  month: z.string().optional(),
});

projectsRouter.get('/all-tasks', requires('tasks.view'), async (req, res) => {
  const actor = getActor(req);
  const q = allTasksQuery.parse(req.query);
  const archived = q.archived === 'true';

  const filters: SQL[] = [
    eq(projectTasks.agencyId, actor.agencyId),
    taskScopeFilter(actor, 'tasks.view'),
  ];
  if (q.projectId) filters.push(eq(projectTasks.projectId, q.projectId));
  if (q.status) filters.push(eq(projectTasks.status, q.status));
  if (q.priority) filters.push(eq(projectTasks.priority, q.priority));
  if (q.assigneeId) filters.push(eq(projectTasks.assigneeId, q.assigneeId));
  if (q.clientId) filters.push(eq(projects.clientId, q.clientId));
  if (q.search && q.search.trim()) {
    filters.push(like(projectTasks.title, `%${q.search.trim()}%`));
  }
  // Active board excludes archived tasks; ?archived=true returns ONLY the
  // month-wise archive (optionally a single ?month=YYYY-MM).
  if (archived) {
    filters.push(isNotNull(projectTasks.archivedAt));
    if (q.month) filters.push(eq(projectTasks.archivedMonth, q.month));
  } else {
    filters.push(isNull(projectTasks.archivedAt));
  }

  const rows = await db
    .select({
      t: projectTasks,
      projectName: projects.name,
      clientName: clients.name,
      assigneeName: users.fullName,
    })
    .from(projectTasks)
    .innerJoin(projects, eq(projects.id, projectTasks.projectId))
    .leftJoin(clients, eq(clients.id, projects.clientId))
    .leftJoin(users, eq(users.id, projectTasks.assigneeId))
    .where(and(...filters))
    .orderBy(desc(projectTasks.createdAt))
    .limit(500);

  ok(
    res,
    await withTaskCapabilities(
      actor,
      rows.map((r) => ({
        ...serializeTask(r.t),
        projectName: r.projectName,
        clientName: r.clientName,
        assigneeName: r.assigneeName,
      })),
    ),
  );
});

// POST /projects/tasks/archive-run — sweep this agency's ended months now.
// tasks.archive sweeps tasks; posts are swept only when the caller also holds
// posts.archive (cross-module operation).
projectsRouter.post('/tasks/archive-run', requires('tasks.archive'), async (req, res) => {
  const actor = getActor(req);
  const sweepPosts = canOrg(actor, 'posts.archive');
  const r = await sweepEndedMonths(new Date(), actor.agencyId, {
    tasks: true,
    posts: sweepPosts,
  });
  await auditAs(actor, req, {
    action: 'archive.run',
    entityType: 'agency',
    entityId: actor.agencyId,
    metadata: { tasks: r.tasks, posts: r.posts, postsSwept: sweepPosts },
  });
  ok(res, r);
});

// POST /projects/tasks/:taskId/unarchive — restore an ARCHIVED task.
// tasks.restore on the task (project or organization scope).
projectsRouter.post('/tasks/:taskId/unarchive', requires('tasks.restore'), async (req, res) => {
  const actor = getActor(req);
  const facts = await taskFacts(actor, param(req, 'taskId'));
  authorize(actor, 'tasks.restore', facts, { view: 'tasks.view' });
  if (!facts!.task.archivedAt) throw notFound('Archived task not found.');
  const done = await unarchiveTask(actor.agencyId, facts!.task.id);
  if (!done) throw notFound('Archived task not found.');
  await auditAs(actor, req, {
    action: 'task.unarchive',
    entityType: 'task',
    entityId: facts!.task.id,
    metadata: {
      projectId: facts!.task.projectId,
      taskTitle: facts!.task.title,
      archivedMonth: facts!.task.archivedMonth,
    },
  });
  ok(res, { restored: true });
});

// POST /projects
const createSchema = z.object({
  name: z.string().min(1).max(160),
  clientId: z.string().min(1),
  // The web form sends null for an empty scope / cleared dates — accept it
  // (and keep null dates from being coerced to the 1970 epoch).
  scopeOfWork: z.string().max(5000).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  services: z.array(z.string().max(60)).max(30).optional(),
  type: z.enum(PROJECT_TYPES).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  health: z.enum(PROJECT_HEALTH).optional(),
  contractValue: z.number().int().min(0).optional(),
  billingType: z.enum(['one_time', 'retainer']).optional(),
  recurringPaise: z.number().int().min(0).optional(),
  currency: z.string().trim().max(8).optional(),
  startDate: z.coerce.date().nullable().optional(),
  deadline: z.coerce.date().nullable().optional(),
  /**
   * Milestones to create alongside the project. The UI prefills these from the
   * service preset and lets the team edit them first, so we take exactly what
   * was shown rather than re-deriving on the server. Omit for none.
   */
  milestones: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(1000).optional(),
        dueDate: z.coerce.date().optional(),
      }),
    )
    .max(30)
    .optional(),
});

/**
 * GET /projects/milestone-templates — the service→milestones presets, so the
 * create form can prefill (and explain an intentionally empty preset).
 * Registered before '/:id' so it is not read as a project id. Static config;
 * projects.view.
 */
projectsRouter.get('/milestone-templates', requires('projects.view'), async (_req, res) => {
  ok(res, {
    continuousServices: CONTINUOUS_SERVICES,
    templates: MILESTONE_TEMPLATES,
  });
});

/** True when a create/update body carries any project money field. */
function touchesFinancials(body: {
  contractValue?: unknown;
  billingType?: unknown;
  recurringPaise?: unknown;
}): boolean {
  return (
    body.contractValue !== undefined ||
    body.billingType !== undefined ||
    body.recurringPaise !== undefined
  );
}

const FINANCIALS_FORBIDDEN = "You don't have permission to set project financials.";

// POST /projects — projects.create; money fields need projects.update_financials;
// seeded milestones need project_milestones.manage.
projectsRouter.post('/', requires('projects.create'), async (req, res) => {
  const actor = getActor(req);
  const uid = staffUserId(actor);
  const body = createSchema.parse(req.body);
  await requireInAgency(clients, actor.agencyId, body.clientId, 'Client');

  // The creator becomes a project lead, so an `assigned` financial grant covers
  // the new project: any scope suffices.
  if (touchesFinancials(body) && !can(actor, 'projects.update_financials')) {
    throw forbidden(FINANCIALS_FORBIDDEN);
  }
  if (body.milestones?.length && !can(actor, 'project_milestones.manage')) {
    throw forbidden("You don't have permission to create milestones.");
  }

  const id = newId('prj');
  await db.insert(projects).values({
    id,
    agencyId: actor.agencyId,
    clientId: body.clientId,
    name: body.name,
    scopeOfWork: body.scopeOfWork ?? null,
    description: body.description ?? null,
    ...(body.services !== undefined
      ? { services: JSON.stringify(body.services) }
      : {}),
    ...(body.type !== undefined ? { type: body.type } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.health !== undefined ? { health: body.health } : {}),
    ...(body.contractValue !== undefined
      ? { contractValue: body.contractValue }
      : {}),
    ...(body.billingType !== undefined ? { billingType: body.billingType } : {}),
    ...(body.recurringPaise !== undefined
      ? { recurringPaise: body.recurringPaise }
      : {}),
    ...(body.currency !== undefined ? { currency: body.currency } : {}),
    startDate: body.startDate ?? null,
    deadline: body.deadline ?? null,
    createdBy: uid,
  });

  // The creator is automatically a 'lead' member of the project.
  await db.insert(projectMembers).values({
    id: newId('prm'),
    agencyId: actor.agencyId,
    projectId: id,
    userId: uid,
    role: 'lead',
  });

  // Seed the milestones the UI showed at creation time (service preset, edited).
  if (body.milestones?.length) {
    await db.insert(projectMilestones).values(
      body.milestones.map((m, i) => ({
        id: newId('pms'),
        agencyId: actor.agencyId,
        projectId: id,
        title: m.title,
        description: m.description ?? null,
        dueDate: m.dueDate ?? null,
        position: i,
      })),
    );
  }

  await auditAs(actor, req, {
    action: 'project.create',
    entityType: 'project',
    entityId: id,
    metadata: {
      projectId: id,
      name: body.name,
      milestonesSeeded: body.milestones?.length ?? 0,
    },
  });

  const facts = await authorizeProject(actor, id, 'projects.view');
  created(res, serializeProject(await loadProjectRow(actor, id), actor, facts));
});

// GET /projects/:id — projects.view on the project
projectsRouter.get('/:id', requires('projects.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const facts = await authorizeProject(actor, projectId, 'projects.view');
  ok(res, serializeProject(await loadProjectRow(actor, projectId), actor, facts));
});

// PATCH /projects/:id — projects.update; money fields need projects.update_financials
const updateSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  clientId: z.string().min(1).optional(),
  scopeOfWork: z.string().max(5000).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  services: z.array(z.string().max(60)).max(30).optional(),
  type: z.enum(PROJECT_TYPES).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  health: z.enum(PROJECT_HEALTH).optional(),
  contractValue: z.number().int().min(0).optional(),
  billingType: z.enum(['one_time', 'retainer']).optional(),
  recurringPaise: z.number().int().min(0).optional(),
  currency: z.string().trim().max(8).optional(),
  startDate: z.coerce.date().nullable().optional(),
  deadline: z.coerce.date().nullable().optional(),
});

projectsRouter.patch('/:id', requires('projects.update'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const facts = await authorizeProject(actor, projectId, 'projects.update');
  const body = updateSchema.parse(req.body);

  if (touchesFinancials(body)) {
    authorize(actor, 'projects.update_financials', facts, { message: FINANCIALS_FORBIDDEN });
  }
  if (body.clientId !== undefined) {
    await requireInAgency(clients, actor.agencyId, body.clientId, 'Client');
  }

  const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.scopeOfWork !== undefined) patch.scopeOfWork = body.scopeOfWork;
  if (body.description !== undefined) patch.description = body.description;
  if (body.services !== undefined) patch.services = JSON.stringify(body.services);
  if (body.type !== undefined) patch.type = body.type;
  if (body.status !== undefined) patch.status = body.status;
  if (body.health !== undefined) patch.health = body.health;
  if (body.contractValue !== undefined)
    patch.contractValue = body.contractValue;
  if (body.billingType !== undefined) patch.billingType = body.billingType;
  if (body.recurringPaise !== undefined)
    patch.recurringPaise = body.recurringPaise;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.startDate !== undefined) patch.startDate = body.startDate;
  if (body.deadline !== undefined) patch.deadline = body.deadline;

  await db
    .update(projects)
    .set(patch)
    .where(
      and(eq(projects.id, projectId), eq(projects.agencyId, actor.agencyId)),
    );

  await auditAs(actor, req, {
    action: 'project.update',
    entityType: 'project',
    entityId: projectId,
    metadata: {
      projectId,
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.clientId !== undefined && body.clientId !== facts.clientId
        ? { fromClientId: facts.clientId, toClientId: body.clientId }
        : {}),
      ...(touchesFinancials(body) ? { financialsChanged: true } : {}),
    },
  });

  const after = await authorizeProject(actor, projectId, 'projects.view');
  ok(res, serializeProject(await loadProjectRow(actor, projectId), actor, after));
});

// DELETE /projects/:id (children cascade) — projects.delete
projectsRouter.delete('/:id', requires('projects.delete'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'projects.delete');

  await db
    .delete(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.agencyId, actor.agencyId)),
    );

  await auditAs(actor, req, {
    action: 'project.delete',
    entityType: 'project',
    entityId: projectId,
    metadata: { projectId },
  });
  ok(res, { deleted: true });
});

// ============================================================
//  LABELS (project-scoped task labels)  §3.1
// ============================================================

/** Fetch a label scoped to the project + agency, or throw 404. */
async function getScopedLabel(
  agencyId: string,
  projectId: string,
  labelId: string,
) {
  const [row] = await db
    .select()
    .from(projectTaskLabels)
    .where(
      and(
        eq(projectTaskLabels.id, labelId),
        eq(projectTaskLabels.agencyId, agencyId),
        eq(projectTaskLabels.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Label not found.');
  return row;
}

// GET /projects/:id/labels — projects.view on the project
projectsRouter.get('/:id/labels', requires('projects.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'projects.view');

  const rows = await db
    .select()
    .from(projectTaskLabels)
    .where(
      and(
        eq(projectTaskLabels.agencyId, actor.agencyId),
        eq(projectTaskLabels.projectId, projectId),
      ),
    )
    .orderBy(asc(projectTaskLabels.name));

  ok(res, rows.map(serializeLabel));
});

// POST /projects/:id/labels — project_labels.manage
const createLabelSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.enum(LABEL_COLORS).optional(),
});

async function labelNameTaken(agencyId: string, projectId: string, name: string): Promise<boolean> {
  const [dup] = await db
    .select({ id: projectTaskLabels.id })
    .from(projectTaskLabels)
    .where(
      and(
        eq(projectTaskLabels.agencyId, agencyId),
        eq(projectTaskLabels.projectId, projectId),
        eq(projectTaskLabels.name, name),
      ),
    )
    .limit(1);
  return !!dup;
}

projectsRouter.post('/:id/labels', requires('project_labels.manage'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'project_labels.manage');
  const body = createLabelSchema.parse(req.body);

  // Enforce per-project unique name (case-sensitive, matches the unique index).
  if (await labelNameTaken(actor.agencyId, projectId, body.name)) {
    throw conflict('A label with that name already exists.');
  }

  const id = newId('plb');
  await db.insert(projectTaskLabels).values({
    id,
    agencyId: actor.agencyId,
    projectId,
    name: body.name,
    ...(body.color !== undefined ? { color: body.color } : {}),
  });

  await auditAs(actor, req, {
    action: 'label.create',
    entityType: 'label',
    entityId: id,
    metadata: { projectId, name: body.name, color: body.color ?? 'pine' },
  });

  const [row] = await db
    .select()
    .from(projectTaskLabels)
    .where(and(eq(projectTaskLabels.id, id), eq(projectTaskLabels.agencyId, actor.agencyId)));
  created(res, serializeLabel(row!));
});

// PATCH /projects/:id/labels/:labelId — project_labels.manage
const updateLabelSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: z.enum(LABEL_COLORS).optional(),
});

projectsRouter.patch('/:id/labels/:labelId', requires('project_labels.manage'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'project_labels.manage');
  const label = await getScopedLabel(actor.agencyId, projectId, param(req, 'labelId'));
  const body = updateLabelSchema.parse(req.body);

  if (
    body.name !== undefined &&
    body.name !== label.name &&
    (await labelNameTaken(actor.agencyId, projectId, body.name))
  ) {
    throw conflict('A label with that name already exists.');
  }

  const patch: Partial<typeof projectTaskLabels.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.color !== undefined) patch.color = body.color;

  if (Object.keys(patch).length > 0) {
    await db
      .update(projectTaskLabels)
      .set(patch)
      .where(
        and(
          eq(projectTaskLabels.id, label.id),
          eq(projectTaskLabels.agencyId, actor.agencyId),
        ),
      );
  }

  await auditAs(actor, req, {
    action: 'label.update',
    entityType: 'label',
    entityId: label.id,
    metadata: { projectId, ...patch },
  });

  const [row] = await db
    .select()
    .from(projectTaskLabels)
    .where(and(eq(projectTaskLabels.id, label.id), eq(projectTaskLabels.agencyId, actor.agencyId)));
  ok(res, serializeLabel(row!));
});

// DELETE /projects/:id/labels/:labelId (cascades links) — project_labels.manage
projectsRouter.delete('/:id/labels/:labelId', requires('project_labels.manage'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'project_labels.manage');
  const label = await getScopedLabel(actor.agencyId, projectId, param(req, 'labelId'));

  await db
    .delete(projectTaskLabels)
    .where(
      and(
        eq(projectTaskLabels.id, label.id),
        eq(projectTaskLabels.agencyId, actor.agencyId),
      ),
    );

  await auditAs(actor, req, {
    action: 'label.delete',
    entityType: 'label',
    entityId: label.id,
    metadata: { projectId, name: label.name },
  });
  ok(res, { deleted: true });
});

// ============================================================
//  TASKS
// ============================================================

// GET /projects/:id/tasks — flexible, composable list  §3.6
const DUE_FILTERS = ['overdue', 'today', 'week', 'none'] as const;
const TASK_SORTS = [
  'manual',
  'priority',
  'due',
  'created',
  'updated',
  'title',
] as const;

/** Coerce a query param into a string[] whether it arrives as a or a[]. */
function toArray(v: unknown): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.map(String).filter((s) => s.length > 0);
  return [String(v)].filter((s) => s.length > 0);
}

const listTasksQuery = z.object({
  group: z
    .enum(['status', 'assignee', 'priority', 'label', 'milestone', 'none'])
    .optional(),
  due: z.enum(DUE_FILTERS).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(TASK_SORTS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  includeSubtasks: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v !== 'false'),
});

// tasks.view — project must be visible (projects.view); rows filtered by the
// actor's tasks.view scope in SQL.
projectsRouter.get('/:id/tasks', requires('tasks.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'projects.view');

  const q = listTasksQuery.parse(req.query);
  const statusFilter = toArray(req.query['status[]'] ?? req.query.status).filter(
    (s): s is (typeof TASK_STATUSES)[number] =>
      (TASK_STATUSES as readonly string[]).includes(s),
  );
  const assigneeFilter = toArray(
    req.query['assignee[]'] ?? req.query.assignee,
  );
  const priorityFilter = toArray(
    req.query['priority[]'] ?? req.query.priority,
  ).filter((p): p is (typeof TASK_PRIORITIES)[number] =>
    (TASK_PRIORITIES as readonly string[]).includes(p),
  );
  const labelFilter = toArray(req.query['label[]'] ?? req.query.label);
  const milestoneFilter = toArray(
    req.query['milestone[]'] ?? req.query.milestone,
  );

  const filters: SQL[] = [
    eq(projectTasks.agencyId, actor.agencyId),
    eq(projectTasks.projectId, projectId),
    // Archived (past-month, incomplete) tasks live only in the Tasks-module
    // History; the project board shows active tasks.
    isNull(projectTasks.archivedAt),
    taskScopeFilter(actor, 'tasks.view'),
  ];

  if (!q.includeSubtasks) filters.push(isNull(projectTasks.parentTaskId));
  if (statusFilter.length > 0)
    filters.push(inArray(projectTasks.status, statusFilter));
  if (priorityFilter.length > 0)
    filters.push(inArray(projectTasks.priority, priorityFilter));
  if (milestoneFilter.length > 0)
    filters.push(inArray(projectTasks.milestoneId, milestoneFilter));

  if (assigneeFilter.length > 0) {
    const ids = assigneeFilter.filter((a) => a !== 'unassigned');
    const wantsUnassigned = assigneeFilter.includes('unassigned');
    const parts: SQL[] = [];
    // Match a task when ANY of its assignees is one of the requested users.
    if (ids.length > 0) {
      const assigned = db
        .select({ taskId: taskAssignees.taskId })
        .from(taskAssignees)
        .where(
          and(
            eq(taskAssignees.agencyId, actor.agencyId),
            inArray(taskAssignees.userId, ids),
          ),
        );
      parts.push(inArray(projectTasks.id, assigned));
    }
    // Unassigned = no primary assignee (the mirror is kept in sync with the
    // join set, so this also means no taskAssignees rows).
    if (wantsUnassigned) parts.push(isNull(projectTasks.assigneeId));
    if (parts.length > 0) filters.push(or(...parts)!);
  }

  if (q.q && q.q.length > 0) {
    filters.push(like(projectTasks.title, `%${q.q}%`));
  }

  // Due-date buckets (computed against the server's "now").
  if (q.due) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
    const endOfWeek = new Date(startOfToday);
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    if (q.due === 'none') {
      filters.push(isNull(projectTasks.dueDate));
    } else if (q.due === 'overdue') {
      filters.push(
        sql`${projectTasks.dueDate} is not null and ${projectTasks.dueDate} < ${startOfToday}`,
      );
    } else if (q.due === 'today') {
      filters.push(
        sql`${projectTasks.dueDate} >= ${startOfToday} and ${projectTasks.dueDate} < ${startOfTomorrow}`,
      );
    } else if (q.due === 'week') {
      filters.push(
        sql`${projectTasks.dueDate} >= ${startOfToday} and ${projectTasks.dueDate} < ${endOfWeek}`,
      );
    }
  }

  // Restrict to tasks carrying any of the requested labels.
  if (labelFilter.length > 0) {
    const linked = db
      .select({ taskId: projectTaskLabelLinks.taskId })
      .from(projectTaskLabelLinks)
      .where(
        and(
          eq(projectTaskLabelLinks.agencyId, actor.agencyId),
          inArray(projectTaskLabelLinks.labelId, labelFilter),
        ),
      );
    filters.push(inArray(projectTasks.id, linked));
  }

  // Sorting. `manual` (default) = position asc; priority uses an explicit rank
  // because the enum is text. Secondary key is position for stability.
  const dir = q.dir === 'desc' ? desc : asc;
  const sort = q.sort ?? 'manual';
  let orderBy;
  if (sort === 'priority') {
    const rank = sql`case ${projectTasks.priority}
      when 'urgent' then 0 when 'high' then 1 when 'medium' then 2
      when 'low' then 3 else 4 end`;
    orderBy = [dir(rank), asc(projectTasks.position)];
  } else if (sort === 'due') {
    orderBy = [
      sql`${projectTasks.dueDate} is null`,
      dir(projectTasks.dueDate),
      asc(projectTasks.position),
    ];
  } else if (sort === 'created') {
    orderBy = [dir(projectTasks.createdAt)];
  } else if (sort === 'updated') {
    orderBy = [dir(projectTasks.updatedAt)];
  } else if (sort === 'title') {
    orderBy = [dir(projectTasks.title)];
  } else {
    orderBy = [asc(projectTasks.position), asc(projectTasks.createdAt)];
  }

  const rows = await db
    .select()
    .from(projectTasks)
    .where(and(...filters))
    .orderBy(...orderBy);

  ok(res, await withTaskCapabilities(actor, await enrichTasks(actor.agencyId, rows)));
});

/**
 * Verify a candidate parent task is a valid one-level parent in this project:
 * exists, same project/agency, and is itself a top-level task. Returns the
 * parent row (its milestoneId is inherited by new subtasks). Throws 422 on a
 * nesting violation, 404 if not found.
 */
async function requireValidParentTask(
  agencyId: string,
  projectId: string,
  parentTaskId: string,
  selfId?: string,
) {
  if (selfId && parentTaskId === selfId) {
    throw new AppError('VALIDATION_ERROR', 'A task cannot be its own parent.');
  }
  const parent = await requireTaskInProject(agencyId, projectId, parentTaskId);
  if (parent.parentTaskId !== null) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Subtasks can only be nested one level deep.',
    );
  }
  return parent;
}

// POST /projects/:id/tasks — tasks.create on the project; assigning anyone
// other than exactly [actor] needs tasks.assign.
const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  milestoneId: z.string().min(1).nullable().optional(),
  assigneeId: z.string().min(1).optional(),
  assigneeIds: z.array(z.string().min(1)).max(20).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  estimateMinutes: z.number().int().min(0).nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().optional(),
  parentTaskId: z.string().min(1).nullable().optional(),
  position: z.number().int().min(0).optional(),
});

projectsRouter.post('/:id/tasks', requires('tasks.create'), async (req, res) => {
  const actor = getActor(req);
  const uid = staffUserId(actor);
  const projectId = param(req, 'id');
  const pf = await authorizeProject(actor, projectId, 'tasks.create');
  const body = createTaskSchema.parse(req.body);

  // Resolve the assignee set: explicit `assigneeIds` wins, else the legacy
  // single `assigneeId`. When NONE is given, auto-assign to the CREATOR so
  // members can self-create tasks.
  const requested =
    body.assigneeIds ?? (body.assigneeId ? [body.assigneeId] : []);
  const assigneeIds = [...new Set(requested.length ? requested : [uid])];
  await authorizeAssignees(actor, pf, assigneeIds);
  const primaryAssigneeId = assigneeIds[0] ?? null;

  // Subtasks inherit their parent's milestone when one isn't given.
  let parent: typeof projectTasks.$inferSelect | undefined;
  if (body.parentTaskId) {
    parent = await requireValidParentTask(actor.agencyId, projectId, body.parentTaskId);
  }

  let milestoneId = body.milestoneId ?? null;
  if (milestoneId) {
    await requireMilestoneInProject(actor.agencyId, projectId, milestoneId);
  } else if (body.milestoneId === undefined && parent) {
    milestoneId = parent.milestoneId;
  }

  const id = newId('ptk');
  // status -> 'done' at creation stamps completedAt.
  const completedAt = body.status === 'done' ? new Date() : null;
  await db.insert(projectTasks).values({
    id,
    agencyId: actor.agencyId,
    projectId,
    createdBy: uid,
    title: body.title,
    description: body.description ?? null,
    ...(body.status !== undefined ? { status: body.status } : {}),
    milestoneId,
    assigneeId: primaryAssigneeId,
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
    estimateMinutes: body.estimateMinutes ?? null,
    startDate: body.startDate ?? null,
    dueDate: body.dueDate ?? null,
    completedAt,
    parentTaskId: body.parentTaskId ?? null,
    ...(body.position !== undefined ? { position: body.position } : {}),
  });

  // Sync the M:N join table with the resolved assignee set.
  await syncTaskAssignees(actor.agencyId, id, assigneeIds);

  await auditAs(actor, req, {
    action: body.parentTaskId ? 'task.subtask_add' : 'task.create',
    entityType: 'task',
    entityId: id,
    metadata: {
      projectId,
      taskTitle: body.title,
      status: body.status ?? 'todo',
      ...(primaryAssigneeId ? { assigneeId: primaryAssigneeId } : {}),
      ...(milestoneId ? { milestoneId } : {}),
      ...(body.parentTaskId ? { parentTaskId: body.parentTaskId } : {}),
    },
  });

  const [row] = await db
    .select()
    .from(projectTasks)
    .where(and(eq(projectTasks.id, id), eq(projectTasks.agencyId, actor.agencyId)));
  const [enriched] = await withTaskCapabilities(
    actor,
    await attachAssignees(actor.agencyId, [serializeTask(row!)]),
  );
  created(res, enriched);
});

// POST /projects/:id/tasks/bulk — create many (unassigned) tasks from titles.
// tasks.create on the project.
const bulkCreateTaskSchema = z.object({
  titles: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  milestoneId: z.string().min(1).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
});

projectsRouter.post('/:id/tasks/bulk', requires('tasks.create'), async (req, res) => {
  const actor = getActor(req);
  const uid = staffUserId(actor);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'tasks.create');
  const body = bulkCreateTaskSchema.parse(req.body);

  if (body.milestoneId) {
    await requireMilestoneInProject(actor.agencyId, projectId, body.milestoneId);
  }

  // Position new tasks sequentially after the current max in the project.
  const [{ maxPos } = { maxPos: null }] = await db
    .select({ maxPos: sql<number | null>`max(${projectTasks.position})` })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, actor.agencyId),
        eq(projectTasks.projectId, projectId),
      ),
    );
  let position = (maxPos ?? -1) + 1;

  const ids: string[] = [];
  for (const title of body.titles) {
    const id = newId('ptk');
    ids.push(id);
    await db.insert(projectTasks).values({
      id,
      agencyId: actor.agencyId,
      projectId,
      createdBy: uid,
      title,
      ...(body.status !== undefined ? { status: body.status } : {}),
      milestoneId: body.milestoneId ?? null,
      completedAt: body.status === 'done' ? new Date() : null,
      position: position++,
    });
  }

  await auditAs(actor, req, {
    action: 'task.bulk_create',
    entityType: 'task',
    entityId: projectId,
    metadata: {
      projectId,
      count: ids.length,
      ...(body.milestoneId ? { milestoneId: body.milestoneId } : {}),
    },
  });

  const rows = await db
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, actor.agencyId),
        eq(projectTasks.projectId, projectId),
        inArray(projectTasks.id, ids),
      ),
    )
    .orderBy(asc(projectTasks.position));

  created(
    res,
    await withTaskCapabilities(
      actor,
      await attachAssignees(actor.agencyId, rows.map(serializeTask)),
    ),
  );
});

// PATCH /projects/:id/tasks/:taskId  §3.3 — tasks.update on the task;
// assignee changes follow authorizeAssignees (tasks.assign unless self-only).
const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  milestoneId: z.string().min(1).nullable().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  assigneeIds: z.array(z.string().min(1)).max(20).nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  estimateMinutes: z.number().int().min(0).nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  parentTaskId: z.string().min(1).nullable().optional(),
  position: z.number().int().min(0).optional(),
});

/**
 * Calendar pipeline side effect: a task auto-created by publishing a content
 * calendar sheet links to a content post. Completing the task publishes the
 * post; reopening reverts it to scheduled. The post is only touched when the
 * caller holds posts.publish on the post's client; the write itself runs as a
 * system actor (audited `actorType: 'system'`).
 */
async function syncLinkedPost(
  actor: Actor,
  req: Request,
  task: typeof projectTasks.$inferSelect,
  nowDone: boolean,
): Promise<void> {
  if (!task.postId) return;
  const [post] = await db
    .select({
      id: contentPosts.id,
      clientId: contentPosts.clientId,
      status: contentPosts.status,
    })
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.id, task.postId),
        eq(contentPosts.agencyId, actor.agencyId),
      ),
    )
    .limit(1);
  if (!post) return;
  const nextStatus = nowDone ? 'posted' : 'scheduled';
  if (post.status === nextStatus) return;
  if (!check(actor, 'posts.publish', await clientFacts(actor, post.clientId))) return;

  const sys = systemActor('task_post_sync', actor.agencyId, [
    { permission: 'posts.publish', scope: 'organization' },
  ]);
  if (!check(sys, 'posts.publish', { agencyId: actor.agencyId, clientId: post.clientId })) return;
  await db
    .update(contentPosts)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(and(eq(contentPosts.id, post.id), eq(contentPosts.agencyId, actor.agencyId)));
  broadcastPortalRefresh(post.clientId);
  await auditAs(sys, req, {
    action: 'post.status_sync',
    entityType: 'post',
    entityId: post.id,
    metadata: {
      clientId: post.clientId,
      taskId: task.id,
      projectId: task.projectId,
      fromStatus: post.status,
      toStatus: nextStatus,
      triggeredBy: actorAuditId(actor),
    },
  });
}

projectsRouter.patch('/:id/tasks/:taskId', requires('tasks.update'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const facts = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.update');
  const task = facts.task;
  const body = updateTaskSchema.parse(req.body);

  // Resolve the next assignee set. `assigneeIds` (when present) is authoritative
  // and replaces the join; otherwise the legacy single `assigneeId` mirrors to
  // a one-or-zero element set. `nextAssigneeIds === undefined` => leave as-is.
  let nextAssigneeIds: string[] | undefined;
  if (body.assigneeIds !== undefined) {
    nextAssigneeIds = [...new Set(body.assigneeIds ?? [])];
  } else if (body.assigneeId !== undefined) {
    nextAssigneeIds = body.assigneeId ? [body.assigneeId] : [];
  }
  if (nextAssigneeIds !== undefined) {
    const current = await currentAssigneeIds(actor.agencyId, task);
    if (sameSet(current, nextAssigneeIds)) {
      // No effective change: keep the order the caller sent (primary mirror).
    } else {
      await authorizeAssignees(actor, facts, nextAssigneeIds);
    }
  }
  if (body.milestoneId) {
    await requireMilestoneInProject(actor.agencyId, projectId, body.milestoneId);
  }

  // Re-parenting: the new parent must be a top-level task in this project, and
  // this task must not already have children (else it would create a 3rd level).
  if (body.parentTaskId) {
    await requireValidParentTask(actor.agencyId, projectId, body.parentTaskId, task.id);
    const [child] = await db
      .select({ id: projectTasks.id })
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.agencyId, actor.agencyId),
          eq(projectTasks.parentTaskId, task.id),
        ),
      )
      .limit(1);
    if (child) {
      throw new AppError(
        'VALIDATION_ERROR',
        'A task with subtasks cannot become a subtask itself.',
      );
    }
  }

  const patch: Partial<typeof projectTasks.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.status !== undefined) patch.status = body.status;
  if (body.milestoneId !== undefined) patch.milestoneId = body.milestoneId;
  // Mirror the primary (first) assignee onto the column for backward-compat.
  const nextPrimaryAssigneeId =
    nextAssigneeIds !== undefined ? (nextAssigneeIds[0] ?? null) : undefined;
  if (nextPrimaryAssigneeId !== undefined)
    patch.assigneeId = nextPrimaryAssigneeId;
  if (body.priority !== undefined) patch.priority = body.priority;
  if (body.estimateMinutes !== undefined)
    patch.estimateMinutes = body.estimateMinutes;
  if (body.startDate !== undefined) patch.startDate = body.startDate;
  if (body.dueDate !== undefined) patch.dueDate = body.dueDate;
  if (body.parentTaskId !== undefined) patch.parentTaskId = body.parentTaskId;
  if (body.position !== undefined) patch.position = body.position;

  // completedAt is derived from status: entering 'done' stamps it; leaving
  // 'done' clears it. Only touch it when status actually changes.
  if (body.status !== undefined && body.status !== task.status) {
    patch.completedAt = body.status === 'done' ? new Date() : null;
  }

  await db
    .update(projectTasks)
    .set(patch)
    .where(
      and(
        eq(projectTasks.id, task.id),
        eq(projectTasks.agencyId, actor.agencyId),
      ),
    );

  // Replace the M:N join set when assignees were touched (either field).
  if (nextAssigneeIds !== undefined) {
    await syncTaskAssignees(actor.agencyId, task.id, nextAssigneeIds);
  }

  // Completing a task auto-stops running timers on it: the caller's own as the
  // caller, other people's as a system actor. Best-effort.
  if (body.status === 'done' && task.status !== 'done') {
    await stopTimersForTask(actor, task.id, patch.title ?? task.title).catch(
      () => undefined,
    );
  }

  if (task.postId && body.status !== undefined && body.status !== task.status) {
    const nowDone = body.status === 'done';
    const wasDone = task.status === 'done';
    if (nowDone !== wasDone) {
      await syncLinkedPost(actor, req, task, nowDone).catch(() => undefined);
    }
  }

  // Audit: a status change is its own action for the activity feed; otherwise
  // it's a generic task.update. Always carry the changed-field deltas.
  const statusChanged =
    body.status !== undefined && body.status !== task.status;
  const assigneeChanged =
    nextPrimaryAssigneeId !== undefined &&
    nextPrimaryAssigneeId !== task.assigneeId;
  const milestoneChanged =
    body.milestoneId !== undefined && body.milestoneId !== task.milestoneId;
  const priorityChanged =
    body.priority !== undefined && body.priority !== task.priority;
  const parentChanged =
    body.parentTaskId !== undefined &&
    body.parentTaskId !== task.parentTaskId;

  await auditAs(actor, req, {
    action: statusChanged ? 'task.status_change' : 'task.update',
    entityType: 'task',
    entityId: task.id,
    metadata: {
      projectId,
      taskTitle: patch.title ?? task.title,
      ...(statusChanged
        ? { fromStatus: task.status, toStatus: body.status }
        : {}),
      ...(assigneeChanged ? { assigneeId: nextPrimaryAssigneeId } : {}),
      ...(nextAssigneeIds !== undefined ? { assigneeIds: nextAssigneeIds } : {}),
      ...(milestoneChanged ? { milestoneId: body.milestoneId } : {}),
      ...(priorityChanged
        ? { fromPriority: task.priority, toPriority: body.priority }
        : {}),
      ...(parentChanged ? { parentTaskId: body.parentTaskId } : {}),
    },
  });

  const [row] = await db
    .select()
    .from(projectTasks)
    .where(and(eq(projectTasks.id, task.id), eq(projectTasks.agencyId, actor.agencyId)));
  const [enriched] = await withTaskCapabilities(
    actor,
    await attachAssignees(actor.agencyId, [serializeTask(row!)]),
  );
  ok(res, enriched);
});

// GET /projects/:id/tasks/:taskId/subtasks  §3.4 — tasks.view on the parent;
// subtasks filtered by the actor's tasks.view scope.
projectsRouter.get('/:id/tasks/:taskId/subtasks', requires('tasks.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const { task } = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.view');

  const rows = await db
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, actor.agencyId),
        eq(projectTasks.projectId, projectId),
        eq(projectTasks.parentTaskId, task.id),
        taskScopeFilter(actor, 'tasks.view'),
      ),
    )
    .orderBy(asc(projectTasks.position), asc(projectTasks.createdAt));

  ok(res, await withTaskCapabilities(actor, await enrichTasks(actor.agencyId, rows)));
});

// DELETE /projects/:id/tasks/:taskId — tasks.delete (own = creator, project,
// organization). Being an assignee does NOT grant delete.
projectsRouter.delete('/:id/tasks/:taskId', requires('tasks.delete'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const { task } = await authorizeTask(
    actor,
    projectId,
    param(req, 'taskId'),
    'tasks.delete',
    "You don't have permission to delete this task.",
  );

  await db
    .delete(projectTasks)
    .where(
      and(
        eq(projectTasks.id, task.id),
        eq(projectTasks.agencyId, actor.agencyId),
      ),
    );

  await auditAs(actor, req, {
    action: 'task.delete',
    entityType: 'task',
    entityId: task.id,
    metadata: { projectId, taskTitle: task.title },
  });
  ok(res, { deleted: true });
});

// ============================================================
//  TASK LABEL LINKS  §3.2
// ============================================================

// PUT /projects/:id/tasks/:taskId/labels — replace the full label set.
// tasks.update on the task; labels must belong to the task's project.
const putTaskLabelsSchema = z.object({
  labelIds: z.array(z.string().min(1)).max(50),
});

projectsRouter.put('/:id/tasks/:taskId/labels', requires('tasks.update'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const { task } = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.update');
  const body = putTaskLabelsSchema.parse(req.body);

  // De-dupe and validate every requested label belongs to this project.
  const wanted = [...new Set(body.labelIds)];
  await requireLabelsInProject(actor.agencyId, projectId, wanted);

  // Replace the full set: delete-then-insert in a transaction.
  await db.transaction(async (tx) => {
    await tx
      .delete(projectTaskLabelLinks)
      .where(
        and(
          eq(projectTaskLabelLinks.agencyId, actor.agencyId),
          eq(projectTaskLabelLinks.taskId, task.id),
        ),
      );
    if (wanted.length > 0) {
      await tx.insert(projectTaskLabelLinks).values(
        wanted.map((labelId) => ({
          agencyId: actor.agencyId,
          taskId: task.id,
          labelId,
        })),
      );
    }
  });

  await auditAs(actor, req, {
    action: 'task.label_change',
    entityType: 'task',
    entityId: task.id,
    metadata: { projectId, labelIds: wanted },
  });

  // Return the resolved labels for the task.
  const labels =
    wanted.length === 0
      ? []
      : (
          await db
            .select()
            .from(projectTaskLabels)
            .where(
              and(
                eq(projectTaskLabels.agencyId, actor.agencyId),
                inArray(projectTaskLabels.id, wanted),
              ),
            )
            .orderBy(asc(projectTaskLabels.name))
        ).map(serializeLabel);

  ok(res, labels);
});

// ============================================================
//  TASK DEPENDENCIES (blocks / blocked-by)  §3.5
// ============================================================

/**
 * Detect whether adding edge (blocker -> blocked) would create a cycle, by a
 * bounded BFS over the project's existing dependency graph: starting from
 * `blocked`, follow blocker->blocked edges; if we can reach `blocker`, the new
 * edge would close a loop. Bounded by total edge count.
 */
async function dependencyWouldCycle(
  agencyId: string,
  projectId: string,
  blockerTaskId: string,
  blockedTaskId: string,
): Promise<boolean> {
  const edges = await db
    .select({
      blocker: projectTaskDependencies.blockerTaskId,
      blocked: projectTaskDependencies.blockedTaskId,
    })
    .from(projectTaskDependencies)
    .where(
      and(
        eq(projectTaskDependencies.agencyId, agencyId),
        eq(projectTaskDependencies.projectId, projectId),
      ),
    );

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.blocker) ?? [];
    list.push(e.blocked);
    adj.set(e.blocker, list);
  }

  // BFS from blockedTaskId following downstream edges; reaching blockerTaskId
  // means blocker already (transitively) depends on blocked -> cycle.
  const visited = new Set<string>();
  const queue = [blockedTaskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === blockerTaskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adj.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return false;
}

/**
 * Resolve a task's blocked-by + blocks lists into serialized tasks + dep ids.
 * Only related tasks the actor may view (tasks.view scope) are returned.
 */
async function loadTaskDependencies(actor: Actor, taskId: string) {
  const visible = taskScopeFilter(actor, 'tasks.view');
  // Edges where this task is the blocked side -> its blockers.
  const blockedByEdges = await db
    .select({
      depId: projectTaskDependencies.id,
      task: projectTasks,
    })
    .from(projectTaskDependencies)
    .innerJoin(
      projectTasks,
      eq(projectTasks.id, projectTaskDependencies.blockerTaskId),
    )
    .where(
      and(
        eq(projectTaskDependencies.agencyId, actor.agencyId),
        eq(projectTaskDependencies.blockedTaskId, taskId),
        visible,
      ),
    )
    .orderBy(asc(projectTaskDependencies.createdAt));

  // Edges where this task is the blocker -> the tasks it blocks.
  const blocksEdges = await db
    .select({
      depId: projectTaskDependencies.id,
      task: projectTasks,
    })
    .from(projectTaskDependencies)
    .innerJoin(
      projectTasks,
      eq(projectTasks.id, projectTaskDependencies.blockedTaskId),
    )
    .where(
      and(
        eq(projectTaskDependencies.agencyId, actor.agencyId),
        eq(projectTaskDependencies.blockerTaskId, taskId),
        visible,
      ),
    )
    .orderBy(asc(projectTaskDependencies.createdAt));

  return {
    blockedBy: blockedByEdges.map((e) => ({
      depId: e.depId,
      task: serializeTask(e.task),
    })),
    blocks: blocksEdges.map((e) => ({
      depId: e.depId,
      task: serializeTask(e.task),
    })),
  };
}

// GET /projects/:id/tasks/:taskId/dependencies -> { blockedBy, blocks } — tasks.view
projectsRouter.get('/:id/tasks/:taskId/dependencies', requires('tasks.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const { task } = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.view');
  ok(res, await loadTaskDependencies(actor, task.id));
});

// POST /projects/:id/tasks/:taskId/dependencies { type, otherTaskId }
// tasks.update on the task + tasks.view on the other task (same project).
const createDependencySchema = z.object({
  type: z.enum(['blocks', 'blocked_by']),
  otherTaskId: z.string().min(1),
});

projectsRouter.post('/:id/tasks/:taskId/dependencies', requires('tasks.update'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const { task } = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.update');
  const body = createDependencySchema.parse(req.body);

  if (body.otherTaskId === task.id) {
    throw new AppError(
      'VALIDATION_ERROR',
      'A task cannot depend on itself.',
    );
  }
  // The other task must live in this project and be visible to the caller.
  const { task: other } = await authorizeTask(actor, projectId, body.otherTaskId, 'tasks.view');

  // Normalize to canonical (blocker -> blocked).
  const blockerTaskId = body.type === 'blocks' ? task.id : other.id;
  const blockedTaskId = body.type === 'blocks' ? other.id : task.id;

  // Reject duplicate (also guarded by the unique index).
  const [dup] = await db
    .select({ id: projectTaskDependencies.id })
    .from(projectTaskDependencies)
    .where(
      and(
        eq(projectTaskDependencies.agencyId, actor.agencyId),
        eq(projectTaskDependencies.blockerTaskId, blockerTaskId),
        eq(projectTaskDependencies.blockedTaskId, blockedTaskId),
      ),
    )
    .limit(1);
  if (dup) throw conflict('That dependency already exists.');

  // Reject any edge that would introduce a cycle (covers 2-cycles too).
  if (
    await dependencyWouldCycle(
      actor.agencyId,
      projectId,
      blockerTaskId,
      blockedTaskId,
    )
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      'That dependency would create a cycle.',
    );
  }

  const id = newId('pdp');
  await db.insert(projectTaskDependencies).values({
    id,
    agencyId: actor.agencyId,
    projectId,
    blockerTaskId,
    blockedTaskId,
    createdBy: staffUserId(actor),
  });

  await auditAs(actor, req, {
    action: 'task.dependency_add',
    entityType: 'task',
    entityId: task.id,
    metadata: { projectId, blockerTaskId, blockedTaskId },
  });

  created(res, await loadTaskDependencies(actor, task.id));
});

// DELETE /projects/:id/tasks/:taskId/dependencies/:depId — tasks.update on the task
projectsRouter.delete(
  '/:id/tasks/:taskId/dependencies/:depId',
  requires('tasks.update'),
  async (req, res) => {
    const actor = getActor(req);
    const projectId = param(req, 'id');
    const { task } = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.update');
    const depId = param(req, 'depId');

    const [dep] = await db
      .select()
      .from(projectTaskDependencies)
      .where(
        and(
          eq(projectTaskDependencies.id, depId),
          eq(projectTaskDependencies.agencyId, actor.agencyId),
          eq(projectTaskDependencies.projectId, projectId),
        ),
      )
      .limit(1);
    if (!dep) throw notFound('Dependency not found.');
    // The dep must touch this task (either side of the edge).
    if (dep.blockerTaskId !== task.id && dep.blockedTaskId !== task.id) {
      throw notFound('Dependency not found.');
    }

    await db
      .delete(projectTaskDependencies)
      .where(
        and(
          eq(projectTaskDependencies.id, depId),
          eq(projectTaskDependencies.agencyId, actor.agencyId),
        ),
      );

    await auditAs(actor, req, {
      action: 'task.dependency_remove',
      entityType: 'task',
      entityId: task.id,
      metadata: {
        projectId,
        blockerTaskId: dep.blockerTaskId,
        blockedTaskId: dep.blockedTaskId,
      },
    });

    ok(res, await loadTaskDependencies(actor, task.id));
  },
);

// ============================================================
//  TASK COMMENTS  §3.8
// ============================================================

/** Serialize a comment row joined with its author's name. */
function serializeComment(c: {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  mentionsJson: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  deletedAt: Date | null;
  authorName: string | null;
}) {
  let mentions: string[] = [];
  if (c.mentionsJson) {
    try {
      const v = JSON.parse(c.mentionsJson);
      if (Array.isArray(v)) mentions = v.filter((x): x is string => typeof x === 'string');
    } catch {
      mentions = [];
    }
  }
  return {
    id: c.id,
    taskId: c.taskId,
    authorId: c.authorId,
    authorName: c.authorName,
    body: c.body,
    mentions,
    createdAt: toIso(c.createdAt),
    updatedAt: toIso(c.updatedAt),
    deletedAt: toIso(c.deletedAt),
  };
}

const commentSelection = {
  id: projectTaskComments.id,
  taskId: projectTaskComments.taskId,
  authorId: projectTaskComments.authorId,
  body: projectTaskComments.body,
  mentionsJson: projectTaskComments.mentionsJson,
  createdAt: projectTaskComments.createdAt,
  updatedAt: projectTaskComments.updatedAt,
  deletedAt: projectTaskComments.deletedAt,
  authorName: users.fullName,
};

/**
 * Parse explicit `mentions` (array of userIds) plus any `@token`s in the body.
 * Only ACTIVE STAFF of the agency can be mentioned (client accounts and
 * outsiders are dropped). Returns the validated, de-duped set of user ids.
 */
async function resolveMentions(
  agencyId: string,
  body: string,
  explicit: string[] | undefined,
): Promise<string[]> {
  const staff = and(
    eq(users.agencyId, agencyId),
    eq(users.kind, 'staff'),
    eq(users.status, 'active'),
  );
  const ids = new Set<string>(explicit ?? []);

  // Lightweight @-token parse: @ followed by name-ish chars (handles @jane or
  // @"Jane Doe"-style single tokens). Matched against user full names/emails.
  const tokens = [...body.matchAll(/@([\w.\-]+)/g)].map((m) => m[1]!);
  if (tokens.length > 0) {
    const candidates = await db
      .select({ id: users.id, email: users.email, fullName: users.fullName })
      .from(users)
      .where(staff);
    for (const tok of tokens) {
      const low = tok.toLowerCase();
      const hit = candidates.find(
        (u) =>
          u.email.toLowerCase().startsWith(low) ||
          (u.fullName ?? '').toLowerCase().replace(/\s+/g, '').startsWith(low),
      );
      if (hit) ids.add(hit.id);
    }
  }

  if (ids.size === 0) return [];

  const valid = await db
    .select({ id: users.id })
    .from(users)
    .where(and(staff, inArray(users.id, [...ids])));
  return valid.map((u) => u.id);
}

async function loadComments(agencyId: string, taskId: string) {
  const rows = await db
    .select(commentSelection)
    .from(projectTaskComments)
    .leftJoin(users, eq(users.id, projectTaskComments.authorId))
    .where(
      and(
        eq(projectTaskComments.agencyId, agencyId),
        eq(projectTaskComments.taskId, taskId),
        isNull(projectTaskComments.deletedAt),
      ),
    )
    .orderBy(asc(projectTaskComments.createdAt));
  return rows.map(serializeComment);
}

async function loadComment(agencyId: string, commentId: string) {
  const [row] = await db
    .select(commentSelection)
    .from(projectTaskComments)
    .leftJoin(users, eq(users.id, projectTaskComments.authorId))
    .where(and(eq(projectTaskComments.id, commentId), eq(projectTaskComments.agencyId, agencyId)));
  return serializeComment(row!);
}

// GET /projects/:id/tasks/:taskId/comments (non-deleted, oldest-first) — tasks.view
projectsRouter.get('/:id/tasks/:taskId/comments', requires('tasks.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const { task } = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.view');
  ok(res, await loadComments(actor.agencyId, task.id));
});

// POST /projects/:id/tasks/:taskId/comments { body, mentions? } — task_comments.create
const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  mentions: z.array(z.string().min(1)).max(50).optional(),
});

projectsRouter.post('/:id/tasks/:taskId/comments', requires('task_comments.create'), async (req, res) => {
  const actor = getActor(req);
  const uid = staffUserId(actor);
  const projectId = param(req, 'id');
  const { task } = await authorizeTask(actor, projectId, param(req, 'taskId'), 'task_comments.create');
  const body = createCommentSchema.parse(req.body);

  const mentions = await resolveMentions(actor.agencyId, body.body, body.mentions);

  const id = newId('pcm');
  await db.insert(projectTaskComments).values({
    id,
    agencyId: actor.agencyId,
    taskId: task.id,
    authorId: uid,
    body: body.body,
    mentionsJson: mentions.length > 0 ? JSON.stringify(mentions) : null,
  });

  await auditAs(actor, req, {
    action: 'task.comment_add',
    entityType: 'task',
    entityId: task.id,
    metadata: {
      projectId,
      commentId: id,
      ...(mentions.length > 0 ? { mentions } : {}),
    },
  });

  created(res, await loadComment(actor.agencyId, id));
});

// PATCH /projects/:id/tasks/:taskId/comments/:commentId
// tasks.view on the task (404) + task_comments.update on the comment (own/org).
const updateCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  mentions: z.array(z.string().min(1)).max(50).optional(),
});

projectsRouter.patch(
  '/:id/tasks/:taskId/comments/:commentId',
  requires('task_comments.update'),
  async (req, res) => {
    const actor = getActor(req);
    const projectId = param(req, 'id');
    const { task } = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.view');
    const cf = await commentFacts(actor, param(req, 'commentId'), task.id);
    authorize(actor, 'task_comments.update', cf, {
      message: 'You can only edit your own comments.',
    });
    const comment = cf!.comment;
    const body = updateCommentSchema.parse(req.body);

    const mentions = await resolveMentions(actor.agencyId, body.body, body.mentions);

    await db
      .update(projectTaskComments)
      .set({
        body: body.body,
        mentionsJson: mentions.length > 0 ? JSON.stringify(mentions) : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectTaskComments.id, comment.id),
          eq(projectTaskComments.agencyId, actor.agencyId),
        ),
      );

    if (comment.authorId !== actorUserId(actor)) {
      await auditAs(actor, req, {
        action: 'task.comment_moderate_edit',
        entityType: 'task',
        entityId: task.id,
        metadata: { projectId, commentId: comment.id, authorId: comment.authorId },
      });
    }

    ok(res, await loadComment(actor.agencyId, comment.id));
  },
);

// DELETE /projects/:id/tasks/:taskId/comments/:commentId (soft delete)
// tasks.view on the task (404) + task_comments.delete on the comment (own/org).
projectsRouter.delete(
  '/:id/tasks/:taskId/comments/:commentId',
  requires('task_comments.delete'),
  async (req, res) => {
    const actor = getActor(req);
    const projectId = param(req, 'id');
    const { task } = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.view');
    const cf = await commentFacts(actor, param(req, 'commentId'), task.id);
    authorize(actor, 'task_comments.delete', cf, {
      message: 'You can only delete your own comments.',
    });
    const comment = cf!.comment;

    await db
      .update(projectTaskComments)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(projectTaskComments.id, comment.id),
          eq(projectTaskComments.agencyId, actor.agencyId),
        ),
      );

    await auditAs(actor, req, {
      action: 'task.comment_delete',
      entityType: 'task',
      entityId: task.id,
      metadata: { projectId, commentId: comment.id, authorId: comment.authorId },
    });

    ok(res, { deleted: true });
  },
);

// ============================================================
//  SINGLE TASK DETAIL  §3.7
// ============================================================

// GET /projects/:id/tasks/:taskId — full detail bundle. tasks.view on the task;
// subtasks and dependency endpoints are filtered by the tasks.view scope.
projectsRouter.get('/:id/tasks/:taskId', requires('tasks.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const facts = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.view');
  const taskRow = facts.task;

  const [enriched] = await enrichTasks(actor.agencyId, [taskRow]);
  const enrichedTask = {
    ...enriched!,
    capabilities: capabilities(actor, facts, TASK_CAPS),
  };

  // Subtasks (children by position) the actor may view.
  const subtaskRows = await db
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, actor.agencyId),
        eq(projectTasks.projectId, projectId),
        eq(projectTasks.parentTaskId, taskRow.id),
        taskScopeFilter(actor, 'tasks.view'),
      ),
    )
    .orderBy(asc(projectTasks.position), asc(projectTasks.createdAt));
  const subtasks = await withTaskCapabilities(
    actor,
    await enrichTasks(actor.agencyId, subtaskRows),
  );

  const dependencies = await loadTaskDependencies(actor, taskRow.id);

  // Comments (non-deleted, oldest-first) with author names.
  const comments = await loadComments(actor.agencyId, taskRow.id);

  // Activity = audit entries for this task entity, with actor names.
  const activityRows = await db
    .select({
      id: auditLog.id,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      action: auditLog.action,
      metadataJson: auditLog.metadataJson,
      createdAt: auditLog.createdAt,
      actorName: users.fullName,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(
      and(
        eq(auditLog.agencyId, actor.agencyId),
        eq(auditLog.entityType, 'task'),
        eq(auditLog.entityId, taskRow.id),
      ),
    )
    .orderBy(asc(auditLog.createdAt));
  const activity = activityRows.map((a) => ({
    id: a.id,
    actorType: a.actorType,
    actorId: a.actorId,
    actorName: a.actorName,
    action: a.action,
    metadata: parseMetadata(a.metadataJson),
    createdAt: toIso(a.createdAt),
  }));

  // Merged chronological feed: activity + comments, each tagged by kind.
  const feed = [
    ...activity.map((a) => ({
      kind: 'activity' as const,
      at: a.createdAt,
      activity: a,
    })),
    ...comments.map((c) => ({
      kind: 'comment' as const,
      at: c.createdAt,
      comment: c,
    })),
  ].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));

  ok(res, {
    task: enrichedTask,
    subtasks,
    labels: enrichedTask.labels ?? [],
    dependencies,
    comments,
    activity,
    feed,
  });
});

// ============================================================
//  MILESTONES
// ============================================================

// GET /projects/:id/milestones — projects.view
projectsRouter.get('/:id/milestones', requires('projects.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'projects.view');

  const rows = await db
    .select()
    .from(projectMilestones)
    .where(
      and(
        eq(projectMilestones.agencyId, actor.agencyId),
        eq(projectMilestones.projectId, projectId),
      ),
    )
    .orderBy(
      asc(projectMilestones.position),
      asc(projectMilestones.createdAt),
    );

  ok(res, rows.map(serializeMilestone));
});

// POST /projects/:id/milestones — project_milestones.manage
const createMilestoneSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  dueDate: z.coerce.date().optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  position: z.number().int().min(0).optional(),
});

projectsRouter.post('/:id/milestones', requires('project_milestones.manage'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'project_milestones.manage');
  const body = createMilestoneSchema.parse(req.body);

  const id = newId('pms');
  await db.insert(projectMilestones).values({
    id,
    agencyId: actor.agencyId,
    projectId,
    title: body.title,
    description: body.description ?? null,
    dueDate: body.dueDate ?? null,
    ...(body.status !== undefined ? { status: body.status } : {}),
    // Setting a milestone as completed at creation stamps completedAt.
    ...(body.status === 'completed' ? { completedAt: new Date() } : {}),
    ...(body.position !== undefined ? { position: body.position } : {}),
  });

  await auditAs(actor, req, {
    action: 'milestone.create',
    entityType: 'milestone',
    entityId: id,
    metadata: {
      projectId,
      milestoneTitle: body.title,
      status: body.status ?? 'pending',
    },
  });

  const [row] = await db
    .select()
    .from(projectMilestones)
    .where(and(eq(projectMilestones.id, id), eq(projectMilestones.agencyId, actor.agencyId)));
  created(res, serializeMilestone(row!));
});

/** Fetch a milestone scoped to the project + agency, or throw 404. */
async function getScopedMilestone(
  agencyId: string,
  projectId: string,
  milestoneId: string,
) {
  const [row] = await db
    .select()
    .from(projectMilestones)
    .where(
      and(
        eq(projectMilestones.id, milestoneId),
        eq(projectMilestones.agencyId, agencyId),
        eq(projectMilestones.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Milestone not found.');
  return row;
}

// PATCH /projects/:id/milestones/:milestoneId — project_milestones.manage
const updateMilestoneSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  position: z.number().int().min(0).optional(),
});

projectsRouter.patch('/:id/milestones/:milestoneId', requires('project_milestones.manage'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'project_milestones.manage');
  const milestone = await getScopedMilestone(actor.agencyId, projectId, param(req, 'milestoneId'));
  const body = updateMilestoneSchema.parse(req.body);

  const patch: Partial<typeof projectMilestones.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.dueDate !== undefined) patch.dueDate = body.dueDate;
  if (body.position !== undefined) patch.position = body.position;
  if (body.status !== undefined) {
    patch.status = body.status;
    // Completing stamps completedAt; un-completing clears it.
    if (body.status === 'completed') {
      patch.completedAt = milestone.completedAt ?? new Date();
    } else {
      patch.completedAt = null;
    }
  }

  await db
    .update(projectMilestones)
    .set(patch)
    .where(
      and(
        eq(projectMilestones.id, milestone.id),
        eq(projectMilestones.agencyId, actor.agencyId),
      ),
    );

  const mStatusChanged =
    body.status !== undefined && body.status !== milestone.status;

  await auditAs(actor, req, {
    action: 'milestone.update',
    entityType: 'milestone',
    entityId: milestone.id,
    metadata: {
      projectId,
      milestoneTitle: patch.title ?? milestone.title,
      ...(mStatusChanged
        ? { fromStatus: milestone.status, toStatus: body.status }
        : {}),
    },
  });

  const [row] = await db
    .select()
    .from(projectMilestones)
    .where(and(eq(projectMilestones.id, milestone.id), eq(projectMilestones.agencyId, actor.agencyId)));
  ok(res, serializeMilestone(row!));
});

// DELETE /projects/:id/milestones/:milestoneId — project_milestones.manage
projectsRouter.delete('/:id/milestones/:milestoneId', requires('project_milestones.manage'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'project_milestones.manage');
  const milestone = await getScopedMilestone(actor.agencyId, projectId, param(req, 'milestoneId'));

  await db
    .delete(projectMilestones)
    .where(
      and(
        eq(projectMilestones.id, milestone.id),
        eq(projectMilestones.agencyId, actor.agencyId),
      ),
    );

  await auditAs(actor, req, {
    action: 'milestone.delete',
    entityType: 'milestone',
    entityId: milestone.id,
    metadata: { projectId, milestoneTitle: milestone.title },
  });
  ok(res, { deleted: true });
});

// ============================================================
//  MEMBERS
// ============================================================

const memberSelection = {
  id: projectMembers.id,
  userId: projectMembers.userId,
  role: projectMembers.role,
  createdAt: projectMembers.createdAt,
  userName: users.fullName,
  userEmail: users.email,
};

function serializeMember(m: {
  id: string;
  userId: string;
  role: string | null;
  createdAt: Date | null;
  userName: string | null;
  userEmail: string | null;
}) {
  return {
    id: m.id,
    userId: m.userId,
    role: m.role,
    userName: m.userName,
    userEmail: m.userEmail,
    createdAt: toIso(m.createdAt),
  };
}

// GET /projects/:id/members — projects.view
projectsRouter.get('/:id/members', requires('projects.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'projects.view');

  const rows = await db
    .select(memberSelection)
    .from(projectMembers)
    .leftJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.agencyId, actor.agencyId),
        eq(projectMembers.projectId, projectId),
      ),
    )
    .orderBy(asc(projectMembers.createdAt));

  ok(res, rows.map(serializeMember));
});

// POST /projects/:id/members — projects.manage_members; target must be active
// staff; role ∈ lead | member.
const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(PROJECT_MEMBER_ROLES).optional(),
});

projectsRouter.post('/:id/members', requires('projects.manage_members'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'projects.manage_members');
  const body = addMemberSchema.parse(req.body);
  await requireActiveStaff(actor.agencyId, [body.userId]);

  const role = body.role ?? 'member';
  await db
    .insert(projectMembers)
    .values({
      id: newId('prm'),
      agencyId: actor.agencyId,
      projectId,
      userId: body.userId,
      role,
    })
    .onConflictDoNothing();

  const [row] = await db
    .select(memberSelection)
    .from(projectMembers)
    .leftJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.agencyId, actor.agencyId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, body.userId),
      ),
    )
    .limit(1);

  await auditAs(actor, req, {
    action: 'member.add',
    entityType: 'project_member',
    entityId: row!.id,
    metadata: {
      projectId,
      userId: body.userId,
      userName: row!.userName,
      role: row!.role,
    },
  });

  created(res, serializeMember(row!));
});

// DELETE /projects/:id/members/:memberId — projects.manage_members
projectsRouter.delete('/:id/members/:memberId', requires('projects.manage_members'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'projects.manage_members');

  const result = await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.id, param(req, 'memberId')),
        eq(projectMembers.agencyId, actor.agencyId),
        eq(projectMembers.projectId, projectId),
      ),
    )
    .returning({ id: projectMembers.id, userId: projectMembers.userId, role: projectMembers.role });
  if (!result.length) throw notFound('Member not found.');

  await auditAs(actor, req, {
    action: 'member.remove',
    entityType: 'project_member',
    entityId: result[0]!.id,
    metadata: { projectId, userId: result[0]!.userId, role: result[0]!.role },
  });

  ok(res, { deleted: true });
});

// ============================================================
//  TIME TRACKING (project-scoped reads; mutations live in timers.ts)
// ============================================================

// GET /projects/:id/timers — running timers in the project: projects.view on
// the project; others' timers only via timers.view scope (own always).
projectsRouter.get('/:id/timers', requires('projects.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'projects.view');
  ok(res, await listProjectTimers(actor, projectId));
});

// GET /projects/:id/time-summary — time_logs.view; totals/by-member/by-task are
// computed over the log rows in the actor's time_logs.view scope.
projectsRouter.get('/:id/time-summary', requires('time_logs.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'projects.view');
  const scope = and(
    eq(timeLogs.agencyId, actor.agencyId),
    eq(timeLogs.projectId, projectId),
    timeLogScopeFilter(actor, 'time_logs.view'),
  );

  const [{ totalMinutes, logCount } = { totalMinutes: 0, logCount: 0 }] =
    await db
      .select({
        totalMinutes: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
        logCount: sql<number>`count(*)`,
      })
      .from(timeLogs)
      .where(scope);

  const byMemberRows = await db
    .select({
      userId: timeLogs.userId,
      userName: users.fullName,
      minutes: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
    })
    .from(timeLogs)
    .leftJoin(users, eq(users.id, timeLogs.userId))
    .where(scope)
    .groupBy(timeLogs.userId, users.fullName)
    .orderBy(desc(sql`sum(${timeLogs.minutes})`));

  const byTaskRows = await db
    .select({
      taskId: timeLogs.taskId,
      taskTitle: projectTasks.title,
      minutes: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
    })
    .from(timeLogs)
    .leftJoin(projectTasks, eq(projectTasks.id, timeLogs.taskId))
    .where(scope)
    .groupBy(timeLogs.taskId, projectTasks.title)
    .orderBy(desc(sql`sum(${timeLogs.minutes})`))
    .limit(15);

  const activeTimers = await listProjectTimers(actor, projectId);

  ok(res, {
    totalMinutes: Number(totalMinutes ?? 0),
    byMember: byMemberRows.map((m) => ({
      userId: m.userId,
      userName: m.userName,
      minutes: Number(m.minutes ?? 0),
    })),
    byTask: byTaskRows.map((tk) => ({
      taskId: tk.taskId,
      taskTitle: tk.taskId ? tk.taskTitle : 'No task',
      minutes: Number(tk.minutes ?? 0),
    })),
    activeTimers,
    logCount: Number(logCount ?? 0),
  });
});

// GET /projects/:id/time-logs?limit — time_logs.view (SQL scope)
const projectLogsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

projectsRouter.get('/:id/time-logs', requires('time_logs.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  await authorizeProject(actor, projectId, 'projects.view');
  const q = projectLogsQuery.parse(req.query);

  const rows = await db
    .select({
      id: timeLogs.id,
      minutes: timeLogs.minutes,
      workDate: timeLogs.workDate,
      note: timeLogs.note,
      userId: timeLogs.userId,
      userName: users.fullName,
      taskId: timeLogs.taskId,
      taskTitle: projectTasks.title,
    })
    .from(timeLogs)
    .leftJoin(users, eq(users.id, timeLogs.userId))
    .leftJoin(projectTasks, eq(projectTasks.id, timeLogs.taskId))
    .where(
      and(
        eq(timeLogs.agencyId, actor.agencyId),
        eq(timeLogs.projectId, projectId),
        timeLogScopeFilter(actor, 'time_logs.view'),
      ),
    )
    .orderBy(desc(timeLogs.workDate))
    .limit(q.limit ?? 50);

  ok(
    res,
    rows.map((l) => ({
      id: l.id,
      minutes: l.minutes,
      workDate: toIso(l.workDate),
      note: l.note,
      userId: l.userId,
      userName: l.userName,
      taskId: l.taskId,
      taskTitle: l.taskTitle,
    })),
  );
});

// GET /projects/:id/tasks/:taskId/time-logs — task-scoped timeline.
// tasks.view on the task + time_logs.view (SQL scope); the running-timer count
// covers only timers the actor may see.
projectsRouter.get('/:id/tasks/:taskId/time-logs', requires('time_logs.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const { task } = await authorizeTask(actor, projectId, param(req, 'taskId'), 'tasks.view');
  const scope = and(
    eq(timeLogs.agencyId, actor.agencyId),
    eq(timeLogs.taskId, task.id),
    timeLogScopeFilter(actor, 'time_logs.view'),
  );

  const rows = await db
    .select({
      id: timeLogs.id,
      minutes: timeLogs.minutes,
      workDate: timeLogs.workDate,
      note: timeLogs.note,
      userId: timeLogs.userId,
      userName: users.fullName,
    })
    .from(timeLogs)
    .leftJoin(users, eq(users.id, timeLogs.userId))
    .where(scope)
    .orderBy(desc(timeLogs.workDate));

  const [{ totalMinutes } = { totalMinutes: 0 }] = await db
    .select({
      totalMinutes: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
    })
    .from(timeLogs)
    .where(scope);

  const [{ activeCount } = { activeCount: 0 }] = await db
    .select({ activeCount: sql<number>`count(*)` })
    .from(timers)
    .where(
      and(
        eq(timers.agencyId, actor.agencyId),
        eq(timers.taskId, task.id),
        timerScopeFilter(actor),
      ),
    );

  ok(res, {
    totalMinutes: Number(totalMinutes ?? 0),
    logCount: rows.length,
    activeTimerCount: Number(activeCount ?? 0),
    logs: rows.map((l) => ({
      id: l.id,
      minutes: l.minutes,
      // start (workDate) → end derived client-side from start + minutes.
      workDate: toIso(l.workDate),
      note: l.note,
      userId: l.userId,
      userName: l.userName,
    })),
  });
});

// ============================================================
//  ACTIVITY FEED
// ============================================================

type ActivityRow = {
  id: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  metadataJson: string | null;
  createdAt: Date | null;
};

function parseMetadata(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function serializeActivity(r: ActivityRow) {
  return {
    id: r.id,
    action: r.action,
    actorId: r.actorId,
    actorName: r.actorName,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata: parseMetadata(r.metadataJson),
    createdAt: toIso(r.createdAt),
  };
}

/**
 * Read the audit feed for a project (rows whose metadata.projectId matches),
 * restricted to what the actor may see: task entries only for tasks in their
 * tasks.view scope; timer / time-log entries only with project- or
 * organization-wide time_logs.view (or their own).
 */
async function fetchProjectActivity(
  actor: Actor,
  facts: ProjectFacts,
  limit: number,
): Promise<ReturnType<typeof serializeActivity>[]> {
  const projectId = facts.projectId;
  const conds: SQL[] = [
    eq(auditLog.agencyId, actor.agencyId),
    sql`(case when json_valid(${auditLog.metadataJson}) then json_extract(${auditLog.metadataJson}, '$.projectId') end) = ${projectId}`,
  ];
  if (!canOrg(actor, 'tasks.view')) {
    conds.push(
      or(
        isNull(auditLog.entityType),
        ne(auditLog.entityType, 'task'),
        inArray(auditLog.entityId, visibleTaskIdsSq(actor, 'tasks.view')),
      )!,
    );
  }
  const projectTime = check(actor, 'time_logs.view', {
    agencyId: actor.agencyId,
    projectMember: facts.projectMember,
  });
  if (!projectTime) {
    const uid = actorUserId(actor);
    conds.push(
      or(
        isNull(auditLog.entityType),
        notInArray(auditLog.entityType, ['timer', 'time_log']),
        ...(uid && check(actor, 'time_logs.view', { agencyId: actor.agencyId, ownerIds: [uid] })
          ? [eq(auditLog.actorId, uid)]
          : []),
      )!,
    );
  }

  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorId: auditLog.actorId,
      actorName: users.fullName,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      metadataJson: auditLog.metadataJson,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(...conds))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);

  return (rows as ActivityRow[]).map(serializeActivity);
}

// GET /projects/:id/activity?limit=50 — projects.view (entries filtered, above)
const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

projectsRouter.get('/:id/activity', requires('projects.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const facts = await authorizeProject(actor, projectId, 'projects.view');
  const q = activityQuery.parse(req.query);
  ok(res, await fetchProjectActivity(actor, facts, q.limit ?? 50));
});

// ============================================================
//  OVERVIEW (boss dashboard tab)
// ============================================================

// GET /projects/:id/overview — projects.view. Task counts respect the
// tasks.view scope, logged time the time_logs.view scope, timers timers.view.
projectsRouter.get('/:id/overview', requires('projects.view'), async (req, res) => {
  const actor = getActor(req);
  const projectId = param(req, 'id');
  const facts = await authorizeProject(actor, projectId, 'projects.view');

  // Tasks grouped by status.
  const taskStatusRows = await db
    .select({
      status: projectTasks.status,
      count: sql<number>`count(*)`,
    })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, actor.agencyId),
        eq(projectTasks.projectId, projectId),
        taskScopeFilter(actor, 'tasks.view'),
      ),
    )
    .groupBy(projectTasks.status);

  const tasksByStatus = {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
  };
  for (const r of taskStatusRows) {
    if (r.status in tasksByStatus) {
      tasksByStatus[r.status as keyof typeof tasksByStatus] = Number(
        r.count ?? 0,
      );
    }
  }
  const taskTotal =
    tasksByStatus.backlog +
    tasksByStatus.todo +
    tasksByStatus.in_progress +
    tasksByStatus.in_review +
    tasksByStatus.done;
  const taskDone = tasksByStatus.done;

  // Milestones.
  const [{ milestoneTotal, milestoneDone } = { milestoneTotal: 0, milestoneDone: 0 }] =
    await db
      .select({
        milestoneTotal: sql<number>`count(*)`,
        milestoneDone: sql<number>`coalesce(sum(case when ${projectMilestones.status} = 'completed' then 1 else 0 end), 0)`,
      })
      .from(projectMilestones)
      .where(
        and(
          eq(projectMilestones.agencyId, actor.agencyId),
          eq(projectMilestones.projectId, projectId),
        ),
      );

  // Members.
  const [{ memberCount } = { memberCount: 0 }] = await db
    .select({ memberCount: sql<number>`count(*)` })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.agencyId, actor.agencyId),
        eq(projectMembers.projectId, projectId),
      ),
    );

  // Logged time (within the actor's time_logs.view scope).
  const [{ totalTimeMinutes } = { totalTimeMinutes: 0 }] = await db
    .select({
      totalTimeMinutes: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
    })
    .from(timeLogs)
    .where(
      and(
        eq(timeLogs.agencyId, actor.agencyId),
        eq(timeLogs.projectId, projectId),
        timeLogScopeFilter(actor, 'time_logs.view'),
      ),
    );

  const activeTimers = await listProjectTimers(actor, projectId);
  const recentActivity = await fetchProjectActivity(actor, facts, 6);

  ok(res, {
    tasksByStatus,
    taskTotal,
    taskDone,
    milestoneTotal: Number(milestoneTotal ?? 0),
    milestoneDone: Number(milestoneDone ?? 0),
    memberCount: Number(memberCount ?? 0),
    totalTimeMinutes: Number(totalTimeMinutes ?? 0),
    activeTimerCount: activeTimers.length,
    recentActivity,
  });
});
