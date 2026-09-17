import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, like, lte, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, expenses, projects, users } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize, capabilities } from '../authz/engine.js';
import { actorAuditId, type Actor } from '../authz/actor.js';
import { requireInAgency } from '../authz/tenancy.js';
import { expenseFactsOf, ownScopeFilter } from '../authz/policies/business.js';

export const expensesRouter = Router();
expensesRouter.use(authenticate);

const EXPENSE_CAPABILITIES = ['expenses.update', 'expenses.delete'];

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

function auditExpense(actor: Actor, action: string, id: string, ip: string | undefined, metadata?: Record<string, unknown>) {
  return audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action,
    entityType: 'expense',
    entityId: id,
    metadata,
    ip,
  });
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

function serializeExpense(actor: Actor, r: ExpenseJoinRow) {
  const e = r.exp;
  return {
    id: e.id,
    category: e.category,
    expenseType: e.expenseType,
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
    capabilities: capabilities(actor, expenseFactsOf(e), EXPENSE_CAPABILITIES),
  };
}

/** Load an expense in the tenant (joined names) or null. */
async function findExpense(actor: Actor, expenseId: string): Promise<ExpenseJoinRow | null> {
  const [row] = await db
    .select(expenseSelection)
    .from(expenses)
    .leftJoin(projects, and(eq(projects.id, expenses.projectId), eq(projects.agencyId, expenses.agencyId)))
    .leftJoin(clients, and(eq(clients.id, expenses.clientId), eq(clients.agencyId, expenses.agencyId)))
    .leftJoin(users, and(eq(users.id, expenses.loggedBy), eq(users.agencyId, expenses.agencyId)))
    .where(and(eq(expenses.id, expenseId), eq(expenses.agencyId, actor.agencyId)))
    .limit(1);
  return (row as ExpenseJoinRow | undefined) ?? null;
}

/** Load + authorize an expense for `permission` (404 when not visible). */
async function authorizedExpense(actor: Actor, expenseId: string, permission: string): Promise<ExpenseJoinRow> {
  const row = await findExpense(actor, expenseId);
  authorize(actor, permission, row ? expenseFactsOf(row.exp) : null, { view: 'expenses.view' });
  return row!;
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

expensesRouter.get('/', requires('expenses.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const q = listQuery.parse(req.query);

  const filters = [
    eq(expenses.agencyId, actor.agencyId),
    ownScopeFilter(actor, 'expenses.view', expenses.loggedBy),
  ];
  if (q.category) filters.push(eq(expenses.category, q.category));
  if (q.projectId) filters.push(eq(expenses.projectId, q.projectId));
  if (q.clientId) filters.push(eq(expenses.clientId, q.clientId));
  if (q.from) filters.push(gte(expenses.expenseDate, q.from));
  if (q.to) {
    // Inclusive: a `to` of 2026-06-30 must cover that whole day, not stop at
    // midnight (which silently dropped everything logged later that day).
    const end = new Date(q.to);
    end.setUTCHours(23, 59, 59, 999);
    filters.push(lte(expenses.expenseDate, end));
  }
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
    .leftJoin(projects, and(eq(projects.id, expenses.projectId), eq(projects.agencyId, expenses.agencyId)))
    .leftJoin(clients, and(eq(clients.id, expenses.clientId), eq(clients.agencyId, expenses.agencyId)))
    .leftJoin(users, and(eq(users.id, expenses.loggedBy), eq(users.agencyId, expenses.agencyId)))
    .where(and(...filters))
    .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt));

  ok(res, (rows as ExpenseJoinRow[]).map((r) => serializeExpense(actor, r)));
});

// ============================================================
//  CREATE
// ============================================================
const EXPENSE_TYPES = ['one_time', 'monthly_recurring'] as const;

// z.coerce.date() maps null -> new Date(null) = the epoch, which silently moves
// an expense to 1970 and out of every current report. Require a real value.
const strictDate = z.union([z.string().min(1), z.number(), z.date()]).pipe(z.coerce.date());

