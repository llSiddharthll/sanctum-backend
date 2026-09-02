import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte, sql, sum } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  invoices,
  invoiceItems,
  invoicePayments,
  clients,
  projects,
  users,
  agencies,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound, badRequest } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth, requireClientAccess } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import {
  mintClientPortalLogin,
  sendClientPortalLoginEmail,
} from '../lib/client-portal-login.js';
import { pushInvoice, refrensAutoPushEnabled } from '../services/refrens-sync.js';

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth);
invoicesRouter.use(requireModuleRW('finance'));
// Invoicing management is strictly OWNER ONLY.
invoicesRouter.use(requireRole('owner'));

const invoiceSelection = {
  id: invoices.id,
  invoiceNumber: invoices.invoiceNumber,
  clientId: invoices.clientId,
  projectId: invoices.projectId,
  status: invoices.status,
  issueDate: invoices.issueDate,
  dueDate: invoices.dueDate,
  isInterstate: invoices.isInterstate,
  currency: invoices.currency,
  subtotal: invoices.subtotal,
  taxTotal: invoices.taxTotal,
  cgst: invoices.cgst,
  sgst: invoices.sgst,
  igst: invoices.igst,
  total: invoices.total,
  notes: invoices.notes,
  terms: invoices.terms,
  bankDetails: invoices.bankDetails,
  fileUrl: invoices.fileUrl,
  createdBy: invoices.createdBy,
  createdAt: invoices.createdAt,
  updatedAt: invoices.updatedAt,
  clientName: clients.name,
  projectName: projects.name,
  createdByName: users.fullName,
};

type InvoiceSelectedRow = {
  id: string;
  invoiceNumber: string | null;
  clientId: string;
  projectId: string | null;
  status: 'draft' | 'sent' | 'partially_paid' | 'paid' | 'cancelled';
  issueDate: Date | null;
  dueDate: Date | null;
  isInterstate: boolean;
  currency: string;
  subtotal: number;
  taxTotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  notes: string | null;
  terms: string | null;
  bankDetails: string | null;
  fileUrl: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  clientName: string | null;
  projectName: string | null;
  createdByName: string | null;
};

function serializeInvoice(
  inv: InvoiceSelectedRow | typeof invoices.$inferSelect,
  extra?: {
    clientName?: string | null;
    projectName?: string | null;
    createdByName?: string | null;
    items?: Array<typeof invoiceItems.$inferSelect>;
    payments?: Array<typeof invoicePayments.$inferSelect>;
    paidAmount?: number;
  },
) {
  const clientName = 'clientName' in inv ? inv.clientName : extra?.clientName ?? null;
  const projectName = 'projectName' in inv ? inv.projectName : extra?.projectName ?? null;
  const createdByName = 'createdByName' in inv ? inv.createdByName : extra?.createdByName ?? null;
  const paid = extra?.paidAmount ?? 0;
  const balance = Math.max(0, inv.total - paid);
  const isOverdue =
    inv.dueDate &&
    new Date(inv.dueDate).getTime() < Date.now() &&
    inv.status !== 'paid' &&
    inv.status !== 'cancelled';

  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    clientId: inv.clientId,
    clientName,
    projectId: inv.projectId,
    projectName,
    status: isOverdue ? 'overdue' : inv.status,
    rawStatus: inv.status,
    issueDate: toIso(inv.issueDate),
    dueDate: toIso(inv.dueDate),
    isInterstate: inv.isInterstate,
    currency: inv.currency,
    subtotal: inv.subtotal, // paise
    taxTotal: inv.taxTotal, // paise
    cgst: inv.cgst,
    sgst: inv.sgst,
    igst: inv.igst,
    total: inv.total, // paise
    paidAmount: paid, // paise
    balanceDue: balance, // paise
    notes: inv.notes,
    terms: inv.terms,
    bankDetails: inv.bankDetails,
    fileUrl: 'fileUrl' in inv ? inv.fileUrl : null,
    items: extra?.items?.map((it) => ({
      id: it.id,
      description: it.description,
      quantity: it.quantity,
      unit: it.unit,
      rate: it.rate,
      gstRate: it.gstRate,
      amount: it.amount,
      position: it.position,
    })),
    payments: extra?.payments?.map((p) => ({
      id: p.id,
      amount: p.amount,
      paidAt: toIso(p.paidAt),
      method: p.method,
      reference: p.reference,
      notes: p.notes,
    })),
    createdBy: inv.createdBy,
    createdByName,
    createdAt: toIso(inv.createdAt),
    updatedAt: toIso(inv.updatedAt),
  };
}

