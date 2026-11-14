import { Router } from 'express';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  contentPosts,
  expenses,
  invoicePayments,
  invoices,
  users,
} from '../db/schema.js';
import { ok, toIso } from '../lib/http.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { canOrg } from '../authz/engine.js';
import { actorUserId } from '../authz/actor.js';
import { clientScopeFilter } from '../authz/policies/clients.js';

/**
 * Read-only aggregates for the role dashboards. Nothing here writes, and each
 * endpoint is gated by the same permission that guards the underlying data:
 *   GET /dashboard/money          finance.view_overview (payroll needs users.view_compensation)
 *   GET /dashboard/content-queue  posts.view (rows limited to the clients in scope)
 * All money is INTEGER PAISE.
 */
export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

// Months are bucketed on Indian Standard Time (the agencies bill in INR/GST),
// so a payment at 01:00 IST on the 1st lands in the new month.
const IST_OFFSET_MS = 330 * 60_000;
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface MonthWindow {
  key: string; // YYYY-MM
  label: string; // "Nov"
  from: number; // epoch ms (inclusive)
  to: number; // epoch ms (exclusive)
}

/** The last `n` calendar months (IST), oldest first, ending with the current one. */
function lastMonths(n: number, nowMs = Date.now()): MonthWindow[] {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const out: MonthWindow[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const start = new Date(Date.UTC(y, m - i, 1));
    const end = new Date(Date.UTC(y, m - i + 1, 1));
    out.push({
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      label: MONTH_LABEL[start.getUTCMonth()]!,
      from: start.getTime() - IST_OFFSET_MS,
      to: end.getTime() - IST_OFFSET_MS,
    });
  }
  return out;
}

const ms = (v: Date | null | undefined): number | null =>
  v instanceof Date && !Number.isNaN(v.getTime()) ? v.getTime() : null;

const DAY_MS = 86_400_000;

