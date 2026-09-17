import { and, eq, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contentPosts, projectTasks } from '../db/schema.js';

export interface SweepResult {
  tasks: number;
  posts: number;
}

/** First day (00:00 UTC) of the current calendar month. */
function firstOfCurrentMonthUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Sweep every INCOMPLETE item whose month has fully ended into the month-wise
 * archive:
 *   - project tasks with a due date before the current month and status != 'done'
 *   - content posts with a scheduled date before the current month and status != 'posted'
 *
 * `archivedMonth` ('YYYY-MM') is stamped from the item's own date. Items with no
 * date have no month bucket and are left active. Idempotent — rows already
 * archived (archivedAt set) are skipped, so this is safe to run on every boot
 * and on the monthly cron. Global across agencies unless `agencyId` is given.
 */
export async function sweepEndedMonths(
  now: Date = new Date(),
  agencyId?: string,
  /** Which halves to sweep (callers authorize each: tasks.archive / posts.archive). */
  opts: { tasks?: boolean; posts?: boolean } = {},
): Promise<SweepResult> {
  const cutoff = firstOfCurrentMonthUTC(now);
  const doTasks = opts.tasks ?? true;
  const doPosts = opts.posts ?? true;

  const taskRows = !doTasks ? [] : await db
    .update(projectTasks)
    .set({
      archivedAt: now,
      archivedMonth: sql`strftime('%Y-%m', ${projectTasks.dueDate}, 'unixepoch')`,
      updatedAt: now,
    })
    .where(
      and(
        isNull(projectTasks.archivedAt),
        isNotNull(projectTasks.dueDate),
        lt(projectTasks.dueDate, cutoff),
        ne(projectTasks.status, 'done'),
        ...(agencyId ? [eq(projectTasks.agencyId, agencyId)] : []),
      ),
    )
    .returning({ id: projectTasks.id });

  const postRows = !doPosts ? [] : await db
    .update(contentPosts)
    .set({
      archivedAt: now,
      archivedMonth: sql`strftime('%Y-%m', ${contentPosts.scheduledAt}, 'unixepoch')`,
      updatedAt: now,
    })
    .where(
      and(
        isNull(contentPosts.archivedAt),
        isNotNull(contentPosts.scheduledAt),
        lt(contentPosts.scheduledAt, cutoff),
        ne(contentPosts.status, 'posted'),
        ...(agencyId ? [eq(contentPosts.agencyId, agencyId)] : []),
      ),
    )
    .returning({ id: contentPosts.id });

  return { tasks: taskRows.length, posts: postRows.length };
}

/**
 * Restore an ARCHIVED task to the active board. Returns false when the task is
 * not in the agency or is not archived. Callers authorize `tasks.restore`.
 */
export async function unarchiveTask(
  agencyId: string,
  taskId: string,
): Promise<boolean> {
  const r = await db
    .update(projectTasks)
    .set({ archivedAt: null, archivedMonth: null, updatedAt: new Date() })
    .where(
      and(
        eq(projectTasks.agencyId, agencyId),
        eq(projectTasks.id, taskId),
        isNotNull(projectTasks.archivedAt),
      ),
    )
    .returning({ id: projectTasks.id });
  return r.length > 0;
}

/** Restore an archived content post to the active calendar. */
export async function unarchivePost(
  agencyId: string,
  postId: string,
  clientId: string,
): Promise<boolean> {
  const r = await db
    .update(contentPosts)
    .set({ archivedAt: null, archivedMonth: null, updatedAt: new Date() })
    .where(
      and(
        eq(contentPosts.agencyId, agencyId),
        eq(contentPosts.id, postId),
        eq(contentPosts.clientId, clientId),
        isNotNull(contentPosts.archivedAt),
      ),
    )
    .returning({ id: contentPosts.id });
  return r.length > 0;
}
