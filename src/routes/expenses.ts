import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, like, lte, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, expenses, projects, users } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';

export const expensesRouter = Router();
expensesRouter.use(requireAuth);
expensesRouter.use(requireModuleRW('finance'));

const EXPENSE_CATEGORIES = [
  'software',
  'salaries',
  'marketing',
  'travel',
  'office',
  'equipment',
  'contractor',
  'taxes',
  'utilities',
  'other',
] as const;

type AuthCtx = ReturnType<typeof getAuth>;

async function requireAgencyClient(ctx: AuthCtx, clientId: string) {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);
  if (!row) throw notFound('Client not found.');
}

async function requireAgencyProject(ctx: AuthCtx, projectId: string) {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.agencyId, ctx.agencyId)),
    )
    .limit(1);
  if (!row) throw notFound('Project not found.');
}

// ---- Selection joining names for list/detail responses ----
const expenseSelection = {
  exp: expenses,
  projectName: projects.name,
  clientName: clients.name,
  loggedByName: users.fullName,
};

type ExpenseJoinRow = {
  exp: typeof expenses.$inferSelect;
  projectName: string | null;
  clientName: string | null;
  loggedByName: string | null;
};

function serializeExpense(r: ExpenseJoinRow) {
  const e = r.exp;
  return {
    id: e.id,
    category: e.category,
    amount: e.amount, // paise
    description: e.description,
    projectId: e.projectId,
    projectName: r.projectName,
    clientId: e.clientId,
    clientName: r.clientName,
    expenseDate: toIso(e.expenseDate),
    receiptUrl: e.receiptUrl,
    gstDeductible: e.gstDeductible,
    gstAmount: e.gstAmount, // paise or null
    loggedBy: e.loggedBy,
    loggedByName: r.loggedByName,
    createdAt: toIso(e.createdAt),
    updatedAt: toIso(e.updatedAt),
  };
}

async function getScopedExpense(
  ctx: AuthCtx,
  expenseId: string,
): Promise<ExpenseJoinRow> {
  const [row] = await db
    .select(expenseSelection)
    .from(expenses)
    .leftJoin(projects, eq(projects.id, expenses.projectId))
    .leftJoin(clients, eq(clients.id, expenses.clientId))
    .leftJoin(users, eq(users.id, expenses.loggedBy))
    .where(
      and(eq(expenses.id, expenseId), eq(expenses.agencyId, ctx.agencyId)),
    )
    .limit(1);
  if (!row) throw notFound('Expense not found.');
  return row as ExpenseJoinRow;
}

// ============================================================
//  LIST
// ============================================================
const listQuery = z.object({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  projectId: z.string().optional(),
  clientId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().optional(),
});

expensesRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const q = listQuery.parse(req.query);

  const filters = [eq(expenses.agencyId, ctx.agencyId)];
  if (q.category) filters.push(eq(expenses.category, q.category));
  if (q.projectId) filters.push(eq(expenses.projectId, q.projectId));
  if (q.clientId) filters.push(eq(expenses.clientId, q.clientId));
  if (q.from) filters.push(gte(expenses.expenseDate, q.from));
  if (q.to) filters.push(lte(expenses.expenseDate, q.to));
  if (q.search && q.search.trim()) {
    const term = `%${q.search.trim()}%`;
    const cond = or(
      like(expenses.description, term),
      like(expenses.category, term),
    );
    if (cond) filters.push(cond);
  }

  const rows = await db
    .select(expenseSelection)
    .from(expenses)
    .leftJoin(projects, eq(projects.id, expenses.projectId))
    .leftJoin(clients, eq(clients.id, expenses.clientId))
    .leftJoin(users, eq(users.id, expenses.loggedBy))
    .where(and(...filters))
    .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt));

  ok(res, (rows as ExpenseJoinRow[]).map(serializeExpense));
});

// ============================================================
//  CREATE
// ============================================================
const createSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  amount: z.number().int().min(0), // paise (required)
  description: z.string().max(2000).optional(),
  projectId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  expenseDate: z.coerce.date().optional(),
  receiptUrl: z.string().url().max(1000).optional(),
  gstDeductible: z.boolean().optional(),
  gstAmount: z.number().int().min(0).optional(), // paise
});

expensesRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = createSchema.parse(req.body);

  if (body.projectId) await requireAgencyProject(ctx, body.projectId);
  if (body.clientId) await requireAgencyClient(ctx, body.clientId);

  const id = newId('exp');
  await db.insert(expenses).values({
    id,
    agencyId: ctx.agencyId,
    ...(body.category !== undefined ? { category: body.category } : {}),
    amount: body.amount,
    description: body.description ?? null,
    projectId: body.projectId ?? null,
    clientId: body.clientId ?? null,
    expenseDate: body.expenseDate ?? new Date(),
    receiptUrl: body.receiptUrl ?? null,
    ...(body.gstDeductible !== undefined
      ? { gstDeductible: body.gstDeductible }
      : {}),
    gstAmount: body.gstAmount ?? null,
    loggedBy: ctx.userId,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'expense.create',
    entityType: 'expense',
    entityId: id,
    ip: req.ip,
  });

  created(res, serializeExpense(await getScopedExpense(ctx, id)));
});

// ============================================================
//  DETAIL
// ============================================================
expensesRouter.get('/:id', async (req, res) => {
  const ctx = getAuth(req);
  ok(res, serializeExpense(await getScopedExpense(ctx, param(req, 'id'))));
});

// ============================================================
//  UPDATE
// ============================================================
const updateSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  amount: z.number().int().min(0).optional(),
  description: z.string().max(2000).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  clientId: z.string().min(1).nullable().optional(),
  expenseDate: z.coerce.date().nullable().optional(),
  receiptUrl: z.string().url().max(1000).nullable().optional(),
  gstDeductible: z.boolean().optional(),
  gstAmount: z.number().int().min(0).nullable().optional(),
});

expensesRouter.patch('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const expenseId = param(req, 'id');
  await getScopedExpense(ctx, expenseId);
  const body = updateSchema.parse(req.body);

  if (body.projectId) await requireAgencyProject(ctx, body.projectId);
  if (body.clientId) await requireAgencyClient(ctx, body.clientId);

  const patch: Partial<typeof expenses.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.category !== undefined) patch.category = body.category;
  if (body.amount !== undefined) patch.amount = body.amount;
  if (body.description !== undefined) patch.description = body.description;
  if (body.projectId !== undefined) patch.projectId = body.projectId;
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.expenseDate !== undefined) patch.expenseDate = body.expenseDate;
  if (body.receiptUrl !== undefined) patch.receiptUrl = body.receiptUrl;
  if (body.gstDeductible !== undefined)
    patch.gstDeductible = body.gstDeductible;
  if (body.gstAmount !== undefined) patch.gstAmount = body.gstAmount;

  await db
    .update(expenses)
    .set(patch)
    .where(
      and(eq(expenses.id, expenseId), eq(expenses.agencyId, ctx.agencyId)),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'expense.update',
    entityType: 'expense',
    entityId: expenseId,
    ip: req.ip,
  });

  ok(res, serializeExpense(await getScopedExpense(ctx, expenseId)));
});

// ============================================================
//  DELETE
// ============================================================
expensesRouter.delete('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const expenseId = param(req, 'id');
  await getScopedExpense(ctx, expenseId);

  await db
    .delete(expenses)
    .where(
      and(eq(expenses.id, expenseId), eq(expenses.agencyId, ctx.agencyId)),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'expense.delete',
    entityType: 'expense',
    entityId: expenseId,
    ip: req.ip,
  });
  ok(res, { deleted: true });
});
