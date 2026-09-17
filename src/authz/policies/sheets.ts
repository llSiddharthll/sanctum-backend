/**
 * Sheets policy. `own` = createdBy; everything else is organization scope.
 * Publishing is cross-module: see services/sheet-publish.ts for the target
 * permissions (projects.create / posts.create / tasks.create / *.update).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { contentPosts, projectMembers, projectTasks, sheets, taskAssignees } from '../../db/schema.js';
import { actorUserId, type Actor } from '../actor.js';
import { check, type ObjectFacts } from '../engine.js';

export type SheetRecord = typeof sheets.$inferSelect;

export const SHEET_CAPABILITIES = ['sheets.update', 'sheets.delete', 'sheets.publish'] as const;

export function sheetFactsFrom(s: Pick<SheetRecord, 'agencyId' | 'createdBy' | 'clientId' | 'projectId'>): ObjectFacts {
  return { agencyId: s.agencyId, ownerIds: [s.createdBy], clientId: s.clientId, projectId: s.projectId };
}

export async function sheetFacts(
  actor: Actor,
  sheetId: string,
): Promise<{ row: SheetRecord; facts: ObjectFacts } | null> {
  const [row] = await db
    .select()
    .from(sheets)
    .where(and(eq(sheets.id, sheetId), eq(sheets.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) return null;
  return { row, facts: sheetFactsFrom(row) };
}

export function sheetCapabilities(actor: Actor, facts: ObjectFacts): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of SHEET_CAPABILITIES) out[p] = check(actor, p, facts);
  return out;
}

// ---- Minimal facts for publish targets (tasks / posts / projects) ----------

/** `project` scope fact: the actor is a member of the project. */
export async function isProjectMember(actor: Actor, projectId: string): Promise<boolean> {
  const uid = actorUserId(actor);
  if (!uid) return false;
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

/** Facts for existing tasks (own = creator, assigned = assignee, project = member). */
export async function taskFactsMany(
  actor: Actor,
  taskIds: string[],
): Promise<Map<string, ObjectFacts>> {
  const out = new Map<string, ObjectFacts>();
  if (!taskIds.length) return out;
  const uid = actorUserId(actor);
  const rows = await db
    .select({
      id: projectTasks.id,
      agencyId: projectTasks.agencyId,
      projectId: projectTasks.projectId,
      createdBy: projectTasks.createdBy,
      assigneeId: projectTasks.assigneeId,
    })
    .from(projectTasks)
    .where(and(eq(projectTasks.agencyId, actor.agencyId), inArray(projectTasks.id, taskIds)));
  const extra = uid
    ? new Set(
        (
          await db
            .select({ taskId: taskAssignees.taskId })
            .from(taskAssignees)
            .where(
              and(
                eq(taskAssignees.agencyId, actor.agencyId),
                eq(taskAssignees.userId, uid),
                inArray(taskAssignees.taskId, taskIds),
              ),
            )
        ).map((r) => r.taskId),
      )
    : new Set<string>();
  const memberOf = new Map<string, boolean>();
  for (const r of rows) {
    if (!memberOf.has(r.projectId)) memberOf.set(r.projectId, await isProjectMember(actor, r.projectId));
    out.set(r.id, {
      agencyId: r.agencyId,
      ownerIds: [r.createdBy],
      assigned: !!uid && (r.assigneeId === uid || extra.has(r.id)),
      projectMember: memberOf.get(r.projectId) === true,
      projectId: r.projectId,
    });
  }
  return out;
}

/** Facts for existing posts (own = creator, assigned = client assignment). */
export async function postFactsMany(
  actor: Actor,
  postIds: string[],
  clientAssigned: (clientId: string) => Promise<boolean>,
): Promise<Map<string, ObjectFacts>> {
  const out = new Map<string, ObjectFacts>();
  if (!postIds.length) return out;
  const rows = await db
    .select({
      id: contentPosts.id,
      agencyId: contentPosts.agencyId,
      clientId: contentPosts.clientId,
      createdBy: contentPosts.createdBy,
    })
    .from(contentPosts)
    .where(and(eq(contentPosts.agencyId, actor.agencyId), inArray(contentPosts.id, postIds)));
  const assignedByClient = new Map<string, boolean>();
  for (const r of rows) {
    if (!assignedByClient.has(r.clientId)) assignedByClient.set(r.clientId, await clientAssigned(r.clientId));
    out.set(r.id, {
      agencyId: r.agencyId,
      ownerIds: [r.createdBy],
      assigned: assignedByClient.get(r.clientId) === true,
      clientId: r.clientId,
    });
  }
  return out;
}
