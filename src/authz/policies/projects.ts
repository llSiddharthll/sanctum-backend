/**
 * Projects / tasks / time policy (design §E.1, §G.2).
 *
 * Relations:
 *   projects        assigned = project member; own = creator; client = brand (+ allowed projects)
 *   tasks           own = createdBy; assigned = primary assignee or task_assignees row;
 *                   project = member of the task's project
 *   task comments   own = author (task visibility is checked separately on the task)
 *   time logs       own = userId; project = member of the log's project
 *   timers          own = userId; project = member of the timer's project
 *
 * Facts loaders always filter by actor.agencyId and bind children to the URL
 * parent (task ↔ project, comment ↔ task). SQL scope filters mirror the same
 * relations for list queries.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  projectMembers,
  projectMilestones,
  projectTaskComments,
  projectTaskLabels,
  projectTasks,
  projects,
  taskAssignees,
  timeLogs,
  timers,
} from '../../db/schema.js';
import { AppError, notFound } from '../../lib/errors.js';
import { actorUserId, isClientSide, type Actor } from '../actor.js';
import type { ObjectFacts } from '../engine.js';

const FALSE = sql`0`;
const TRUE = sql`1`;

// ---------------------------------------------------------------- membership

/** Project ids the actor is a member of (staff only). */
export async function memberProjectIds(actor: Actor): Promise<Set<string>> {
  const uid = actorUserId(actor);
  if (!uid || isClientSide(actor)) return new Set();
  const rows = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.agencyId, actor.agencyId), eq(projectMembers.userId, uid)));
  return new Set(rows.map((r) => r.projectId));
}

export async function isProjectMember(actor: Actor, projectId: string | null | undefined): Promise<boolean> {
  const uid = actorUserId(actor);
  if (!uid || !projectId || isClientSide(actor)) return false;
  const [m] = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.agencyId, actor.agencyId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, uid),
      ),
    )
    .limit(1);
  return !!m;
}

/** Sub-select of the actor's member project ids (for SQL filters). */
function memberProjectsSq(actor: Actor, uid: string) {
  return db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.agencyId, actor.agencyId), eq(projectMembers.userId, uid)));
}

/** Sub-select of task ids the actor is in task_assignees for. */
function assignedTasksSq(actor: Actor, uid: string) {
  return db
    .select({ id: taskAssignees.taskId })
    .from(taskAssignees)
    .where(and(eq(taskAssignees.agencyId, actor.agencyId), eq(taskAssignees.userId, uid)));
}

// ---------------------------------------------------------------- projects

export interface ProjectFacts extends ObjectFacts {
  projectId: string;
  clientId: string;
}

type ProjectFactRow = { id: string; clientId: string; createdBy: string | null };

/** Facts for a project row given the actor's member-project set (lists). */
export function projectFactsFromRow(
  actor: Actor,
  row: ProjectFactRow,
  members: Set<string>,
): ProjectFacts {
  const member = members.has(row.id);
  return {
    agencyId: actor.agencyId,
    ownerIds: [row.createdBy],
    assigned: member,
    projectMember: member,
    clientId: row.clientId,
    projectId: row.id,
  };
}

/** Facts for one project, or null when it is not in the actor's agency. */
export async function projectFacts(actor: Actor, projectId: string): Promise<ProjectFacts | null> {
  const [p] = await db
    .select({ id: projects.id, clientId: projects.clientId, createdBy: projects.createdBy })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.agencyId, actor.agencyId)))
    .limit(1);
  if (!p) return null;
  const member = await isProjectMember(actor, p.id);
  return {
    agencyId: actor.agencyId,
    ownerIds: [p.createdBy],
    assigned: member,
    projectMember: member,
    clientId: p.clientId,
    projectId: p.id,
  };
}

/**
 * SQL predicate over `projects` rows the actor may access for `permission`
 * (tenant predicate NOT included — callers add `projects.agencyId`).
 */