// ============================================================
//  GET /dashboard/money — 6-month invoiced / collected / spent trend,
//  this month vs last month, receivables and the overdue list.
// ============================================================
dashboardRouter.get('/money', requires('finance.view_overview'), async (req, res) => {
  const actor = getStaffActor(req);
  const agencyId = actor.agencyId;
  const canSeeComp = canOrg(actor, 'users.view_compensation');
  const now = Date.now();
  const months = lastMonths(6, now);

  const invRows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      clientId: invoices.clientId,
      status: invoices.status,
      total: invoices.total,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(and(eq(invoices.agencyId, agencyId), ne(invoices.status, 'cancelled')));

  const ids = invRows.map((r) => r.id);
  const payRows = ids.length
    ? await db
        .select({
          invoiceId: invoicePayments.invoiceId,
          amount: invoicePayments.amount,
          paidAt: invoicePayments.paidAt,
          createdAt: invoicePayments.createdAt,
        })
        .from(invoicePayments)
        .where(and(eq(invoicePayments.agencyId, agencyId), inArray(invoicePayments.invoiceId, ids)))
    : [];

  const expRows = await db
    .select({
      amount: expenses.amount,
      expenseType: expenses.expenseType,
      expenseDate: expenses.expenseDate,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .where(eq(expenses.agencyId, agencyId));

  let payroll: number | null = null;
  if (canSeeComp) {
    const staff = await db
      .select({ salary: users.monthlySalaryPaise })
      .from(users)
      .where(and(eq(users.agencyId, agencyId), eq(users.kind, 'staff'), eq(users.status, 'active')));
    payroll = staff.reduce((a, s) => a + Number(s.salary ?? 0), 0);
  }

  const paidByInvoice = new Map<string, number>();
  for (const p of payRows) {
    paidByInvoice.set(p.invoiceId, (paidByInvoice.get(p.invoiceId) ?? 0) + Number(p.amount ?? 0));
  }

  const trend = months.map((mw) => {
    const inWin = (t: number | null) => t != null && t >= mw.from && t < mw.to;
    const invoiced = invRows
      .filter((r) => r.status !== 'draft' && inWin(ms(r.issueDate) ?? ms(r.createdAt)))
      .reduce((a, r) => a + Number(r.total ?? 0), 0);
    const collected = payRows
      .filter((p) => inWin(ms(p.paidAt) ?? ms(p.createdAt)))
      .reduce((a, p) => a + Number(p.amount ?? 0), 0);
    // One-time spend dated in the month + every recurring cost already running by then.
    const spent = expRows
      .filter((e) => {
        const t = ms(e.expenseDate) ?? ms(e.createdAt);
        if (e.expenseType === 'monthly_recurring') return t != null && t < mw.to;
        return inWin(t);
      })
      .reduce((a, e) => a + Number(e.amount ?? 0), 0);
    return { month: mw.key, label: mw.label, invoiced, collected, expenses: spent };
  });

  const withNet = (m: (typeof trend)[number]) => ({
    ...m,
    net: m.collected - m.expenses - (payroll ?? 0),
  });

  let outstanding = 0;
  let overdueAmount = 0;
  const overdue: Array<{
    id: string;
    invoiceNumber: string | null;
    clientId: string | null;
    balance: number;
    dueDate: string | null;
    daysOverdue: number;
  }> = [];
  for (const r of invRows) {
    if (r.status === 'draft') continue;
    const balance = Math.max(0, Number(r.total ?? 0) - (paidByInvoice.get(r.id) ?? 0));
    outstanding += balance;
    const due = ms(r.dueDate);
    if (balance > 0 && due != null && due < now) {
      overdueAmount += balance;
      overdue.push({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        clientId: r.clientId,
        balance,
        dueDate: toIso(r.dueDate),
        daysOverdue: Math.max(1, Math.floor((now - due) / DAY_MS)),
      });
    }
  }
  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue || b.balance - a.balance);

  const clientIds = [...new Set(overdue.map((o) => o.clientId).filter(Boolean) as string[])];
  const names = new Map<string, string>();
  if (clientIds.length) {
    for (const c of await db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(and(eq(clients.agencyId, agencyId), inArray(clients.id, clientIds))))
      names.set(c.id, c.name);
  }

  ok(res, {
    months: trend,
    thisMonth: withNet(trend[trend.length - 1]!),
    lastMonth: withNet(trend[trend.length - 2]!),
    payroll,
    outstanding,
    overdueAmount,
    overdueCount: overdue.length,
    overdueInvoices: overdue.slice(0, 5).map(({ clientId, ...o }) => ({
      ...o,
      clientId,
      clientName: clientId ? names.get(clientId) ?? null : null,
    })),
  });
});

// ============================================================
//  GET /dashboard/content-queue?mine=true — posts waiting on the client
//  (pending_approval) and posts the client sent back (changes_requested),
//  across every client the caller can see. `mine` keeps only posts the
//  caller created (the "waiting on me" list on My day).
// ============================================================
dashboardRouter.get('/content-queue', requires('posts.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const mine = req.query.mine === 'true';
  const uid = actorUserId(actor);

  const filters = [
    eq(contentPosts.agencyId, actor.agencyId),
    isNull(contentPosts.archivedAt),
    inArray(contentPosts.status, ['pending_approval', 'changes_requested']),
    await clientScopeFilter(actor, 'posts.view', contentPosts.clientId),
  ];
  if (mine && uid) filters.push(eq(contentPosts.createdBy, uid));

  const rows = await db
    .select({
      id: contentPosts.id,
      clientId: contentPosts.clientId,
      clientName: clients.name,
      postType: contentPosts.postType,
      caption: contentPosts.caption,
      status: contentPosts.status,
      scheduledAt: contentPosts.scheduledAt,
      updatedAt: contentPosts.updatedAt,
    })
    .from(contentPosts)
    .leftJoin(
      clients,
      and(eq(clients.id, contentPosts.clientId), eq(clients.agencyId, contentPosts.agencyId)),
    )
    .where(and(...filters))
    .orderBy(desc(contentPosts.updatedAt))
    .limit(100);

  const now = Date.now();
  const shape = (r: (typeof rows)[number]) => ({
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    postType: r.postType,
    caption: r.caption ? String(r.caption).slice(0, 140) : null,
    scheduledAt: toIso(r.scheduledAt),
    updatedAt: toIso(r.updatedAt),
    // How long it has been sitting in this state (last change → now).
    waitingDays: Math.max(0, Math.floor((now - (ms(r.updatedAt) ?? now)) / DAY_MS)),
  });

  const awaitingClient = rows.filter((r) => r.status === 'pending_approval').map(shape);
  const changesRequested = rows.filter((r) => r.status === 'changes_requested').map(shape);
  ok(res, {
    awaitingClientCount: awaitingClient.length,
    changesRequestedCount: changesRequested.length,
    awaitingClient: awaitingClient.slice(0, 20),
    changesRequested: changesRequested.slice(0, 20),
  });
});
