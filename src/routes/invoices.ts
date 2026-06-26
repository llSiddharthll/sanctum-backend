import { Router } from 'express';
import { z } from 'zod';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  like,
  lte,
  sql,
  sum,
} from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  invoiceItems,
  invoicePayments,
  invoices,
  projects,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound, conflict, invalidState } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import {
  computeInvoiceTotals,
  deriveStatus,
  statusAfterPayment,
  type InvoiceBaseStatus,
} from '../lib/finance.js';

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth);
invoicesRouter.use(requireModuleRW('finance'));

const INVOICE_STATUSES = [
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'cancelled',
] as const;
const PAYMENT_METHODS = [
  'bank_transfer',
  'upi',
  'cash',
  'card',
  'cheque',
  'other',
] as const;

type AuthCtx = ReturnType<typeof getAuth>;

// ------------------------------------------------------------
//  Validation helpers — ensure related entities are in-agency.
// ------------------------------------------------------------
async function requireAgencyClient(ctx: AuthCtx, clientId: string) {
  const [row] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);
  if (!row) throw notFound('Client not found.');
  return row;
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
  return row;
}

/** Sum of recorded payments (paise) for an invoice. */
async function sumPayments(
  ctx: AuthCtx,
  invoiceId: string,
): Promise<number> {
  const [row] = await db
    .select({ paid: sum(invoicePayments.amount) })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.agencyId, ctx.agencyId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    );
  return Number(row?.paid ?? 0);
}

// ------------------------------------------------------------
//  Serializers
// ------------------------------------------------------------
type InvoiceRow = typeof invoices.$inferSelect;

/** Full invoice payload including money breakdown (all paise) + derived status. */
function serializeInvoice(
  inv: InvoiceRow,
  extras: {
    clientName: string | null;
    projectName: string | null;
    amountPaid: number;
  },
) {
  const amountDue = inv.total - extras.amountPaid;
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    clientId: inv.clientId,
    clientName: extras.clientName,
    projectId: inv.projectId,
    projectName: extras.projectName,
    status: deriveStatus(inv.status, inv.dueDate, amountDue),
    baseStatus: inv.status,
    issueDate: toIso(inv.issueDate),
    dueDate: toIso(inv.dueDate),
    isInterstate: inv.isInterstate,
    currency: inv.currency,
    // ---- money (paise) ----
    subtotal: inv.subtotal,
    taxTotal: inv.taxTotal,
    cgst: inv.cgst,
    sgst: inv.sgst,
    igst: inv.igst,
    total: inv.total,
    amountPaid: extras.amountPaid,
    amountDue,
    notes: inv.notes,
    terms: inv.terms,
    bankDetails: inv.bankDetails,
    createdBy: inv.createdBy,
    createdAt: toIso(inv.createdAt),
    updatedAt: toIso(inv.updatedAt),
  };
}

function serializeItem(it: typeof invoiceItems.$inferSelect) {
  return {
    id: it.id,
    invoiceId: it.invoiceId,
    description: it.description,
    quantity: it.quantity,
    unit: it.unit,
    rate: it.rate, // paise
    gstRate: it.gstRate,
    amount: it.amount, // paise
    position: it.position,
    createdAt: toIso(it.createdAt),
  };
}

function serializePayment(p: typeof invoicePayments.$inferSelect) {
  return {
    id: p.id,
    invoiceId: p.invoiceId,
    amount: p.amount, // paise
    paidAt: toIso(p.paidAt),
    method: p.method,
    reference: p.reference,
    notes: p.notes,
    recordedBy: p.recordedBy,
    createdAt: toIso(p.createdAt),
  };
}

/** Load an invoice scoped to the agency, or throw 404. */
async function getScopedInvoice(
  ctx: AuthCtx,
  invoiceId: string,
): Promise<InvoiceRow> {
  const [row] = await db
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)),
    )
    .limit(1);
  if (!row) throw notFound('Invoice not found.');
  return row;
}

/** Generate INV-<YYYY>-<NNNN> using the per-agency, per-year sequence. */
async function generateInvoiceNumber(
  ctx: AuthCtx,
  basis: Date,
): Promise<string> {
  const year = basis.getUTCFullYear();
  const start = Math.floor(Date.UTC(year, 0, 1) / 1000);
  const end = Math.floor(Date.UTC(year + 1, 0, 1) / 1000);
  // Sequence = count of this agency's invoices whose issueDate falls in the
  // year (or whose createdAt does, when not yet issued) + 1.
  const [row] = await db
    .select({ n: count() })
    .from(invoices)
    .where(
      and(
        eq(invoices.agencyId, ctx.agencyId),
        sql`coalesce(${invoices.issueDate}, ${invoices.createdAt}) >= ${start}`,
        sql`coalesce(${invoices.issueDate}, ${invoices.createdAt}) < ${end}`,
      ),
    );
  const seq = (row?.n ?? 0) + 1;
  return `INV-${year}-${String(seq).padStart(4, '0')}`;
}