export function projectScopeFilter(actor: Actor, permission: string): SQL {
  const scopes = actor.grants.scopes(permission);
  if (isClientSide(actor)) {
    if (!scopes.includes('client')) return FALSE;
    const parts: SQL[] = [eq(projects.clientId, actor.clientId)];
    if (actor.projectAccess.mode === 'selected') {
      parts.push(
        actor.projectAccess.projectIds.length
          ? inArray(projects.id, actor.projectAccess.projectIds)
          : FALSE,
      );
    }
    return and(...parts)!;
  }
  if (scopes.includes('organization')) return TRUE;
  const uid = actorUserId(actor);
  if (!uid) return FALSE;
  const parts: SQL[] = [];
  if (scopes.includes('own')) parts.push(eq(projects.createdBy, uid));
  if (scopes.includes('assigned') || scopes.includes('project')) {
    parts.push(inArray(projects.id, memberProjectsSq(actor, uid)));
  }
  return parts.length ? or(...parts)! : FALSE;
}

// ---------------------------------------------------------------- tasks

export type TaskRow = typeof projectTasks.$inferSelect;

export interface TaskFacts extends ObjectFacts {
  projectId: string;
  task: TaskRow;
}

/** Facts for a task row given pre-loaded assignment + membership (lists). */
export function taskFactsFromRow(
  actor: Actor,
  row: Pick<TaskRow, 'id' | 'projectId' | 'createdBy' | 'assigneeId'>,
  assignedTaskIds: Set<string>,
  members: Set<string>,
): ObjectFacts {
  const uid = actorUserId(actor);
  return {
    agencyId: actor.agencyId,
    ownerIds: [row.createdBy],
    assigned: !!uid && !isClientSide(actor) && (row.assigneeId === uid || assignedTaskIds.has(row.id)),
    projectMember: members.has(row.projectId),
  };
}

/** Task ids (among `taskIds`) the actor is in task_assignees for. */
export async function assignedTaskIdSet(actor: Actor, taskIds: string[]): Promise<Set<string>> {
  const uid = actorUserId(actor);
  if (!uid || !taskIds.length || isClientSide(actor)) return new Set();
  const rows = await db
    .select({ id: taskAssignees.taskId })
    .from(taskAssignees)
    .where(
      and(
        eq(taskAssignees.agencyId, actor.agencyId),
        eq(taskAssignees.userId, uid),
        inArray(taskAssignees.taskId, taskIds),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * Facts for one task, or null when it is not in the actor's agency (or not in
 * `opts.projectId` when the URL binds it to a project).
 */
export async function taskFacts(
  actor: Actor,
  taskId: string,
  opts: { projectId?: string } = {},
): Promise<TaskFacts | null> {
  const [t] = await db
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.id, taskId),
        eq(projectTasks.agencyId, actor.agencyId),
        ...(opts.projectId ? [eq(projectTasks.projectId, opts.projectId)] : []),
      ),
    )
    .limit(1);
  if (!t) return null;
  const uid = actorUserId(actor);
  let assigned = false;
  if (uid && !isClientSide(actor)) {
    if (t.assigneeId === uid) assigned = true;
    else {
      const [a] = await db
        .select({ id: taskAssignees.id })
        .from(taskAssignees)
        .where(
          and(
            eq(taskAssignees.agencyId, actor.agencyId),
            eq(taskAssignees.taskId, t.id),
            eq(taskAssignees.userId, uid),
          ),
        )
        .limit(1);
      assigned = !!a;
    }
  }
  return {
    agencyId: actor.agencyId,
    ownerIds: [t.createdBy],
    assigned,
    projectMember: await isProjectMember(actor, t.projectId),
    projectId: t.projectId,
    task: t,
  };
}

/** SQL predicate over `project_tasks` rows (tenant predicate NOT included). */
export function taskScopeFilter(actor: Actor, permission: string): SQL {
  if (isClientSide(actor)) return FALSE;
  const scopes = actor.grants.scopes(permission);
  if (scopes.includes('organization')) return TRUE;
  const uid = actorUserId(actor);
  if (!uid) return FALSE;
  const parts: SQL[] = [];
  if (scopes.includes('own')) parts.push(eq(projectTasks.createdBy, uid));
  if (scopes.includes('assigned')) {
    parts.push(eq(projectTasks.assigneeId, uid));
    parts.push(inArray(projectTasks.id, assignedTasksSq(actor, uid)));
  }
  if (scopes.includes('project')) {
    parts.push(inArray(projectTasks.projectId, memberProjectsSq(actor, uid)));
  }
  return parts.length ? or(...parts)! : FALSE;
}

/** Sub-select of task ids the actor may access for `permission` (tenant-bound). */
export function visibleTaskIdsSq(actor: Actor, permission: string) {
  return db
    .select({ id: projectTasks.id })
    .from(projectTasks)
    .where(and(eq(projectTasks.agencyId, actor.agencyId), taskScopeFilter(actor, permission)));
}

