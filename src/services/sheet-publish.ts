import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  sheets,
  contentPosts,
  projectTasks,
  taskAssignees,
  projects,
  projectMembers,
  clients,
  users,
  calendarReservations,
  sheetPublications,
} from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { AppError, notFound } from '../lib/errors.js';
import { notify } from './notifications.js';

/**
 * Publish a "content calendar" sheet: each row with a date becomes a content
 * post (client portal calendar) + a project task assigned to the picked member
 * (due that date), linked by task.postId. The assignee is notified. Idempotent
 * — already-published rows (tracked in data.publishedRows) are skipped.
 */

type Ctx = { agencyId: string; userId: string };

function colLetter(n: number): string {
  let s = '';
  let x = n + 1;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}
function a1(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}

const POST_TYPES = ['reel', 'story', 'carousel', 'post'] as const;

function parseDate(raw: unknown): Date | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();

  // ISO: YYYY-MM-DD (or YYYY/MM/DD)
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d));
  }

  // Day-first / month-first: DD-MM-YYYY or DD/MM/YYYY (the Indian default the
  // grid shows). `new Date("01-09-2026")` would wrongly read this as MM-DD, so
  // parse it ourselves. Disambiguate the obvious cases, else assume day-first.
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) {
    let day = +m[1];
    let mon = +m[2];
    const year = +m[3];
    if (day <= 12 && mon > 12) {
      // second field can't be a month → it's the day (US MM-DD-YYYY)
      [day, mon] = [mon, day];
    }
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(year, mon - 1, day));
    }
  }

  // Fallback: let the engine try (handles "Sep 1 2026", ISO datetimes, etc.).
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface SheetColumn {
  index: number;
  label: string;
  type: string;
}

export interface PublishResult {
  postsCreated: number;
  tasksCreated: number;
  /** Rows already published whose post/task date/caption were corrected. */
  updated: number;
  skipped: number;
  errors: string[];
}

/** A row that has been published → the post + task it produced. */
interface PublishedRec {
  postId: string;
  taskId: string;
}