// ============================================================
//  LIST
// ============================================================
const listQuery = z.object({
  status: z.enum(INVOICE_STATUSES).optional(),
  clientId: z.string().optional(),
  projectId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().optional(),
});

invoicesRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const q = listQuery.parse(req.query);

  const filters = [eq(invoices.agencyId, ctx.agencyId)];
  if (q.status) filters.push(eq(invoices.status, q.status));
  if (q.clientId) filters.push(eq(invoices.clientId, q.clientId));
  if (q.projectId) filters.push(eq(invoices.projectId, q.projectId));
  if (q.from) filters.push(gte(invoices.issueDate, q.from));
  if (q.to) filters.push(lte(invoices.issueDate, q.to));
  if (q.search && q.search.trim()) {
    filters.push(like(invoices.invoiceNumber, `%${q.search.trim()}%`));
  }

  const itemCountSq = sql<number>`(
    select count(*) from ${invoiceItems}
    where ${invoiceItems.invoiceId} = ${invoices.id}
  )`;
  const amountPaidSq = sql<number>`(
    select coalesce(sum(${invoicePayments.amount}), 0) from ${invoicePayments}
    where ${invoicePayments.invoiceId} = ${invoices.id}
  )`;

  const rows = await db
    .select({
      inv: invoices,
      clientName: clients.name,
      projectName: projects.name,
      itemCount: itemCountSq,
      amountPaid: amountPaidSq,
    })
    .from(invoices)
    .leftJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(projects, eq(projects.id, invoices.projectId))
    .where(and(...filters))
    .orderBy(desc(invoices.createdAt));

  ok(
    res,
    rows.map((r) => {
      const amountPaid = Number(r.amountPaid ?? 0);
      const base = serializeInvoice(r.inv, {
        clientName: r.clientName,
        projectName: r.projectName,
        amountPaid,
      });
      return { ...base, itemCount: Number(r.itemCount ?? 0) };
    }),
  );
});

// ============================================================
//  CREATE
// ============================================================
const itemInputSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive().default(1),
  unit: z.string().trim().max(40).optional(),
  rate: z.number().int().min(0).default(0), // paise
  gstRate: z.number().min(0).max(100).default(18),
});

const createSchema = z.object({
  clientId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  issueDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  isInterstate: z.boolean().optional(),
  currency: z.string().trim().max(8).optional(),
  notes: z.string().max(5000).optional(),
  terms: z.string().max(5000).optional(),
  bankDetails: z.string().max(2000).optional(),
  status: z.enum(['draft', 'sent']).default('draft'),
  items: z.array(itemInputSchema).default([]),
});

invoicesRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = createSchema.parse(req.body);

  await requireAgencyClient(ctx, body.clientId);
  if (body.projectId) await requireAgencyProject(ctx, body.projectId);

  const isInterstate = body.isInterstate ?? false;
  const normItems = body.items.map((it) => ({
    description: it.description,
    quantity: it.quantity,
    unit: it.unit ?? 'piece',
    rate: it.rate,
    gstRate: it.gstRate,
  }));
  const totals = computeInvoiceTotals(normItems, isInterstate);

  // When created as 'sent', stamp issueDate (if absent) and assign a number.
  const issueDate =
    body.issueDate ?? (body.status === 'sent' ? new Date() : null);
  const invoiceNumber =
    body.status === 'sent'
      ? await generateInvoiceNumber(ctx, issueDate ?? new Date())
      : null;

  const id = newId('inv');
  await db.insert(invoices).values({
    id,
    agencyId: ctx.agencyId,
    clientId: body.clientId,
    projectId: body.projectId ?? null,
    invoiceNumber,
    status: body.status,
    issueDate,
    dueDate: body.dueDate ?? null,
    isInterstate,
    ...(body.currency !== undefined ? { currency: body.currency } : {}),
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    cgst: totals.cgst,
    sgst: totals.sgst,
    igst: totals.igst,
    total: totals.total,
    notes: body.notes ?? null,
    terms: body.terms ?? null,
    bankDetails: body.bankDetails ?? null,
    createdBy: ctx.userId,
  });

  if (normItems.length) {
    await db.insert(invoiceItems).values(
      normItems.map((it, idx) => ({
        id: newId('ivi'),
        agencyId: ctx.agencyId,
        invoiceId: id,
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        rate: it.rate,
        gstRate: it.gstRate,
        amount: totals.lines[idx]!.amount,
        position: idx,
      })),
    );
  }

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.create',
    entityType: 'invoice',
    entityId: id,
    ip: req.ip,
  });

  created(res, await loadFullInvoice(ctx, id));
});

