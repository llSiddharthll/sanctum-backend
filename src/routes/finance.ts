import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sum } from 'drizzle-orm';
import { db } from '../db/client.js';
import { expenses } from '../db/schema.js';
import { ok } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';

export const financeRouter = Router();
financeRouter.use(requireAuth);
financeRouter.use(requireModuleRW('finance'));

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