export async function publishCalendarSheet(
  ctx: Ctx,
  sheetId: string,
  origin: string,
): Promise<PublishResult> {
  const [sheet] = await db
    .select()
    .from(sheets)
    .where(and(eq(sheets.id, sheetId), eq(sheets.agencyId, ctx.agencyId)))
    .limit(1);
  if (!sheet) throw notFound('Sheet not found.');

  let data: {
    cells?: Record<string, { v?: unknown }>;
    rows?: number;
    columns?: SheetColumn[];
    kind?: string;
    publishedRows?: number[]; // legacy: bare row indices (no post/task ids)
  };
  try {
    data = JSON.parse(sheet.data || '{}');
  } catch {
    data = {};
  }
  if (data.kind !== 'calendar' || !data.columns?.length) {
    throw new AppError('VALIDATION_ERROR', 'This sheet is not a content calendar.');
  }
  if (!sheet.clientId) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Link this calendar to a client before publishing (it creates that client’s posts).',
    );
  }

  // Verify the client belongs to the agency.
  const [client] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.id, sheet.clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);
  if (!client) {
    throw new AppError('VALIDATION_ERROR', 'The linked client no longer exists.');
  }

  // Resolve a project to host the tasks. A project is optional in the picker —
  // many clients don't have one yet — so if none is linked (or the link is
  // stale) we reuse the client's existing project, else auto-create a
  // "Content Calendar" project and link it back to the sheet for next time.
  let projectId = sheet.projectId;
  if (projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.agencyId, ctx.agencyId)))
      .limit(1);
    if (!project) projectId = null; // stale link → re-resolve below
  }
  if (!projectId) {
    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.agencyId, ctx.agencyId), eq(projects.clientId, sheet.clientId)),
      )
      .limit(1);
    if (existing) {
      projectId = existing.id;
    } else {
      projectId = newId('prj');
      await db.insert(projects).values({
        id: projectId,
        agencyId: ctx.agencyId,
        clientId: sheet.clientId,
        name: (sheet.title || '').trim() || 'Content Calendar',
        type: 'retainer',
        status: 'active',
        createdBy: ctx.userId,
      });
      // The publisher owns the auto-created project (so it's visible to them).
      await db
        .insert(projectMembers)
        .values({
          id: newId('prm'),
          agencyId: ctx.agencyId,
          projectId,
          userId: ctx.userId,
          role: 'owner',
        })
        .onConflictDoNothing();
    }
    // Link the resolved project back to the sheet for subsequent publishes.
    await db
      .update(sheets)
      .set({ projectId, updatedAt: new Date() })
      .where(eq(sheets.id, sheetId));
  }

  const cols = data.columns;
  const find = (pred: (c: SheetColumn) => boolean) => cols.find(pred);
  const dateCol = find((c) => c.type === 'date');
  const assigneeCol = find((c) => c.type === 'assignee');
  const captionCol = find((c) => c.type === 'text');
  const typeCol = find((c) => c.type === 'select' && /type/i.test(c.label));
  const platformCol = find((c) => c.type === 'select' && /platform/i.test(c.label));
  if (!dateCol) {
    throw new AppError('VALIDATION_ERROR', 'The calendar has no Date column.');
  }

  const cells = data.cells ?? {};
  const val = (row: number, col?: SheetColumn) =>
    col ? cells[a1(row, col.index)]?.v : undefined;

  const result: PublishResult = {
    postsCreated: 0,
    tasksCreated: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  const totalRows = data.rows ?? 60;

  // Durable per-row publish records (a separate table, NOT sheet.data — which
  // the editor overwrites on autosave). Keyed by row index, so re-publishing an
  // edited row UPDATES its post/task (e.g. a corrected date) instead of
  // skipping or duplicating it.
  const pubRows = await db
    .select({
      id: sheetPublications.id,
      rowIndex: sheetPublications.rowIndex,
      postId: sheetPublications.postId,
      taskId: sheetPublications.taskId,
    })
    .from(sheetPublications)
    .where(
      and(eq(sheetPublications.agencyId, ctx.agencyId), eq(sheetPublications.sheetId, sheetId)),
    );
  const pubByRow = new Map(pubRows.map((p) => [p.rowIndex, p]));

  // One-time migration off the old in-JSON tracking: if nothing is recorded in
  // the table yet but the sheet was published before (legacy publishedRows),
  // adopt the project's sheet-created tasks (they carry a postId) by title so a
  // re-publish reconciles the existing entries instead of duplicating them.
  const legacyRows = new Set<number>(data.publishedRows ?? []);
  const legacyByTitle = new Map<string, PublishedRec[]>();
  if (pubByRow.size === 0 && legacyRows.size) {
    const projTasks = await db
      .select({ id: projectTasks.id, postId: projectTasks.postId, title: projectTasks.title })
      .from(projectTasks)
      .where(
        and(eq(projectTasks.agencyId, ctx.agencyId), eq(projectTasks.projectId, projectId)),
      );
    for (const tk of projTasks) {
      if (!tk.postId) continue;
      const arr = legacyByTitle.get(tk.title) ?? [];
      arr.push({ postId: tk.postId, taskId: tk.id });
      legacyByTitle.set(tk.title, arr);
    }
  }

  // Reserved days (e.g. a shoot) block tasks — skip them.
  const reservedDays = new Set(
    (
      await db
        .select({ date: calendarReservations.date })
        .from(calendarReservations)
        .where(
          and(
            eq(calendarReservations.agencyId, ctx.agencyId),
            eq(calendarReservations.clientId, sheet.clientId),
          ),
        )
    )
      .map((r) => (r.date ? r.date.toISOString().slice(0, 10) : null))
      .filter((d): d is string => !!d),
  );

  // Valid agency users cache for assignee validation.
  const agencyUsers = new Set(
    (
      await db.select({ id: users.id }).from(users).where(eq(users.agencyId, ctx.agencyId))
    ).map((u) => u.id),
  );

  for (let row = 1; row < totalRows; row++) {
    const date = parseDate(val(row, dateCol));
    if (!date) {
      // rows with no date aren't calendar entries — silently skip
      continue;
    }
    if (reservedDays.has(date.toISOString().slice(0, 10))) {
      // reserved day (e.g. a shoot) — no task/post
      result.skipped++;
      continue;
    }
    const caption = String(val(row, captionCol) ?? '').trim() || 'Untitled post';
    const rawType = String(val(row, typeCol) ?? '').trim().toLowerCase();
    const postType = (POST_TYPES as readonly string[]).includes(rawType)
      ? rawType
      : 'post';
    const platform = String(val(row, platformCol) ?? '').trim();
    const platformsJson = JSON.stringify(platform ? [platform] : []);
    let assignee = String(val(row, assigneeCol) ?? '').trim();
    if (!assignee || !agencyUsers.has(assignee)) assignee = ctx.userId;

    // Already published? Via the durable table, or adopted from a legacy row.
    const existing = pubByRow.get(row);
    let rec: PublishedRec | undefined;
    if (existing && existing.postId && existing.taskId) {
      rec = { postId: existing.postId, taskId: existing.taskId };
    } else if (!existing && legacyRows.has(row)) {
      rec = legacyByTitle.get(caption)?.shift();
    }

    try {
      if (rec) {
        // Update the existing post + task to match the (possibly edited) row —
        // this is what corrects a wrong date on re-publish.
        await db
          .update(contentPosts)
          .set({
            postType: postType as (typeof POST_TYPES)[number],
            caption,
            platformsJson,
            scheduledAt: date,
          })
          .where(and(eq(contentPosts.id, rec.postId), eq(contentPosts.agencyId, ctx.agencyId)));
        await db
          .update(projectTasks)
          .set({ title: caption, assigneeId: assignee, dueDate: date })
          .where(and(eq(projectTasks.id, rec.taskId), eq(projectTasks.agencyId, ctx.agencyId)));
        await db
          .insert(taskAssignees)
          .values({ id: newId('tka'), agencyId: ctx.agencyId, taskId: rec.taskId, userId: assignee })
          .onConflictDoNothing();
        // Record it durably (adopts a legacy row into the table on first pass).
        if (!existing) {
          await db
            .insert(sheetPublications)
            .values({
              id: newId('shp'),
              agencyId: ctx.agencyId,
              sheetId,
              rowIndex: row,
              postId: rec.postId,
              taskId: rec.taskId,
            })
            .onConflictDoNothing();
        }
        result.updated++;
        continue;
      }

      // 1) content post (client portal calendar)
      const postId = newId('post');
      await db.insert(contentPosts).values({
        id: postId,
        agencyId: ctx.agencyId,
        clientId: sheet.clientId,
        postType: postType as (typeof POST_TYPES)[number],
        caption,
        platformsJson,
        scheduledAt: date,
        status: 'scheduled',
        createdBy: ctx.userId,
      });

      // 2) task to produce it, linked to the post
      const taskId = newId('tas');
      await db.insert(projectTasks).values({
        id: taskId,
        agencyId: ctx.agencyId,
        projectId,
        title: caption,
        assigneeId: assignee,
        dueDate: date,
        postId,
        priority: 'medium',
      });
      await db
        .insert(taskAssignees)
        .values({ id: newId('tka'), agencyId: ctx.agencyId, taskId, userId: assignee })
        .onConflictDoNothing();
      // 3) record the durable publication link for future re-publishes
      await db
        .insert(sheetPublications)
        .values({
          id: newId('shp'),
          agencyId: ctx.agencyId,
          sheetId,
          rowIndex: row,
          postId,
          taskId,
        })
        .onConflictDoNothing();

      // 4) notify the assignee
      if (assignee !== ctx.userId) {
        await notify({
          agencyId: ctx.agencyId,
          userId: assignee,
          type: 'task.assigned',
          title: `New task: ${caption}`,
          body: `Due ${date.toISOString().slice(0, 10)} · ${client.name}`,
          entityType: 'task',
          entityId: taskId,
          link: `${origin.replace(/\/$/, '')}/tasks`,
        });
      }

      result.postsCreated++;
      result.tasksCreated++;
    } catch (e) {
      result.errors.push(
        `Row ${row + 1}: ${e instanceof Error ? e.message : 'failed'}`,
      );
    }
  }

  // Stamp publish time; drop the legacy in-JSON tracking (state lives in the
  // sheet_publications table now).
  const nextData = {
    ...data,
    publishedRows: undefined,
    publishedAt: new Date().toISOString(),
  };
  await db
    .update(sheets)
    .set({ data: JSON.stringify(nextData), updatedAt: new Date() })
    .where(eq(sheets.id, sheetId));

  return result;
}