// ============================================================
//  DETAIL (full: items[] + payments[])
// ============================================================
async function loadFullInvoice(ctx: AuthCtx, invoiceId: string) {
  const [row] = await db
    .select({
      inv: invoices,
      clientName: clients.name,
      projectName: projects.name,
    })
    .from(invoices)
    .leftJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(projects, eq(projects.id, invoices.projectId))
    .where(
      and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)),
    )
    .limit(1);
  if (!row) throw notFound('Invoice not found.');

  const items = await db
    .select()
    .from(invoiceItems)
    .where(
      and(
        eq(invoiceItems.agencyId, ctx.agencyId),
        eq(invoiceItems.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(invoiceItems.position), asc(invoiceItems.createdAt));

  const payments = await db
    .select()
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.agencyId, ctx.agencyId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    )
    .orderBy(desc(invoicePayments.paidAt), desc(invoicePayments.createdAt));

  const amountPaid = payments.reduce((s, p) => s + p.amount, 0);

  return {
    ...serializeInvoice(row.inv, {
      clientName: row.clientName,
      projectName: row.projectName,
      amountPaid,
    }),
    items: items.map(serializeItem),
    payments: payments.map(serializePayment),
  };
}

invoicesRouter.get('/:id', async (req, res) => {
  const ctx = getAuth(req);
  ok(res, await loadFullInvoice(ctx, param(req, 'id')));
});

// ============================================================
//  UPDATE (replace items + fields, recompute totals)
// ============================================================
const updateSchema = z.object({
  clientId: z.string().min(1).optional(),
  projectId: z.string().min(1).nullable().optional(),
  issueDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  isInterstate: z.boolean().optional(),
  currency: z.string().trim().max(8).optional(),
  notes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(5000).nullable().optional(),
  bankDetails: z.string().max(2000).nullable().optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  items: z.array(itemInputSchema).optional(),
});

invoicesRouter.patch('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  const existing = await getScopedInvoice(ctx, invoiceId);
  const body = updateSchema.parse(req.body);

  if (body.clientId) await requireAgencyClient(ctx, body.clientId);
  if (body.projectId) await requireAgencyProject(ctx, body.projectId);

  const patch: Partial<typeof invoices.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.projectId !== undefined) patch.projectId = body.projectId;
  if (body.issueDate !== undefined) patch.issueDate = body.issueDate;
  if (body.dueDate !== undefined) patch.dueDate = body.dueDate;
  if (body.isInterstate !== undefined) patch.isInterstate = body.isInterstate;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.terms !== undefined) patch.terms = body.terms;
  if (body.bankDetails !== undefined) patch.bankDetails = body.bankDetails;
  if (body.status !== undefined) patch.status = body.status;

  // Recompute totals whenever items or the interstate flag change.
  const isInterstate = body.isInterstate ?? existing.isInterstate;
  let normItems: {
    description: string;
    quantity: number;
    unit: string;
    rate: number;
    gstRate: number;
  }[] | null = null;

  if (body.items !== undefined) {
    normItems = body.items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      unit: it.unit ?? 'piece',
      rate: it.rate,
      gstRate: it.gstRate,
    }));
    const totals = computeInvoiceTotals(normItems, isInterstate);
    patch.subtotal = totals.subtotal;
    patch.taxTotal = totals.taxTotal;
    patch.cgst = totals.cgst;
    patch.sgst = totals.sgst;
    patch.igst = totals.igst;
    patch.total = totals.total;

    await db
      .delete(invoiceItems)
      .where(
        and(
          eq(invoiceItems.agencyId, ctx.agencyId),
          eq(invoiceItems.invoiceId, invoiceId),
        ),
      );
    if (normItems.length) {
      await db.insert(invoiceItems).values(
        normItems.map((it, idx) => ({
          id: newId('ivi'),
          agencyId: ctx.agencyId,
          invoiceId,
          description: it.description,
          quantity: it.quantity,
          unit: it.unit,
          rate: it.rate,
          gstRate: it.gstRate,
          amount: totals.lines[idx]!.amount,
          position: idx,
        })),
      );
    }
  } else if (body.isInterstate !== undefined) {
    // Items unchanged but interstate flag flipped — re-split the same taxTotal.
    if (isInterstate) {
      patch.igst = existing.taxTotal;
      patch.cgst = 0;
      patch.sgst = 0;
    } else {
      const sgst = Math.round(existing.taxTotal / 2);
      patch.sgst = sgst;
      patch.cgst = existing.taxTotal - sgst;
      patch.igst = 0;
    }
  }

  await db
    .update(invoices)
    .set(patch)
    .where(
      and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.update',
    entityType: 'invoice',
    entityId: invoiceId,
    ip: req.ip,
  });

  ok(res, await loadFullInvoice(ctx, invoiceId));
});