// Optional fields accept an explicit null (= "not set"): the web form sends
// null for a blank description/receipt, and rejecting it 422'd every create
// that left either one empty.
const createSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  expenseType: z.enum(EXPENSE_TYPES).optional(),
  amount: z.number().int().min(0), // paise (required)
  description: z.string().max(2000).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  clientId: z.string().min(1).nullable().optional(),
  expenseDate: strictDate.optional(),
  receiptUrl: z.string().url().max(1000).nullable().optional(),
  gstDeductible: z.boolean().optional(),
  gstAmount: z.number().int().min(0).nullable().optional(), // paise
});

expensesRouter.post('/', requires('expenses.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = createSchema.parse(req.body);

  if (body.projectId) await requireInAgency(projects, actor.agencyId, body.projectId, 'Project');
  if (body.clientId) await requireInAgency(clients, actor.agencyId, body.clientId, 'Client');

  const id = newId('exp');
  await db.insert(expenses).values({
    id,
    agencyId: actor.agencyId,
    ...(body.category !== undefined ? { category: body.category } : {}),
    ...(body.expenseType !== undefined
      ? { expenseType: body.expenseType }
      : {}),
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
    loggedBy: actor.userId,
  });

  await auditExpense(actor, 'expense.create', id, req.ip, { amount: body.amount, category: body.category ?? 'other' });

  const row = await findExpense(actor, id);
  if (!row) throw notFound('Expense not found.');
  created(res, serializeExpense(actor, row));
});

// ============================================================
//  DETAIL
// ============================================================
expensesRouter.get('/:id', requires('expenses.view'), async (req, res) => {
  const actor = getStaffActor(req);
  ok(res, serializeExpense(actor, await authorizedExpense(actor, param(req, 'id'), 'expenses.view')));
});

// ============================================================
//  UPDATE
// ============================================================
const updateSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  expenseType: z.enum(EXPENSE_TYPES).optional(),
  amount: z.number().int().min(0).optional(),
  description: z.string().max(2000).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  clientId: z.string().min(1).nullable().optional(),
  // NOT nullable: a null expenseDate drops the row out of every date-ranged
  // finance report while the expense still exists.
  expenseDate: strictDate.optional(),
  receiptUrl: z.string().url().max(1000).nullable().optional(),
  gstDeductible: z.boolean().optional(),
  gstAmount: z.number().int().min(0).nullable().optional(),
});

expensesRouter.patch('/:id', requires('expenses.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const expenseId = param(req, 'id');
  const before = await authorizedExpense(actor, expenseId, 'expenses.update');
  const body = updateSchema.parse(req.body);

  if (body.projectId) await requireInAgency(projects, actor.agencyId, body.projectId, 'Project');
  if (body.clientId) await requireInAgency(clients, actor.agencyId, body.clientId, 'Client');

  const patch: Partial<typeof expenses.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.category !== undefined) patch.category = body.category;
  if (body.expenseType !== undefined) patch.expenseType = body.expenseType;
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
      and(eq(expenses.id, expenseId), eq(expenses.agencyId, actor.agencyId)),
    );

  await auditExpense(actor, 'expense.update', expenseId, req.ip, {
    fields: Object.keys(patch).filter((k) => k !== 'updatedAt'),
    ...(patch.amount !== undefined ? { amountBefore: before.exp.amount, amountAfter: patch.amount } : {}),
  });

  const row = await findExpense(actor, expenseId);
  ok(res, serializeExpense(actor, row!));
});

// ============================================================
//  DELETE
// ============================================================
expensesRouter.delete('/:id', requires('expenses.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const expenseId = param(req, 'id');
  const before = await authorizedExpense(actor, expenseId, 'expenses.delete');

  await db
    .delete(expenses)
    .where(
      and(eq(expenses.id, expenseId), eq(expenses.agencyId, actor.agencyId)),
    );

  await auditExpense(actor, 'expense.delete', expenseId, req.ip, {
    amount: before.exp.amount,
    category: before.exp.category,
    loggedBy: before.exp.loggedBy,
  });
  ok(res, { deleted: true });
});
