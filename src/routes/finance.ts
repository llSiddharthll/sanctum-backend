import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte, ne, sum } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  deals,
  expenses,
  invoicePayments,
  invoices,
} from '../db/schema.js';
import { ok, param } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';

export const financeRouter = Router();
financeRouter.use(requireAuth);
financeRouter.use(requireModuleRW('finance'));
// Money is owner ONLY — hard role backstop so nobody except the owner can reach financial data.
financeRouter.use(requireRole('owner'));

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

  // No revenue term anymore — profit is simply negative expenses.
  const netProfit = 0 - expensesTotal;

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
    expenses: expensesTotal, // paise
    netProfit, // paise
    expensesByCategory,
  });
});

/**
 * GET /finance/clients/:clientId — a single client's financial rollup (owner/
 * admin only, inherited from the router gates). All money = INTEGER PAISE.
 * Surfaced on the client detail page's Financials section.
 */
financeRouter.get('/clients/:clientId', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');

  const [client] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);
  if (!client) throw notFound('Client not found.');

  // Invoices for this client (exclude cancelled from billed).
  const inv = await db
    .select({ id: invoices.id, total: invoices.total, status: invoices.status })
    .from(invoices)
    .where(
      and(
        eq(invoices.agencyId, ctx.agencyId),
        eq(invoices.clientId, clientId),
        ne(invoices.status, 'cancelled'),
      ),
    );
  const billed = inv.reduce((a, r) => a + Number(r.total ?? 0), 0);
  const invoiceIds = inv.map((r) => r.id);
  let paid = 0;
  if (invoiceIds.length) {
    const [payRow] = await db
      .select({ v: sum(invoicePayments.amount) })
      .from(invoicePayments)
      .where(inArray(invoicePayments.invoiceId, invoiceIds));
    paid = Number(payRow?.v ?? 0);
  }

  const [expRow] = await db
    .select({ v: sum(expenses.amount) })
    .from(expenses)
    .where(
      and(eq(expenses.agencyId, ctx.agencyId), eq(expenses.clientId, clientId)),
    );
  const expensesTotal = Number(expRow?.v ?? 0);

  const [dealRow] = await db
    .select({ v: sum(deals.valuePaise) })
    .from(deals)
    .where(
      and(eq(deals.agencyId, ctx.agencyId), eq(deals.clientId, clientId)),
    );
  const dealPipelineValue = Number(dealRow?.v ?? 0);

  ok(res, {
    clientId: client.id,
    clientName: client.name,
    invoiceCount: inv.length,
    billed, // paise
    paid, // paise
    outstanding: Math.max(0, billed - paid), // paise
    expenses: expensesTotal, // paise
    dealPipelineValue, // paise
  });
});
