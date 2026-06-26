import { Router } from 'express';
import { z } from 'zod';
import { and, count, desc, eq, gte, inArray, lte, sql, sum } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  expenses,
  invoicePayments,
  invoices,
} from '../db/schema.js';
import { ok } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';

export const financeRouter = Router();
financeRouter.use(requireAuth);
financeRouter.use(requireModuleRW('finance'));

type AuthCtx = ReturnType<typeof getAuth>;

/** Invoice statuses that count as 'issued' (a real receivable). */
const ISSUED_STATUSES = ['sent', 'partially_paid', 'paid'] as const;
/** Issued-but-unpaid (still owes money). */
const OPEN_STATUSES = ['sent', 'partially_paid'] as const;

/**
 * GET /finance/overview?from&to
 * All money values are INTEGER PAISE. Range defaults to the current Indian
 * financial year (Apr 1 -> Mar 31) when from/to are omitted.
 */
const overviewQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Current Indian FY window [Apr 1, next Apr 1). */
function currentFinancialYear(nowMs = Date.now()): { from: Date; to: Date } {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  // FY starts in April; before April we're still in the prior FY.
  const startYear = d.getUTCMonth() >= 3 ? y : y - 1;
  return {
    from: new Date(Date.UTC(startYear, 3, 1)),
    to: new Date(Date.UTC(startYear + 1, 3, 1)),
  };
}

financeRouter.get('/overview', async (req, res) => {
  const ctx = getAuth(req);
  const q = overviewQuery.parse(req.query);
  const fy = currentFinancialYear();
  const from = q.from ?? fy.from;
  const to = q.to ?? fy.to;
  const now = new Date();

  const agency = eq(invoices.agencyId, ctx.agencyId);

  // ---- totalRevenue: Σ total of non-draft, non-cancelled invoices whose
  // issueDate is in range. ----
  const [revRow] = await db
    .select({ v: sum(invoices.total) })
    .from(invoices)
    .where(
      and(
        agency,
        inArray(invoices.status, [...ISSUED_STATUSES]),
        gte(invoices.issueDate, from),
        lte(invoices.issueDate, to),
      ),
    );
  const totalRevenue = Number(revRow?.v ?? 0);

  // ---- collected: Σ payments whose paidAt is in range. ----
  const [collRow] = await db
    .select({ v: sum(invoicePayments.amount) })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.agencyId, ctx.agencyId),
        gte(invoicePayments.paidAt, from),
        lte(invoicePayments.paidAt, to),
      ),
    );
  const collected = Number(collRow?.v ?? 0);

  // ---- outstanding: Σ amountDue (= total - paid) of all open invoices
  // (issued & not fully paid), all-time. ----
  const paidPerInvoiceSq = sql<number>`(
    select coalesce(sum(${invoicePayments.amount}), 0) from ${invoicePayments}
    where ${invoicePayments.invoiceId} = ${invoices.id}
  )`;
  const [outRow] = await db
    .select({
      v: sql<number>`coalesce(sum(${invoices.total} - ${paidPerInvoiceSq}), 0)`,
    })
    .from(invoices)
    .where(and(agency, inArray(invoices.status, [...OPEN_STATUSES])));
  const outstanding = Number(outRow?.v ?? 0);

  // ---- expenses: Σ amount in range (by expenseDate). ----
  const [expRow] = await db
    .select({ v: sum(expenses.amount) })
    .from(expenses)
    .where(
      and(
        eq(expenses.agencyId, ctx.agencyId),
        gte(expenses.expenseDate, from),
        lte(expenses.expenseDate, to),
      ),
    );
  const expensesTotal = Number(expRow?.v ?? 0);

  const netProfit = totalRevenue - expensesTotal;
  const marginPct =
    totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  // ---- pipeline buckets (count + amountDue) ----
  const pipeline = await buildPipeline(ctx, now);

  // ---- revenueByClient (top ~8 by issued invoice total, in range) ----
  const revByClient = await db
    .select({
      clientId: invoices.clientId,
      clientName: clients.name,
      amount: sum(invoices.total),
    })
    .from(invoices)
    .leftJoin(clients, eq(clients.id, invoices.clientId))
    .where(
      and(
        agency,
        inArray(invoices.status, [...ISSUED_STATUSES]),
        gte(invoices.issueDate, from),
        lte(invoices.issueDate, to),
      ),
    )
    .groupBy(invoices.clientId, clients.name)
    .orderBy(desc(sum(invoices.total)))
    .limit(8);

  const revenueByClient = revByClient.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName,
    amount: Number(r.amount ?? 0), // paise
  }));

  // ---- expensesByCategory (in range) ----
  const expByCat = await db
    .select({ category: expenses.category, amount: sum(expenses.amount) })
    .from(expenses)
    .where(
      and(
        eq(expenses.agencyId, ctx.agencyId),
        gte(expenses.expenseDate, from),
        lte(expenses.expenseDate, to),
      ),
    )
    .groupBy(expenses.category)
    .orderBy(desc(sum(expenses.amount)));

  const expensesByCategory = expByCat.map((r) => ({
    category: r.category,
    amount: Number(r.amount ?? 0), // paise
  }));

  ok(res, {
    range: { from: from.toISOString(), to: to.toISOString() },
    totalRevenue, // paise
    collected, // paise
    outstanding, // paise
    expenses: expensesTotal, // paise
    netProfit, // paise
    marginPct,
    pipeline,
    revenueByClient,
    expensesByCategory,
  });
});

