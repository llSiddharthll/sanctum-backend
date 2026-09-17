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
import { notFound, badRequest, invalidState } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { computeInvoiceTotals, statusAfterPayment } from '../lib/finance.js';
import {
  pushInvoice,
  refrensAutoPushEnabled,
  refrensBoundTo,
} from '../services/refrens-sync.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize, capabilities } from '../authz/engine.js';
import { actorAuditId, type Actor } from '../authz/actor.js';
import { requireInAgency } from '../authz/tenancy.js';
import {
  assertInvoiceEditable,
  deliverViaPortalLogin,
  escapeHtml,
  invoiceFactsOf,
  invoiceScopeFilter,
  invoiceTransitionError,
  loadInvoice,
} from '../authz/policies/business.js';

export const invoicesRouter = Router();
invoicesRouter.use(authenticate);

const INVOICE_CAPABILITIES = [
  'invoices.update',
  'invoices.change_status',
  'invoices.record_payment',
  'invoices.send',
  'invoices.sync',
];
const INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'paid', 'cancelled'] as const;

const invoiceSelection = {
  id: invoices.id,
  agencyId: invoices.agencyId,
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
  agencyId: string;
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
  actor: Actor,
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
    capabilities: capabilities(actor, invoiceFactsOf(inv), INVOICE_CAPABILITIES),
  };
}

function auditInvoice(actor: Actor, action: string, id: string, ip: string | undefined, metadata?: Record<string, unknown>) {
  return audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action,
    entityType: 'invoice',
    entityId: id,
    metadata,
    ip,
  });
}

/** Tenant-bound references; a project must also belong to the invoice's client. */
async function checkRefs(actor: Actor, clientId: string, projectId: string | null | undefined) {
  await requireInAgency(clients, actor.agencyId, clientId, 'Client');
  if (projectId) {
    const [p] = await db
      .select({ clientId: projects.clientId })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.agencyId, actor.agencyId)))
      .limit(1);
    if (!p) throw notFound('Project not found.');
    if (p.clientId && p.clientId !== clientId) {
      throw badRequest('That project belongs to a different client.');
    }
  }
}

async function paidTotal(agencyId: string, invoiceId: string): Promise<number> {
  const [row] = await db
    .select({ total: sum(invoicePayments.amount) })
    .from(invoicePayments)
    .where(and(eq(invoicePayments.invoiceId, invoiceId), eq(invoicePayments.agencyId, agencyId)));
  return Number(row?.total ?? 0);
}

async function maybePush(actor: Actor, invoiceId: string, onlyIfLinked: string | null | undefined | true) {
  if (onlyIfLinked === null || onlyIfLinked === undefined) return;
  // Auto-push only for the tenant bound to the Refrens credentials.
  if (refrensAutoPushEnabled() && refrensBoundTo(actor.agencyId)) {
    await pushInvoice(actor.agencyId, invoiceId).catch(() => undefined);
  }
}