// ---------------------------------------------------------------- comments

export interface CommentFacts extends ObjectFacts {
  comment: typeof projectTaskComments.$inferSelect;
}

/** Facts for a (non-deleted) comment bound to `taskId`, or null. */
export async function commentFacts(
  actor: Actor,
  commentId: string,
  taskId: string,
): Promise<CommentFacts | null> {
  const [c] = await db
    .select()
    .from(projectTaskComments)
    .where(
      and(
        eq(projectTaskComments.id, commentId),
        eq(projectTaskComments.agencyId, actor.agencyId),
        eq(projectTaskComments.taskId, taskId),
        isNull(projectTaskComments.deletedAt),
      ),
    )
    .limit(1);
  if (!c) return null;
  return { agencyId: actor.agencyId, ownerIds: [c.authorId], comment: c };
}

// ---------------------------------------------------------------- time logs & timers

export interface TimeLogFacts extends ObjectFacts {
  log: typeof timeLogs.$inferSelect;
}

export async function timeLogFacts(actor: Actor, logId: string): Promise<TimeLogFacts | null> {
  const [l] = await db
    .select()
    .from(timeLogs)
    .where(and(eq(timeLogs.id, logId), eq(timeLogs.agencyId, actor.agencyId)))
    .limit(1);
  if (!l) return null;
  return {
    agencyId: actor.agencyId,
    ownerIds: [l.userId],
    projectMember: await isProjectMember(actor, l.projectId),
    log: l,
  };
}

/** SQL predicate over `time_logs` rows (tenant predicate NOT included). */
export function timeLogScopeFilter(actor: Actor, permission: string): SQL {
  if (isClientSide(actor)) return FALSE;
  const scopes = actor.grants.scopes(permission);
  if (scopes.includes('organization')) return TRUE;
  const uid = actorUserId(actor);
  if (!uid) return FALSE;
  const parts: SQL[] = [];
  if (scopes.includes('own')) parts.push(eq(timeLogs.userId, uid));
  if (scopes.includes('project')) {
    parts.push(inArray(timeLogs.projectId, memberProjectsSq(actor, uid)));
  }
  return parts.length ? or(...parts)! : FALSE;
}

/**
 * SQL predicate over running `timers` the actor may see: their own timer
 * always (timers.use is own-only self-service), others via `timers.view`.
 */
export function timerScopeFilter(actor: Actor): SQL {
  if (isClientSide(actor)) return FALSE;
  const uid = actorUserId(actor);
  const scopes = actor.grants.scopes('timers.view');
  if (scopes.includes('organization')) return TRUE;
  const parts: SQL[] = [];
  if (uid) parts.push(eq(timers.userId, uid));
  if (uid && scopes.includes('project')) {
    parts.push(inArray(timers.projectId, memberProjectsSq(actor, uid)));
  }
  return parts.length ? or(...parts)! : FALSE;
}

// ---------------------------------------------------------------- input references

/** Milestone must exist in the same project + agency (404 otherwise). */
export async function requireMilestoneInProject(
  agencyId: string,
  projectId: string,
  milestoneId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: projectMilestones.id })
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
}

/** Task must exist in the same project + agency (404 otherwise). Returns the row. */
export async function requireTaskInProject(
  agencyId: string,
  projectId: string,
  taskId: string,
): Promise<TaskRow> {
  const [row] = await db
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.id, taskId),
        eq(projectTasks.agencyId, agencyId),
        eq(projectTasks.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Task not found.');
  return row;
}

/** Every label id must belong to the project (422 otherwise). */
export async function requireLabelsInProject(
  agencyId: string,
  projectId: string,
  labelIds: string[],
): Promise<void> {
  const ids = [...new Set(labelIds)];
  if (!ids.length) return;
  const valid = await db
    .select({ id: projectTaskLabels.id })
    .from(projectTaskLabels)
    .where(
      and(
        eq(projectTaskLabels.agencyId, agencyId),
        eq(projectTaskLabels.projectId, projectId),
        inArray(projectTaskLabels.id, ids),
      ),
    );
  if (valid.length !== ids.length) {
    throw new AppError('VALIDATION_ERROR', 'One or more labels do not belong to this project.');
  }
}