/**
 * Pipeline buckets. amountDue = total - paid. 'overdue' is derived (open
 * invoices past due). 'dueThisWeek'/'dueThisMonth' are open invoices whose
 * dueDate falls in the next 7 / 30 days. 'paidThisMonth' counts payments in
 * the trailing 30 days (count of payments, amount = Σ payment amounts).
 */
async function buildPipeline(ctx: AuthCtx, now: Date) {
  const nowMs = now.getTime();
  const weekAhead = new Date(nowMs + 7 * 86_400_000);
  const monthAhead = new Date(nowMs + 30 * 86_400_000);
  const monthAgo = new Date(nowMs - 30 * 86_400_000);

  const paidPerInvoiceSq = sql<number>`(
    select coalesce(sum(${invoicePayments.amount}), 0) from ${invoicePayments}
    where ${invoicePayments.invoiceId} = ${invoices.id}
  )`;
  const dueExpr = sql<number>`(${invoices.total} - ${paidPerInvoiceSq})`;

  const agency = eq(invoices.agencyId, ctx.agencyId);
  const open = inArray(invoices.status, [...OPEN_STATUSES]);

  // overdue: open + dueDate < now + still owes.
  const [overdue] = await db
    .select({
      c: count(),
      a: sql<number>`coalesce(sum(${dueExpr}), 0)`,
    })
    .from(invoices)
    .where(and(agency, open, lte(invoices.dueDate, now), sql`${dueExpr} > 0`));

  // dueThisWeek: open + dueDate in (now, now+7d].
  const [dueWeek] = await db
    .select({
      c: count(),
      a: sql<number>`coalesce(sum(${dueExpr}), 0)`,
    })
    .from(invoices)
    .where(
      and(
        agency,
        open,
        gte(invoices.dueDate, now),
        lte(invoices.dueDate, weekAhead),
        sql`${dueExpr} > 0`,
      ),
    );

  // dueThisMonth: open + dueDate in (now, now+30d].
  const [dueMonth] = await db
    .select({
      c: count(),
      a: sql<number>`coalesce(sum(${dueExpr}), 0)`,
    })
    .from(invoices)
    .where(
      and(
        agency,
        open,
        gte(invoices.dueDate, now),
        lte(invoices.dueDate, monthAhead),
        sql`${dueExpr} > 0`,
      ),
    );

  // paidThisMonth: payments in trailing 30 days.
  const [paidMonth] = await db
    .select({
      c: count(),
      a: sql<number>`coalesce(sum(${invoicePayments.amount}), 0)`,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.agencyId, ctx.agencyId),
        gte(invoicePayments.paidAt, monthAgo),
        lte(invoicePayments.paidAt, now),
      ),
    );

  return {
    overdue: {
      count: Number(overdue?.c ?? 0),
      amount: Number(overdue?.a ?? 0),
    },
    dueThisWeek: {
      count: Number(dueWeek?.c ?? 0),
      amount: Number(dueWeek?.a ?? 0),
    },
    dueThisMonth: {
      count: Number(dueMonth?.c ?? 0),
      amount: Number(dueMonth?.a ?? 0),
    },
    paidThisMonth: {
      count: Number(paidMonth?.c ?? 0),
      amount: Number(paidMonth?.a ?? 0),
    },
  };
}