/**
 * Date-range bounds for `?from=`/`?to=`.
 *
 * A bare `YYYY-MM-DD` is treated as a UTC day so the result never depends on
 * the server's timezone: `to=2026-06-30` covers through 23:59:59.999Z that day.
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
invoicesRouter.get('/', requires('invoices.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = req.query.clientId as string | undefined;
  const projectId = req.query.projectId as string | undefined;
  const status = req.query.status as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();

  const filters = [eq(invoices.agencyId, actor.agencyId), invoiceScopeFilter(actor)];
  if (clientId) filters.push(eq(invoices.clientId, clientId));
  if (projectId) filters.push(eq(invoices.projectId, projectId));
  if (status && status !== 'all') {
    if (!(INVOICE_STATUSES as readonly string[]).includes(status)) {
      throw badRequest('Unknown invoice status.');
    }
    filters.push(eq(invoices.status, status as (typeof INVOICE_STATUSES)[number]));
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

  // Pagination is OPT-IN: only when an explicit `limit` is given.
  const rawLimit = req.query.limit ? Number(req.query.limit) : null;
  const limit =
    rawLimit && Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.trunc(rawLimit)), 200)
      : null;
  const offset = Math.max(0, Math.trunc(Number(req.query.offset) || 0));

  const baseQuery = db
    .select(invoiceSelection)
    .from(invoices)
    .leftJoin(clients, and(eq(clients.id, invoices.clientId), eq(clients.agencyId, invoices.agencyId)))
    .leftJoin(projects, and(eq(projects.id, invoices.projectId), eq(projects.agencyId, invoices.agencyId)))
    .leftJoin(users, and(eq(users.id, invoices.createdBy), eq(users.agencyId, invoices.agencyId)))
    .where(and(...filters))
    .orderBy(desc(invoices.issueDate), desc(invoices.createdAt));

  const rows = limit ? await baseQuery.limit(limit).offset(offset) : await baseQuery;

  const [countRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(invoices)
    .leftJoin(clients, and(eq(clients.id, invoices.clientId), eq(clients.agencyId, invoices.agencyId)))
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
      .where(and(eq(invoicePayments.agencyId, actor.agencyId), inArray(invoicePayments.invoiceId, invoiceIds)))
      .groupBy(invoicePayments.invoiceId);

    for (const r of payRows) {
      paymentSums.set(r.invoiceId, Number(r.totalPaid ?? 0));
    }
  }

  ok(
    res,
    rows.map((r) =>
      serializeInvoice(actor, r, {
        paidAmount: paymentSums.get(r.id) ?? 0,
      }),
    ),
    200,
    { total, limit, offset },
  );
});

// ---- SUMMARY (KPIs over ALL invoices, not just the current page) ----
// Must be registered before '/:id' or Express matches it as an invoice id.
invoicesRouter.get('/summary', requires('invoices.view'), async (req, res) => {
  const actor = getStaffActor(req);

  const sFilters = [eq(invoices.agencyId, actor.agencyId), invoiceScopeFilter(actor)];
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
    .where(eq(invoicePayments.agencyId, actor.agencyId))
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
    // A cancelled invoice is not a receivable.
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

type ItemInput = z.infer<typeof itemSchema>;

function prepareItems(agencyId: string, invoiceId: string, items: ItemInput[], isInterstate: boolean) {
  const totals = computeInvoiceTotals(items, isInterstate);
  const prepared = items.map((it, idx) => ({
    id: newId('itm'),
    agencyId,
    invoiceId,
    description: it.description,
    quantity: it.quantity,
    unit: it.unit,
    rate: it.rate,
    gstRate: it.gstRate,
    amount: totals.lines[idx]!.amount,
    position: idx,
  }));
  return { totals, prepared };
}

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

invoicesRouter.post('/', requires('invoices.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = createInvoiceSchema.parse(req.body);
  await checkRefs(actor, body.clientId, body.projectId);

  const invoiceId = newId('inv');
  const year = new Date().getFullYear();
  const invoiceNumber = `INV-${year}-${String(Date.now() % 10000).padStart(4, '0')}`;
  const { totals, prepared } = prepareItems(actor.agencyId, invoiceId, body.items, body.isInterstate);

  await db.transaction(async (tx) => {
    await tx.insert(invoices).values({
      id: invoiceId,
      agencyId: actor.agencyId,
      clientId: body.clientId,
      projectId: body.projectId ?? null,
      invoiceNumber,
      status: 'draft',
      issueDate: body.issueDate ?? new Date(),
      dueDate: body.dueDate ?? null,
      isInterstate: body.isInterstate,
      currency: body.currency,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      cgst: totals.cgst,
      sgst: totals.sgst,
      igst: totals.igst,
      total: totals.total,
      notes: body.notes ?? null,
      terms: body.terms ?? null,
      bankDetails: body.bankDetails ?? null,
      createdBy: actor.userId,
    });
    for (const itm of prepared) await tx.insert(invoiceItems).values(itm);
  });

  await auditInvoice(actor, 'invoice.create', invoiceId, req.ip, { total: totals.total, clientId: body.clientId });

  // Mirror the new invoice up to Refrens (bound tenant only; best-effort).
  await maybePush(actor, invoiceId, true);

  const loaded = await loadInvoice(actor, invoiceId);
  created(res, serializeInvoice(actor, loaded!.row, { items: prepared as any }));
});

// ---- DETAIL ----
invoicesRouter.get('/:id', requires('invoices.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const invoiceId = param(req, 'id');

  const [row] = await db
    .select(invoiceSelection)
    .from(invoices)
    .leftJoin(clients, and(eq(clients.id, invoices.clientId), eq(clients.agencyId, invoices.agencyId)))
    .leftJoin(projects, and(eq(projects.id, invoices.projectId), eq(projects.agencyId, invoices.agencyId)))
    .leftJoin(users, and(eq(users.id, invoices.createdBy), eq(users.agencyId, invoices.agencyId)))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.agencyId, actor.agencyId)))
    .limit(1);

  authorize(actor, 'invoices.view', row ? invoiceFactsOf(row) : null);

  const items = await db
    .select()
    .from(invoiceItems)
    .where(and(eq(invoiceItems.invoiceId, invoiceId), eq(invoiceItems.agencyId, actor.agencyId)))
    .orderBy(invoiceItems.position);

  const payments = await db
    .select()
    .from(invoicePayments)
    .where(and(eq(invoicePayments.invoiceId, invoiceId), eq(invoicePayments.agencyId, actor.agencyId)))
    .orderBy(desc(invoicePayments.paidAt));

  const paidAmount = payments.reduce((acc, p) => acc + p.amount, 0);

  ok(res, serializeInvoice(actor, row!, { items, payments, paidAmount }));
});

// ---- RECORD PAYMENT ----
const paymentSchema = z.object({
  amount: z.number().int().positive(), // paise
  paidAt: z.coerce.date().optional(),
  method: z.enum(['bank_transfer', 'upi', 'cash', 'card', 'cheque', 'other']).default('bank_transfer'),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
});

invoicesRouter.post('/:id/payments', requires('invoices.record_payment'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = paymentSchema.parse(req.body);
  const loaded = await loadInvoice(actor, param(req, 'id'));
  authorize(actor, 'invoices.record_payment', loaded?.facts, { view: 'invoices.view' });
  const inv = loaded!.row;

  if (inv.status === 'cancelled' || inv.status === 'paid') {
    throw invalidState(`Payments cannot be recorded on a ${inv.status} invoice.`);
  }
  if (body.paidAt && body.paidAt.getTime() > Date.now() + 86_400_000) {
    throw badRequest('A payment date cannot be in the future.');
  }

  const payId = newId('pay');
  const result = await db.transaction(async (tx) => {
    const [paySum] = await tx
      .select({ total: sum(invoicePayments.amount) })
      .from(invoicePayments)
      .where(and(eq(invoicePayments.invoiceId, inv.id), eq(invoicePayments.agencyId, actor.agencyId)));
    const before = Number(paySum?.total ?? 0);
    const balance = Math.max(0, inv.total - before);
    if (body.amount > balance) {
      throw invalidState(`Payment exceeds the balance due (${balance} paise).`);
    }
    await tx.insert(invoicePayments).values({
      id: payId,
      agencyId: actor.agencyId,
      invoiceId: inv.id,
      amount: body.amount,
      paidAt: body.paidAt ?? new Date(),
      method: body.method,
      reference: body.reference ?? null,
      notes: body.notes ?? null,
      recordedBy: actor.userId,
    });
    const totalPaid = before + body.amount;
    const newStatus = statusAfterPayment(inv.status, totalPaid, inv.total, inv.status !== 'draft');
    await tx
      .update(invoices)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(and(eq(invoices.id, inv.id), eq(invoices.agencyId, actor.agencyId)));
    return { totalPaid, newStatus, balanceBefore: balance };
  });

  await auditInvoice(actor, 'invoice.record_payment', inv.id, req.ip, {
    paymentId: payId,
    amount: body.amount,
    method: body.method,
    statusBefore: inv.status,
    statusAfter: result.newStatus,
    balanceBefore: result.balanceBefore,
  });

  ok(res, { paymentId: payId, status: result.newStatus, totalPaid: result.totalPaid });
});

// ---- EDIT INVOICE ----
// Full field edit. When `items` is supplied the line items are replaced and all
// money is recomputed server-side. Paid and cancelled invoices are immutable.
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

invoicesRouter.patch('/:id', requires('invoices.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = updateInvoiceSchema.parse(req.body);
  const loaded = await loadInvoice(actor, param(req, 'id'));
  authorize(actor, 'invoices.update', loaded?.facts, { view: 'invoices.view' });
  const existing = loaded!.row;
  assertInvoiceEditable(existing);

  const nextClientId = body.clientId ?? existing.clientId;
  const nextProjectId = body.projectId !== undefined ? body.projectId : existing.projectId;
  if (body.clientId !== undefined || body.projectId !== undefined) {
    await checkRefs(actor, nextClientId, nextProjectId);
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

  const paid = await paidTotal(actor.agencyId, existing.id);
  if (paid > 0 && body.clientId !== undefined && body.clientId !== existing.clientId) {
    throw invalidState('An invoice with payments cannot be moved to another client.');
  }

  let prepared: ReturnType<typeof prepareItems>['prepared'] | null = null;
  // Recompute money whenever the lines or the tax treatment change.
  if (body.items || body.isInterstate !== undefined) {
    const items: ItemInput[] =
      body.items ??
      (
        await db
          .select()
          .from(invoiceItems)
          .where(and(eq(invoiceItems.invoiceId, existing.id), eq(invoiceItems.agencyId, actor.agencyId)))
          .orderBy(invoiceItems.position)
      ).map((it) => ({
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        rate: it.rate,
        gstRate: it.gstRate,
      }));

    const r = prepareItems(actor.agencyId, existing.id, items, isInterstate);
    if (r.totals.total < paid) {
      throw invalidState('The new total would be less than the payments already recorded.');
    }
    prepared = r.prepared;
    patch.subtotal = r.totals.subtotal;
    patch.taxTotal = r.totals.taxTotal;
    patch.cgst = r.totals.cgst;
    patch.sgst = r.totals.sgst;
    patch.igst = r.totals.igst;
    patch.total = r.totals.total;
  }

  await db.transaction(async (tx) => {
    if (prepared && body.items) {
      await tx
        .delete(invoiceItems)
        .where(and(eq(invoiceItems.invoiceId, existing.id), eq(invoiceItems.agencyId, actor.agencyId)));
      for (const itm of prepared) await tx.insert(invoiceItems).values(itm);
    }
    await tx
      .update(invoices)
      .set(patch)
      .where(and(eq(invoices.id, existing.id), eq(invoices.agencyId, actor.agencyId)));
  });

  // Two-way: mirror the edit onto the linked Refrens invoice.
  await maybePush(actor, existing.id, existing.refrensId);

  const bankChanged = body.bankDetails !== undefined && body.bankDetails !== existing.bankDetails;
  await auditInvoice(actor, 'invoice.update', existing.id, req.ip, {
    fields: Object.keys(patch).filter((k) => k !== 'updatedAt'),
    ...(patch.total !== undefined ? { totalBefore: existing.total, totalAfter: patch.total } : {}),
  });
  if (bankChanged) {
    // Payment-redirection risk: always keep the before/after of bank details.
    await auditInvoice(actor, 'invoice.bank_details.update', existing.id, req.ip, {
      before: existing.bankDetails,
      after: body.bankDetails,
    });
  }

  const reloaded = await loadInvoice(actor, existing.id);
  const items = await db
    .select()
    .from(invoiceItems)
    .where(and(eq(invoiceItems.invoiceId, existing.id), eq(invoiceItems.agencyId, actor.agencyId)))
    .orderBy(invoiceItems.position);
  ok(res, serializeInvoice(actor, reloaded!.row, { items, paidAmount: paid }));
});

// ---- UPDATE STATUS (explicit state machine) ----
const statusSchema = z.object({
  status: z.enum(['draft', 'sent', 'cancelled', 'paid']),
  /** Mark paid although recorded payments do not cover the total (audited). */
  override: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});