/**
 * Date-range bounds for `?from=`/`?to=`.
 *
 * A bare `YYYY-MM-DD` is treated as a UTC day so the result never depends on
 * the server's timezone: `to=2026-06-30` covers through 23:59:59.999Z that day.
 * (Using local setHours put the bound at 18:29Z under IST and silently dropped
 * invoices issued later on the final day.)
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function rangeStart(v: string): Date | null {
  const m = DATE_ONLY.exec(v);
  if (m) return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, 0, 0, 0, 0));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function rangeEnd(v: string): Date | null {
  const m = DATE_ONLY.exec(v);
  if (m) return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, 23, 59, 59, 999));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---- LIST INVOICES ----
invoicesRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = req.query.clientId as string | undefined;
  const projectId = req.query.projectId as string | undefined;
  const status = req.query.status as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();

  const filters = [eq(invoices.agencyId, ctx.agencyId)];
  if (clientId) filters.push(eq(invoices.clientId, clientId));
  if (projectId) filters.push(eq(invoices.projectId, projectId));
  if (status && status !== 'all') {
    filters.push(eq(invoices.status, status as typeof invoices.$inferSelect.status));
  }
  const from = req.query.from ? rangeStart(String(req.query.from)) : null;
  const to = req.query.to ? rangeEnd(String(req.query.to)) : null;
  if (from) filters.push(gte(invoices.issueDate, from));
  if (to) filters.push(lte(invoices.issueDate, to));
  if (search) {
    const term = `%${search.toLowerCase()}%`;
    filters.push(
      sql`(lower(${invoices.invoiceNumber}) like ${term} or lower(${clients.name}) like ${term})`,
    );
  }

  // Pagination is OPT-IN: only when an explicit `limit` is given, so existing
  // clients (the shipped mobile app) keep receiving the full list.
  const rawLimit = req.query.limit ? Number(req.query.limit) : null;
  const limit =
    rawLimit && Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.trunc(rawLimit)), 200)
      : null;
  const offset = Math.max(0, Math.trunc(Number(req.query.offset) || 0));

  const baseQuery = db
    .select(invoiceSelection)
    .from(invoices)
    .leftJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(projects, eq(projects.id, invoices.projectId))
    .leftJoin(users, eq(users.id, invoices.createdBy))
    .where(and(...filters))
    .orderBy(desc(invoices.issueDate), desc(invoices.createdAt));

  const rows = limit ? await baseQuery.limit(limit).offset(offset) : await baseQuery;

  // Total matching rows, so the UI can render page controls.
  const [countRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(invoices)
    .leftJoin(clients, eq(clients.id, invoices.clientId))
    .where(and(...filters));
  const total = Number(countRow?.n ?? 0);

  const invoiceIds = rows.map((r) => r.id);
  const paymentSums = new Map<string, number>();

  if (invoiceIds.length) {
    const payRows = await db
      .select({
        invoiceId: invoicePayments.invoiceId,
        totalPaid: sum(invoicePayments.amount),
      })
      .from(invoicePayments)
      .where(inArray(invoicePayments.invoiceId, invoiceIds))
      .groupBy(invoicePayments.invoiceId);

    for (const r of payRows) {
      paymentSums.set(r.invoiceId, Number(r.totalPaid ?? 0));
    }
  }

  ok(
    res,
    rows.map((r) =>
      serializeInvoice(r, {
        paidAmount: paymentSums.get(r.id) ?? 0,
      }),
    ),
    200,
    { total, limit, offset },
  );
});

// ---- SUMMARY (KPIs over ALL invoices, not just the current page) ----
// Must be registered before '/:id' or Express matches it as an invoice id.
invoicesRouter.get('/summary', async (req, res) => {
  const ctx = getAuth(req);

  // The KPI tiles must describe the same slice the table is showing.
  const sFilters = [eq(invoices.agencyId, ctx.agencyId)];
  const sFrom = req.query.from ? rangeStart(String(req.query.from)) : null;
  const sTo = req.query.to ? rangeEnd(String(req.query.to)) : null;
  if (sFrom) sFilters.push(gte(invoices.issueDate, sFrom));
  if (sTo) sFilters.push(lte(invoices.issueDate, sTo));

  const rows = await db
    .select({
      id: invoices.id,
      total: invoices.total,
      status: invoices.status,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .where(and(...sFilters));

  const paidByInvoice = new Map<string, number>();
  const payRows = await db
    .select({
      invoiceId: invoicePayments.invoiceId,
      totalPaid: sum(invoicePayments.amount),
    })
    .from(invoicePayments)
    .where(eq(invoicePayments.agencyId, ctx.agencyId))
    .groupBy(invoicePayments.invoiceId);
  for (const p of payRows) paidByInvoice.set(p.invoiceId, Number(p.totalPaid ?? 0));

  const now = Date.now();
  let totalInvoiced = 0;
  let collected = 0;
  let outstanding = 0;
  let overdueAmount = 0;
  let overdueCount = 0;
  let issuedCount = 0;

  for (const r of rows) {
    const paid = paidByInvoice.get(r.id) ?? 0;
    // A cancelled invoice is not a receivable — it must not inflate
    // outstanding, overdue or total invoiced.
    if (r.status === 'cancelled') continue;
    issuedCount += 1;
    totalInvoiced += r.total;
    collected += Math.min(paid, r.total);
    const balance = Math.max(0, r.total - paid);
    outstanding += balance;
    if (balance > 0 && r.dueDate && new Date(r.dueDate).getTime() < now) {
      overdueAmount += balance;
      overdueCount += 1;
    }
  }

  ok(res, {
    totalInvoiced, // paise
    collected,
    outstanding,
    overdueAmount,
    overdueCount,
    issuedCount,
    cancelledCount: rows.length - issuedCount,
  });
});

// ---- CREATE INVOICE ----
const itemSchema = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: z.number().positive().default(1),
  unit: z.string().trim().max(40).default('piece'),
  rate: z.number().int().min(0), // paise
  gstRate: z.number().min(0).max(100).default(18),
});

const createInvoiceSchema = z.object({
  clientId: z.string().min(1),
  projectId: z.string().optional(),
  issueDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  isInterstate: z.boolean().default(false),
  currency: z.string().trim().max(8).default('INR'),
  notes: z.string().trim().max(2000).optional(),
  terms: z.string().trim().max(2000).optional(),
  bankDetails: z.string().trim().max(1000).optional(),
  items: z.array(itemSchema).min(1),
});

invoicesRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = createInvoiceSchema.parse(req.body);

  const invoiceId = newId('inv');
  const year = new Date().getFullYear();
  const invoiceNumber = `INV-${year}-${String(Date.now() % 10000).padStart(4, '0')}`;

  let subtotal = 0;
  let taxTotal = 0;

  const preparedItems = body.items.map((it, idx) => {
    const amount = Math.round(it.quantity * it.rate);
    const itemTax = Math.round((amount * it.gstRate) / 100);
    subtotal += amount;
    taxTotal += itemTax;
    return {
      id: newId('itm'),
      agencyId: ctx.agencyId,
      invoiceId,
      description: it.description,
      quantity: it.quantity,
      unit: it.unit,
      rate: it.rate,
      gstRate: it.gstRate,
      amount,
      position: idx,
    };
  });

  const cgst = body.isInterstate ? 0 : Math.round(taxTotal / 2);
  const sgst = body.isInterstate ? 0 : taxTotal - cgst;
  const igst = body.isInterstate ? taxTotal : 0;
  const total = subtotal + taxTotal;

  await db.insert(invoices).values({
    id: invoiceId,
    agencyId: ctx.agencyId,
    clientId: body.clientId,
    projectId: body.projectId ?? null,
    invoiceNumber,
    status: 'draft',
    issueDate: body.issueDate ?? new Date(),
    dueDate: body.dueDate ?? null,
    isInterstate: body.isInterstate,
    currency: body.currency,
    subtotal,
    taxTotal,
    cgst,
    sgst,
    igst,
    total,
    notes: body.notes ?? null,
    terms: body.terms ?? null,
    bankDetails: body.bankDetails ?? null,
    createdBy: ctx.userId,
  });

  for (const itm of preparedItems) {
    await db.insert(invoiceItems).values(itm);
  }

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.create',
    entityType: 'invoice',
    entityId: invoiceId,
    ip: req.ip,
  });

  // Mirror the new invoice up to Refrens (the accounting system of record).
  // Best-effort and awaited only long enough to capture the Refrens number:
  // a Refrens outage records refrens_sync_error on the row instead of failing
  // the user's request, and the poller/"Sync now" will retry it later.
  if (refrensAutoPushEnabled()) {
    await pushInvoice(ctx.agencyId, invoiceId).catch(() => undefined);
  }

  const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  created(res, serializeInvoice(row!, { items: preparedItems as any }));
});

// ---- DETAIL ----
invoicesRouter.get('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');

  const [row] = await db
    .select(invoiceSelection)
    .from(invoices)
    .leftJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(projects, eq(projects.id, invoices.projectId))
    .leftJoin(users, eq(users.id, invoices.createdBy))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)))
    .limit(1);

  if (!row) throw notFound('Invoice not found.');

  const items = await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(invoiceItems.position);

  const payments = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoiceId))
    .orderBy(desc(invoicePayments.paidAt));

  const paidAmount = payments.reduce((acc, p) => acc + p.amount, 0);

  ok(
    res,
    serializeInvoice(row, {
      items,
      payments,
      paidAmount,
    }),
  );
});

// ---- RECORD PAYMENT ----
const paymentSchema = z.object({
  amount: z.number().int().positive(), // paise
  paidAt: z.coerce.date().optional(),
  method: z.enum(['bank_transfer', 'upi', 'cash', 'card', 'cheque', 'other']).default('bank_transfer'),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
});

invoicesRouter.post('/:id/payments', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  const body = paymentSchema.parse(req.body);

  const [inv] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)))
    .limit(1);

  if (!inv) throw notFound('Invoice not found.');

  const payId = newId('pay');
  await db.insert(invoicePayments).values({
    id: payId,
    agencyId: ctx.agencyId,
    invoiceId,
    amount: body.amount,
    paidAt: body.paidAt ?? new Date(),
    method: body.method,
    reference: body.reference ?? null,
    notes: body.notes ?? null,
    recordedBy: ctx.userId,
  });

  // Calculate new total paid
  const [paySum] = await db
    .select({ total: sum(invoicePayments.amount) })
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoiceId));

  const totalPaid = Number(paySum?.total ?? 0);
  const newStatus = totalPaid >= inv.total ? 'paid' : totalPaid > 0 ? 'partially_paid' : inv.status;

  await db
    .update(invoices)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.record_payment',
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: { paymentId: payId, amount: body.amount },
    ip: req.ip,
  });

  ok(res, { paymentId: payId, status: newStatus, totalPaid });
});

// ---- EDIT INVOICE ----
// Full field edit. When `items` is supplied the line items are replaced and all
// money is recomputed server-side. Any edit to an invoice linked to Refrens is
// pushed back up, which is what makes editing genuinely two-way.
const updateInvoiceSchema = z.object({
  clientId: z.string().min(1).optional(),
  projectId: z.string().nullable().optional(),
  issueDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  isInterstate: z.boolean().optional(),
  currency: z.string().trim().max(8).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  terms: z.string().trim().max(2000).nullable().optional(),
  bankDetails: z.string().trim().max(1000).nullable().optional(),
  items: z.array(itemSchema).min(1).optional(),
});

invoicesRouter.patch('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  const body = updateInvoiceSchema.parse(req.body);

  const [existing] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)))
    .limit(1);
  if (!existing) throw notFound('Invoice not found.');
  if (existing.status === 'cancelled') {
    throw badRequest('A cancelled invoice cannot be edited.');
  }

  const patch: Partial<typeof invoices.$inferInsert> = { updatedAt: new Date() };
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.projectId !== undefined) patch.projectId = body.projectId;
  if (body.issueDate !== undefined) patch.issueDate = body.issueDate;
  if (body.dueDate !== undefined) patch.dueDate = body.dueDate;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.terms !== undefined) patch.terms = body.terms;
  if (body.bankDetails !== undefined) patch.bankDetails = body.bankDetails;

  const isInterstate = body.isInterstate ?? existing.isInterstate;
  if (body.isInterstate !== undefined) patch.isInterstate = body.isInterstate;

  // Recompute money whenever the lines or the tax treatment change.
  if (body.items || body.isInterstate !== undefined) {
    const items =
      body.items ??
      (
        await db
          .select()
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, existing.id))
      ).map((it) => ({
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        rate: it.rate,
        gstRate: it.gstRate,
      }));

    let subtotal = 0;
    let taxTotal = 0;
    const prepared = items.map((it, idx) => {
      const amount = Math.round(it.quantity * it.rate);
      subtotal += amount;
      taxTotal += Math.round((amount * it.gstRate) / 100);
      return {
        id: newId('itm'),
        agencyId: ctx.agencyId,
        invoiceId: existing.id,
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        rate: it.rate,
        gstRate: it.gstRate,
        amount,
        position: idx,
      };
    });

    patch.subtotal = subtotal;
    patch.taxTotal = taxTotal;
    patch.cgst = isInterstate ? 0 : Math.round(taxTotal / 2);
    patch.sgst = isInterstate ? 0 : taxTotal - Math.round(taxTotal / 2);
    patch.igst = isInterstate ? taxTotal : 0;
    patch.total = subtotal + taxTotal;

    await db.delete(invoiceItems).where(eq(invoiceItems.invoiceId, existing.id));
    for (const itm of prepared) await db.insert(invoiceItems).values(itm);
  }

  await db.update(invoices).set(patch).where(eq(invoices.id, existing.id));

  // Two-way: mirror the edit onto the linked Refrens invoice.
  if (existing.refrensId && refrensAutoPushEnabled()) {
    await pushInvoice(ctx.agencyId, existing.id).catch(() => undefined);
  }

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.update',
    entityType: 'invoice',
    entityId: existing.id,
    ip: req.ip,
  });

  const [row] = await db.select().from(invoices).where(eq(invoices.id, existing.id));
  const items = await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, existing.id))
    .orderBy(invoiceItems.position);
  ok(res, serializeInvoice(row!, { items }));
});

// ---- UPDATE STATUS ----
invoicesRouter.patch('/:id/status', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  const body = z.object({ status: z.enum(['draft', 'sent', 'cancelled', 'paid']) }).parse(req.body);

  const [existing] = await db
    .select({ id: invoices.id, refrensId: invoices.refrensId })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)))
    .limit(1);
  if (!existing) throw notFound('Invoice not found.');

  await db
    .update(invoices)
    .set({ status: body.status, updatedAt: new Date() })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)));

  // Two-way: mirror the new status onto the linked Refrens invoice.
  if (existing.refrensId && refrensAutoPushEnabled()) {
    await pushInvoice(ctx.agencyId, invoiceId).catch(() => undefined);
  }

  ok(res, { status: body.status });
});

// ---- SEND INVOICE ----
// Invoices have no public no-login view page — the client's only way to see
// one online is the logged-in client portal — so sending an invoice always
// mails the client their portal sign-in (link + email + password), the same
// credential email used for document-mode proposals/agreements.
invoicesRouter.post('/:id/send', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  const body = z
    .object({ recipientEmail: z.string().email(), message: z.string().optional() })
    .parse(req.body);

  const [inv] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)))
    .limit(1);
  if (!inv) throw notFound('Invoice not found.');

  const client = await requireClientAccess(ctx, inv.clientId);
  const [agency] = await db.select({ name: agencies.name }).from(agencies).where(eq(agencies.id, ctx.agencyId)).limit(1);
  const agencyName = agency?.name ?? 'Creative Monk';

  const login = await mintClientPortalLogin({
    agencyId: ctx.agencyId,
    clientId: client.id,
    clientName: client.name,
    clientContactEmail: client.contactEmail,
    email: body.recipientEmail,
  });

  const amountLabel = `₹${(inv.total / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const invoiceLabel = inv.invoiceNumber ? `Invoice ${inv.invoiceNumber}` : 'A new invoice';
  await sendClientPortalLoginEmail({
    req,
    agencyName,
    clientName: client.name,
    to: body.recipientEmail,
    email: login.email,
    password: login.password,
    note: `${body.message ? `${body.message} ` : ''}${invoiceLabel} for ${amountLabel} is ready to view in your portal.`.trim(),
  });

  await db
    .update(invoices)
    .set({
      status: inv.status === 'draft' ? 'sent' : inv.status,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, inv.id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.send',
    entityType: 'invoice',
    entityId: inv.id,
    metadata: { recipientEmail: body.recipientEmail },
    ip: req.ip,
  });

  ok(res, { sent: true });
});