// ============================================================
//  DELETE (items + payments cascade)
// ============================================================
invoicesRouter.delete('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  await getScopedInvoice(ctx, invoiceId);

  await db
    .delete(invoices)
    .where(
      and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.delete',
    entityType: 'invoice',
    entityId: invoiceId,
    ip: req.ip,
  });
  ok(res, { deleted: true });
});

// ============================================================
//  SEND (draft -> sent)
// ============================================================
invoicesRouter.post('/:id/send', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  const inv = await getScopedInvoice(ctx, invoiceId);

  if (inv.status === 'cancelled') {
    throw invalidState('Cannot send a cancelled invoice.');
  }
  if (inv.status !== 'draft') {
    throw invalidState('Only draft invoices can be sent.');
  }

  const issueDate = inv.issueDate ?? new Date();
  const invoiceNumber =
    inv.invoiceNumber ?? (await generateInvoiceNumber(ctx, issueDate));

  await db
    .update(invoices)
    .set({
      status: 'sent',
      issueDate,
      invoiceNumber,
      updatedAt: new Date(),
    })
    .where(
      and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.send',
    entityType: 'invoice',
    entityId: invoiceId,
    ip: req.ip,
  });

  ok(res, await loadFullInvoice(ctx, invoiceId));
});

// ============================================================
//  CANCEL (-> cancelled)
// ============================================================
invoicesRouter.post('/:id/cancel', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  const inv = await getScopedInvoice(ctx, invoiceId);

  if (inv.status === 'paid') {
    throw invalidState('Cannot cancel a fully paid invoice.');
  }

  await db
    .update(invoices)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(
      and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.cancel',
    entityType: 'invoice',
    entityId: invoiceId,
    ip: req.ip,
  });

  ok(res, await loadFullInvoice(ctx, invoiceId));
});

// ============================================================
//  PAYMENTS
// ============================================================

// GET /invoices/:id/payments
invoicesRouter.get('/:id/payments', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  await getScopedInvoice(ctx, invoiceId);

  const rows = await db
    .select()
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.agencyId, ctx.agencyId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    )
    .orderBy(desc(invoicePayments.paidAt), desc(invoicePayments.createdAt));

  ok(res, rows.map(serializePayment));
});

/** Recompute and persist the invoice's base status from current payments. */
async function reconcileInvoiceStatus(
  ctx: AuthCtx,
  inv: InvoiceRow,
): Promise<void> {
  const amountPaid = await sumPayments(ctx, inv.id);
  const wasIssued = inv.status !== 'draft' || inv.issueDate != null;
  const next = statusAfterPayment(
    inv.status as InvoiceBaseStatus,
    amountPaid,
    inv.total,
    wasIssued,
  );
  if (next !== inv.status) {
    await db
      .update(invoices)
      .set({ status: next, updatedAt: new Date() })
      .where(
        and(eq(invoices.id, inv.id), eq(invoices.agencyId, ctx.agencyId)),
      );
  }
}

// POST /invoices/:id/payments
const paymentSchema = z.object({
  amount: z.number().int().positive(), // paise
  paidAt: z.coerce.date().optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  reference: z.string().trim().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

invoicesRouter.post('/:id/payments', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  const inv = await getScopedInvoice(ctx, invoiceId);
  if (inv.status === 'cancelled') {
    throw conflict('Cannot record a payment on a cancelled invoice.');
  }
  const body = paymentSchema.parse(req.body);

  const paymentId = newId('ipy');
  await db.insert(invoicePayments).values({
    id: paymentId,
    agencyId: ctx.agencyId,
    invoiceId,
    amount: body.amount,
    paidAt: body.paidAt ?? new Date(),
    ...(body.method !== undefined ? { method: body.method } : {}),
    reference: body.reference ?? null,
    notes: body.notes ?? null,
    recordedBy: ctx.userId,
  });

  await reconcileInvoiceStatus(ctx, inv);

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.payment.create',
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: { paymentId, amount: body.amount },
    ip: req.ip,
  });

  created(res, await loadFullInvoice(ctx, invoiceId));
});

// DELETE /invoices/:id/payments/:paymentId
invoicesRouter.delete('/:id/payments/:paymentId', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  const inv = await getScopedInvoice(ctx, invoiceId);

  const result = await db
    .delete(invoicePayments)
    .where(
      and(
        eq(invoicePayments.id, param(req, 'paymentId')),
        eq(invoicePayments.agencyId, ctx.agencyId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    )
    .returning({ id: invoicePayments.id });
  if (!result.length) throw notFound('Payment not found.');

  await reconcileInvoiceStatus(ctx, inv);

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'invoice.payment.delete',
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: { paymentId: param(req, 'paymentId') },
    ip: req.ip,
  });

  ok(res, await loadFullInvoice(ctx, invoiceId));
});