invoicesRouter.patch('/:id/status', requires('invoices.change_status'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = statusSchema.parse(req.body);
  const loaded = await loadInvoice(actor, param(req, 'id'));
  authorize(actor, 'invoices.change_status', loaded?.facts, { view: 'invoices.view' });
  const existing = loaded!.row;

  const paid = await paidTotal(actor.agencyId, existing.id);
  const reason = invoiceTransitionError({
    from: existing.status,
    to: body.status,
    paid,
    total: existing.total,
    override: body.override === true,
  });
  if (reason) throw invalidState(reason);

  if (body.status !== existing.status) {
    const updated = await db
      .update(invoices)
      .set({ status: body.status, updatedAt: new Date() })
      .where(
        and(
          eq(invoices.id, existing.id),
          eq(invoices.agencyId, actor.agencyId),
          eq(invoices.status, existing.status),
        ),
      )
      .returning({ id: invoices.id });
    if (!updated.length) throw invalidState('The invoice changed meanwhile. Reload and try again.');

    const overridden = body.status === 'paid' && paid < existing.total;
    await auditInvoice(actor, overridden ? 'invoice.status.override_paid' : 'invoice.status', existing.id, req.ip, {
      before: existing.status,
      after: body.status,
      paid,
      total: existing.total,
      ...(overridden ? { override: true, reason: body.reason ?? null } : {}),
    });

    // Two-way: mirror the new status onto the linked Refrens invoice.
    await maybePush(actor, existing.id, existing.refrensId);
  }

  ok(res, { status: body.status });
});

