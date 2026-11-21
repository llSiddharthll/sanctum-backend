/**
 * "My to-dos" — a private checklist per team member, for work that isn't a
 * client/project task. Self-service: every query is bound to the caller's own
 * user id and agency, so nobody else (including admins) can read or change it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { personalTodos } from '../db/schema.js';
import { authenticate, getStaffActor } from '../authz/http.js';
import { ok, created } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';

export const todosRouter = Router();
todosRouter.use(authenticate);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Row = typeof personalTodos.$inferSelect;
const serialize = (t: Row) => ({
  id: t.id,
  title: t.title,
  notes: t.notes,
  dueDay: t.dueDay,
  done: t.done,
  doneAt: t.doneAt ? t.doneAt.toISOString() : null,
  createdAt: t.createdAt.toISOString(),
});

// Self-service: the caller's own to-dos (open first, then the last 50 done).
todosRouter.get('/', async (req, res) => {
  const actor = getStaffActor(req);
  const mine = and(eq(personalTodos.agencyId, actor.agencyId), eq(personalTodos.userId, actor.userId));
  const open = await db
    .select()
    .from(personalTodos)
    .where(and(mine, eq(personalTodos.done, false)))
    .orderBy(asc(personalTodos.sortOrder), asc(personalTodos.createdAt));
  const done = await db
    .select()
    .from(personalTodos)
    .where(and(mine, eq(personalTodos.done, true)))
    .orderBy(desc(personalTodos.doneAt))
    .limit(50);
  ok(res, [...open, ...done].map(serialize));
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(2000).optional(),
  dueDay: z.string().regex(DAY).nullable().optional(),
});

// Self-service: add to the caller's own list.
todosRouter.post('/', async (req, res) => {
  const actor = getStaffActor(req);
  const body = createSchema.parse(req.body);
  const id = newId('tdo');
  const now = new Date();
  await db.insert(personalTodos).values({
    id,
    agencyId: actor.agencyId,
    userId: actor.userId,
    title: body.title,
    notes: body.notes || null,
    dueDay: body.dueDay ?? null,
    done: false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(personalTodos).where(eq(personalTodos.id, id)).limit(1);
  created(res, serialize(row!));
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  dueDay: z.string().regex(DAY).nullable().optional(),
  done: z.boolean().optional(),
});

async function loadOwn(agencyId: string, userId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(personalTodos)
    .where(and(eq(personalTodos.id, id), eq(personalTodos.agencyId, agencyId), eq(personalTodos.userId, userId)))
    .limit(1);
  if (!row) throw notFound('To-do not found.');
  return row;
}

// Self-service: edit / tick off one of the caller's own to-dos.
todosRouter.patch('/:id', async (req, res) => {
  const actor = getStaffActor(req);
  const body = patchSchema.parse(req.body);
  const row = await loadOwn(actor.agencyId, actor.userId, String(req.params.id));
  await db
    .update(personalTodos)
    .set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
      ...(body.dueDay !== undefined ? { dueDay: body.dueDay } : {}),
      ...(body.done !== undefined ? { done: body.done, doneAt: body.done ? new Date() : null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(personalTodos.id, row.id));
  ok(res, serialize(await loadOwn(actor.agencyId, actor.userId, row.id)));
});

// Self-service: delete one of the caller's own to-dos.
todosRouter.delete('/:id', async (req, res) => {
  const actor = getStaffActor(req);
  const row = await loadOwn(actor.agencyId, actor.userId, String(req.params.id));
  await db.delete(personalTodos).where(eq(personalTodos.id, row.id));
  ok(res, { deleted: true });
});
