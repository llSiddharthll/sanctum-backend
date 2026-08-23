import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sum } from 'drizzle-orm';
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
import { notFound } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth, requireClientAccess } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import {
  mintClientPortalLogin,
  sendClientPortalLoginEmail,
} from '../lib/client-portal-login.js';

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

// ---- LIST INVOICES ----
invoicesRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = req.query.clientId as string | undefined;
  const projectId = req.query.projectId as string | undefined;

  const filters = [eq(invoices.agencyId, ctx.agencyId)];
  if (clientId) filters.push(eq(invoices.clientId, clientId));
  if (projectId) filters.push(eq(invoices.projectId, projectId));

  const rows = await db
    .select(invoiceSelection)
    .from(invoices)
    .leftJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(projects, eq(projects.id, invoices.projectId))
    .leftJoin(users, eq(users.id, invoices.createdBy))
    .where(and(...filters))
    .orderBy(desc(invoices.createdAt));

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
  );
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

// ---- UPDATE STATUS ----
invoicesRouter.patch('/:id/status', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  const body = z.object({ status: z.enum(['draft', 'sent', 'cancelled', 'paid']) }).parse(req.body);

  await db
    .update(invoices)
    .set({ status: body.status, updatedAt: new Date() })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.agencyId, ctx.agencyId)));

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