// ---- SEND INVOICE ----
// Invoices have no public no-login view page — the client sees them in the
// client portal, so sending delivers portal access (never overwriting an
// existing client login).
invoicesRouter.post('/:id/send', requires('invoices.send'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = z
    .object({ recipientEmail: z.string().email(), message: z.string().max(2000).optional() })
    .parse(req.body);
  const loaded = await loadInvoice(actor, param(req, 'id'));
  authorize(actor, 'invoices.send', loaded?.facts, { view: 'invoices.view' });
  const inv = loaded!.row;
  if (inv.status === 'cancelled') throw invalidState('A cancelled invoice cannot be sent.');

  const [agency] = await db.select({ name: agencies.name }).from(agencies).where(eq(agencies.id, actor.agencyId)).limit(1);
  const agencyName = agency?.name ?? 'Creative Monk';

  const amountLabel = `₹${(inv.total / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const invoiceLabel = inv.invoiceNumber ? `Invoice ${escapeHtml(inv.invoiceNumber)}` : 'A new invoice';
  const delivered = await deliverViaPortalLogin({
    actor,
    req,
    clientId: inv.clientId,
    recipientEmail: body.recipientEmail,
    agencyName,
    note: `${body.message ? `${escapeHtml(body.message)} ` : ''}${invoiceLabel} for ${amountLabel} is ready to view in your portal.`.trim(),
  });

  const newStatus = inv.status === 'draft' ? 'sent' : inv.status;
  await db
    .update(invoices)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(and(eq(invoices.id, inv.id), eq(invoices.agencyId, actor.agencyId)));

  await auditInvoice(actor, 'invoice.send', inv.id, req.ip, {
    recipientEmail: body.recipientEmail,
    portalLoginCreated: delivered.created,
    ...(newStatus !== inv.status ? { statusBefore: inv.status, statusAfter: newStatus } : {}),
  });

  ok(res, { sent: true });
});
