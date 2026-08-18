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
  projects,
  users,
} from '../db/schema.js';
import { ok, param, toIso } from '../lib/http.js';
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

/**
 * GET /finance/owner-snapshot — the owner's money at a glance. All paise.
 * Revenue (collected) + outstanding, total expenses, recurring monthly payroll,
 * a rough monthly net, plus recent invoices/expenses and the per-member salary
 * roster. Owner-only (router gate).
 */
financeRouter.get('/owner-snapshot', async (req, res) => {
  const ctx = getAuth(req);

  // Invoices (exclude cancelled from billed).
  const inv = await db
    .select({
      id: invoices.id,
      clientId: invoices.clientId,
      invoiceNumber: invoices.invoiceNumber,
      total: invoices.total,
      status: invoices.status,
      dueDate: invoices.dueDate,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(
      and(eq(invoices.agencyId, ctx.agencyId), ne(invoices.status, 'cancelled')),
    );
  const billed = inv.reduce((a, r) => a + Number(r.total ?? 0), 0);
  const invoiceIds = inv.map((r) => r.id);
  const paidByInvoice = new Map<string, number>();
  let paid = 0;
  if (invoiceIds.length) {
    const pays = await db
      .select({
        invoiceId: invoicePayments.invoiceId,
        amount: invoicePayments.amount,
      })
      .from(invoicePayments)
      .where(inArray(invoicePayments.invoiceId, invoiceIds));
    for (const p of pays) {
      const amt = Number(p.amount ?? 0);
      paid += amt;
      paidByInvoice.set(p.invoiceId, (paidByInvoice.get(p.invoiceId) ?? 0) + amt);
    }
  }
  const outstanding = Math.max(0, billed - paid);
  const now = new Date();
  const overdueCount = inv.filter(
    (r) =>
      Number(r.total ?? 0) - (paidByInvoice.get(r.id) ?? 0) > 0 &&
      r.dueDate != null &&
      new Date(r.dueDate) < now,
  ).length;

  // Total expenses (all time).
  const [expRow] = await db
    .select({ v: sum(expenses.amount) })
    .from(expenses)
    .where(eq(expenses.agencyId, ctx.agencyId));
  const expensesTotal = Number(expRow?.v ?? 0);

  // Recurring monthly payroll — active staff only (clients excluded).
  const staff = await db
    .select({
      id: users.id,
      name: users.fullName,
      role: users.role,
      customRoleId: users.customRoleId,
      designation: users.designation,
      salary: users.monthlySalaryPaise,
    })
    .from(users)
    .where(
      and(
        eq(users.agencyId, ctx.agencyId),
        ne(users.role, 'client'),
        eq(users.status, 'active'),
      ),
    );
  const monthlyPayroll = staff.reduce((a, s) => a + Number(s.salary ?? 0), 0);

  // ---- Monthly REVENUE from active projects ----
  // Retainer projects contribute their monthly recurring fee. One-time projects
  // amortize their contract value across their start→deadline duration, counted
  // only while the current month falls inside that window.
  const AVG_MONTH_MS = (365.25 / 12) * 86_400_000;
  // One-time projects without an explicit start→end window amortize over this
  // many months by default (temporary until durations are set per project).
  const DEFAULT_ONE_TIME_MONTHS = 4;
  const projRows = await db
    .select({
      contractValue: projects.contractValue,
      billingType: projects.billingType,
      recurringPaise: projects.recurringPaise,
      status: projects.status,
      startDate: projects.startDate,
      deadline: projects.deadline,
    })
    .from(projects)
    .where(eq(projects.agencyId, ctx.agencyId));
  const CLOSED = new Set(['completed', 'cancelled']);
  let recurringRevenue = 0;
  let oneTimeMonthly = 0;
  for (const p of projRows) {
    if (CLOSED.has(p.status)) continue;
    if (p.billingType === 'retainer') {
      recurringRevenue += Number(p.recurringPaise ?? 0);
    } else {
      const cv = Number(p.contractValue ?? 0);
      if (cv > 0) {
        const start = p.startDate ? new Date(p.startDate) : null;
        const end = p.deadline ? new Date(p.deadline) : null;
        let months = DEFAULT_ONE_TIME_MONTHS;
        let inWindow = true;
        if (start && end && end > start) {
          months = Math.max(
            1,
            Math.round((end.getTime() - start.getTime()) / AVG_MONTH_MS),
          );
          inWindow = now >= start && now <= end;
        }
        if (inWindow) oneTimeMonthly += Math.round(cv / months);
      }
    }
  }
  const monthlyRevenue = recurringRevenue + oneTimeMonthly;

  // ---- Expenses for the current calendar month (for a coherent monthly net) ----
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  // Monthly cost = one-time expenses dated this month + EVERY monthly-recurring
  // expense (subscriptions etc. recur each month, like recurring salaries).
  const [oneTimeExpRow] = await db
    .select({ v: sum(expenses.amount) })
    .from(expenses)
    .where(
      and(
        eq(expenses.agencyId, ctx.agencyId),
        eq(expenses.expenseType, 'one_time'),
        gte(expenses.expenseDate, monthStart),
      ),
    );
  const [recurringExpRow] = await db
    .select({ v: sum(expenses.amount) })
    .from(expenses)
    .where(
      and(
        eq(expenses.agencyId, ctx.agencyId),
        eq(expenses.expenseType, 'monthly_recurring'),
      ),
    );
  const monthlyExpenses =
    Number(oneTimeExpRow?.v ?? 0) + Number(recurringExpRow?.v ?? 0);

  const clientRows = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.agencyId, ctx.agencyId));
  const clientName = new Map(clientRows.map((c) => [c.id, c.name]));

  const recentInvoices = [...inv]
    .sort(
      (a, b) =>
        new Date(b.createdAt ?? 0).getTime() -
        new Date(a.createdAt ?? 0).getTime(),
    )
    .slice(0, 6)
    .map((r) => ({
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      clientName: r.clientId ? clientName.get(r.clientId) ?? null : null,
      total: Number(r.total ?? 0),
      balance: Math.max(0, Number(r.total ?? 0) - (paidByInvoice.get(r.id) ?? 0)),
      status: r.status,
      dueDate: toIso(r.dueDate),
    }));

  const recentExpenseRows = await db
    .select()
    .from(expenses)
    .where(eq(expenses.agencyId, ctx.agencyId))
    .orderBy(desc(expenses.expenseDate))
    .limit(6);
  const recentExpenses = recentExpenseRows.map((e) => ({
    id: e.id,
    category: e.category,
    expenseType: e.expenseType,
    amount: Number(e.amount ?? 0),
    description: e.description,
    date: toIso(e.expenseDate),
  }));

  ok(res, {
    // Monthly revenue from projects (retainer recurring + amortized one-time) —
    // the headline "Revenue" on the owner dashboard.
    monthlyRevenue,
    recurringRevenue,
    oneTimeMonthly,
    monthlyExpenses,
    monthlyPayroll,
    // Coherent monthly net: this-month revenue − this-month expenses − payroll.
    monthlyNet: monthlyRevenue - monthlyExpenses - monthlyPayroll,
    // Cash view (invoices): collected to date + what's still owed.
    collected: paid,
    revenue: paid, // legacy alias (collected)
    billed,
    outstanding,
    expenses: expensesTotal, // all-time
    netCash: paid - expensesTotal,
    invoiceCount: inv.length,
    overdueCount,
    headcount: staff.length,
    salaries: staff
      .filter((s) => Number(s.salary ?? 0) > 0)
      .sort((a, b) => Number(b.salary ?? 0) - Number(a.salary ?? 0))
      .map((s) => ({
        userId: s.id,
        name: s.name,
        role: s.role,
        designation: s.designation,
        monthlySalaryPaise: Number(s.salary ?? 0),
      })),
    recentInvoices,
    recentExpenses,
  });
});
