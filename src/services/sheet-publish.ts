import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  sheets,
  contentPosts,
  projectTasks,
  taskAssignees,
  projects,
  clients,
  users,
  calendarReservations,
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
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s;
  const d = new Date(iso);
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
  skipped: number;
  errors: string[];
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
    publishedRows?: number[];
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
  if (!sheet.projectId) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Link this calendar to a project before publishing (tasks are created there).',
    );
  }

  // Verify client + project belong to the agency.
  const [client] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.id, sheet.clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, sheet.projectId), eq(projects.agencyId, ctx.agencyId)))
    .limit(1);
  if (!client || !project) {
    throw new AppError('VALIDATION_ERROR', 'The linked client or project no longer exists.');
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

  const published = new Set(data.publishedRows ?? []);
  const result: PublishResult = { postsCreated: 0, tasksCreated: 0, skipped: 0, errors: [] };
  const totalRows = data.rows ?? 60;

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
    if (published.has(row)) continue;
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
    let assignee = String(val(row, assigneeCol) ?? '').trim();
    if (!assignee || !agencyUsers.has(assignee)) assignee = ctx.userId;

    try {
      // 1) content post (client portal calendar)
      const postId = newId('post');
      await db.insert(contentPosts).values({
        id: postId,
        agencyId: ctx.agencyId,
        clientId: sheet.clientId,
        postType: postType as (typeof POST_TYPES)[number],
        caption,
        platformsJson: JSON.stringify(platform ? [platform] : []),
        scheduledAt: date,
        status: 'scheduled',
        createdBy: ctx.userId,
      });

      // 2) task to produce it, linked to the post
      const taskId = newId('tas');
      await db.insert(projectTasks).values({
        id: taskId,
        agencyId: ctx.agencyId,
        projectId: sheet.projectId,
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

      // 3) notify the assignee
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
      published.add(row);
    } catch (e) {
      result.errors.push(
        `Row ${row + 1}: ${e instanceof Error ? e.message : 'failed'}`,
      );
    }
  }

  // Persist publish state back onto the sheet.
  const nextData = { ...data, publishedRows: [...published], publishedAt: new Date().toISOString() };
  await db
    .update(sheets)
    .set({ data: JSON.stringify(nextData), updatedAt: new Date() })
    .where(eq(sheets.id, sheetId));

  return result;
}
