/**
 * Money tools: invoices, payments, expenses, finance rollups and the money /
 * content-queue dashboards. Every tool maps 1:1 onto a REST route:
 *   /invoices   (routes/invoices.ts)
 *   /expenses   (routes/expenses.ts)
 *   /finance    (routes/finance.ts)
 *   /dashboard  (routes/dashboard.ts)
 * Money inputs are rupees (`*Rupees`) converted to paise with `paise()`; every
 * amount in a result is INTEGER PAISE (divide by 100 for rupees).
 */
import { z } from 'zod';
import { defineTool, paise, seg, compact, id, isoDate, limit, type SanctumTool } from '../tool-kit.js';

// ------------------------------------------------------------------ helpers

const INVOICE_STATUS_FILTER = ['all', 'draft', 'sent', 'partially_paid', 'paid', 'cancelled'] as const;
const PAYMENT_METHODS = ['bank_transfer', 'upi', 'cash', 'card', 'cheque', 'other'] as const;
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
const EXPENSE_TYPES = ['one_time', 'monthly_recurring'] as const;

/** List responses come back either as a bare array or `{ items, total, ... }`. */
function unwrapList<T>(res: unknown): { items: T[]; total?: number } {
  if (Array.isArray(res)) return { items: res as T[] };
  const r = (res ?? {}) as { items?: unknown; total?: unknown };
  return {
    items: Array.isArray(r.items) ? (r.items as T[]) : [],
    total: typeof r.total === 'number' ? r.total : undefined,
  };
}

const clip = (s: string | null | undefined, n = 140): string | null =>
  s == null ? null : s.length > n ? `${s.slice(0, n)}…` : s;

interface InvoiceRow {
  id: string;
  invoiceNumber: string | null;
  clientId: string;
  clientName: string | null;
  projectId: string | null;
  projectName: string | null;
  status: string;
  rawStatus: string;
  issueDate: string | null;
  dueDate: string | null;
  currency: string;
  total: number;
  paidAmount: number;
  balanceDue: number;
}

interface ExpenseRow {
  id: string;
  category: string;
  expenseType: string;
  amount: number;
  description: string | null;
  projectId: string | null;
  projectName: string | null;
  clientId: string | null;
  clientName: string | null;
  expenseDate: string | null;
  gstDeductible: boolean;
  gstAmount: number | null;
  receiptUrl: string | null;
  loggedByName: string | null;
}

const lineItem = z.object({
  description: z.string().trim().min(1).max(300).describe('What is being billed, e.g. "Social media retainer – November"'),
  quantity: z.number().positive().optional().describe('Quantity (default 1; fractions allowed, e.g. 2.5 hours)'),
  unit: z.string().trim().max(40).optional().describe('Unit label (default "piece"), e.g. "month", "hour", "post"'),
  rateRupees: z.number().nonnegative().describe('Price per unit in rupees, BEFORE GST'),
  gstRate: z.number().min(0).max(100).optional().describe('GST percent for this line (default 18; use 0 for no GST)'),
});

type LineItemInput = z.infer<typeof lineItem>;

const toApiItems = (items: LineItemInput[]) =>
  items.map((it) =>
    compact({
      description: it.description,
      quantity: it.quantity,
      unit: it.unit,
      rate: paise(it.rateRupees),
      gstRate: it.gstRate,
    }),
  );

const ITEMS_NOTE =
  'Line totals, subtotal, GST (CGST+SGST when intra-state, IGST when isInterstate) and the grand total are computed by Sanctum from the items.';

// ------------------------------------------------------------------ tools

export const moneyTools: SanctumTool[] = [
  // ======================= INVOICES =======================
  defineTool({
    name: 'invoices_list',
    title: 'List invoices',
    description:
      'Lists invoices (newest issue date first) with client, status, due date, total, paid and balance due — amounts in paise. ' +
      'Filter by status, clientId (from clients_list), projectId, issue-date range, or search by invoice number / client name. ' +
      'Status "overdue" is shown when an unpaid invoice is past its due date; set overdueOnly to see just those. ' +
      'For totals ("how much is outstanding", "what did we invoice this month") prefer invoices_summary. Use invoices_get for line items and payments.',
    anyOf: ['invoices.view'],
    kind: 'read',
    input: {
      status: z
        .enum(INVOICE_STATUS_FILTER)
        .optional()
        .describe('Stored status filter (overdue invoices are stored as sent or partially_paid)'),
      overdueOnly: z.boolean().optional().describe('Only unpaid invoices past their due date'),
      clientId: id('Client (from clients_list)').optional(),
      projectId: id('Project').optional(),
      from: isoDate('Issued on or after').optional(),
      to: isoDate('Issued on or before (inclusive day)').optional(),
      search: z.string().optional().describe('Matches invoice number or client name'),
      limit: limit.describe('Max invoices to return (default 50)'),
      offset: z.number().int().min(0).optional().describe('Skip this many invoices (paging)'),
    },
    run: async ({ status, overdueOnly, clientId, projectId, from, to, search, limit: max, offset }, { api }) => {
      const pageSize = max ?? 50;
      const res = await api.get('/invoices', {
        status,
        clientId,
        projectId,
        from,
        to,
        search,
        // Overdue is derived per row, so fetch the whole filtered set and page here.
        limit: overdueOnly ? undefined : pageSize,
        offset: overdueOnly ? undefined : offset,
      });
      let { items, total } = unwrapList<InvoiceRow>(res);
      if (overdueOnly) {
        items = items.filter((r) => r.status === 'overdue');
        total = items.length;
        const start = offset ?? 0;
        items = items.slice(start, start + pageSize);
      }
      return {
        total: total ?? items.length,
        returned: items.length,
        amountsIn: 'paise',
        invoices: items.map((r) => ({
          id: r.id,
          invoiceNumber: r.invoiceNumber,
          clientId: r.clientId,
          clientName: r.clientName,
          projectName: r.projectName,
          status: r.status,
          issueDate: r.issueDate,
          dueDate: r.dueDate,
          currency: r.currency,
          total: r.total,
          paidAmount: r.paidAmount,
          balanceDue: r.balanceDue,
        })),
      };
    },
  }),

  defineTool({
    name: 'invoices_summary',
    title: 'Invoice totals',
    description:
      'Receivables KPIs across all invoices you can see (amounts in paise): totalInvoiced, collected, outstanding, overdueAmount, overdueCount, issuedCount, cancelledCount. ' +
      'Cancelled invoices are excluded from the money figures; drafts are included. Optional from/to filter by invoice issue date — e.g. from=2026-11-01, to=2026-11-30 answers "what did we invoice this month". ' +
      'Omit the range for all-time outstanding.',
    anyOf: ['invoices.view'],
    kind: 'read',
    input: {
      from: isoDate('Issued on or after').optional(),
      to: isoDate('Issued on or before (inclusive day)').optional(),
    },
    run: ({ from, to }, { api }) => api.get('/invoices/summary', { from, to }),
  }),

  defineTool({
    name: 'invoices_get',
    title: 'Get invoice details',
    description:
      'Full invoice: client, project, dates, GST split (cgst/sgst/igst), line items, recorded payments, paid amount, balance due, notes/terms/bank details, and what you may do with it (capabilities). ' +
      'All amounts (including item rate/amount and payment amount) are in paise. Find the id with invoices_list.',
    anyOf: ['invoices.view'],
    kind: 'read',
    input: { invoiceId: id('Invoice (from invoices_list)') },
    run: ({ invoiceId }, { api }) => api.get(`/invoices/${seg(invoiceId)}`),
  }),

  defineTool({
    name: 'invoices_create',
    title: 'Create an invoice',
    description:
      'Raises a new DRAFT invoice for a client with one or more line items (rates in rupees, before GST). ' +
      `${ITEMS_NOTE} The invoice number is generated automatically and issueDate defaults to today. ` +
      'Get clientId from clients_list (projectId is optional and must belong to that client). Nothing is emailed — use invoices_send to deliver it. ' +
      'If the agency has accounting sync enabled, the new invoice may also be mirrored there.',
    anyOf: ['invoices.create'],
    kind: 'write',
    input: {
      clientId: id('Client (from clients_list)'),
      projectId: id('Project (must belong to the client)').optional(),
      items: z.array(lineItem).min(1).describe('Line items (at least one)'),
      issueDate: isoDate('Issue date (default today)').optional(),
      dueDate: isoDate('Payment due date').optional(),
      isInterstate: z
        .boolean()
        .optional()
        .describe('true if the client is in a different state from the agency (IGST); default false (CGST+SGST)'),
      currency: z.string().trim().max(8).optional().describe('Currency code (default INR)'),
      notes: z.string().trim().max(2000).optional().describe('Notes shown on the invoice'),
      terms: z.string().trim().max(2000).optional().describe('Payment terms shown on the invoice'),
      bankDetails: z.string().trim().max(1000).optional().describe('Bank details for payment'),
    },
    run: ({ items, ...rest }, { api }) =>
      api.post('/invoices', compact({ ...rest, items: toApiItems(items) })),
  }),

  defineTool({
    name: 'invoices_update',
    title: 'Edit an invoice',
    description:
      'Edits an unpaid, uncancelled invoice. Only the fields you pass change; pass null to clear projectId, dueDate, notes, terms or bankDetails. ' +
      `Passing items REPLACES all existing line items (send the complete list; call invoices_get first to see the current ones). ${ITEMS_NOTE} ` +
      'The new total cannot drop below payments already recorded, and an invoice with payments cannot move to another client. ' +
      'Changing bank details is separately audited. Find the id with invoices_list; clientId comes from clients_list.',
    anyOf: ['invoices.update'],
    kind: 'write',
    input: {
      invoiceId: id('Invoice (from invoices_list)'),
      clientId: id('Client (from clients_list)').optional(),
      projectId: z.string().min(1).nullable().optional().describe('Project id, or null to unlink'),
      items: z.array(lineItem).min(1).optional().describe('Complete replacement list of line items'),
      issueDate: isoDate('Issue date').optional(),
      dueDate: isoDate('Due date').nullable().optional(),
      isInterstate: z.boolean().optional().describe('true = IGST, false = CGST+SGST (totals are recomputed)'),
      currency: z.string().trim().max(8).optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
      terms: z.string().trim().max(2000).nullable().optional(),
      bankDetails: z.string().trim().max(1000).nullable().optional(),
    },
    run: ({ invoiceId, items, ...rest }, { api }) =>
      api.patch(
        `/invoices/${seg(invoiceId)}`,
        compact({ ...rest, items: items ? toApiItems(items) : undefined }),
      ),
  }),

  defineTool({
    name: 'invoices_record_payment',
    title: 'Record an invoice payment',
    description:
      'Records a payment received against an invoice (amount in rupees). The invoice status updates automatically to partially_paid or paid. ' +
      'Fails if the amount exceeds the balance due, the invoice is already paid or cancelled, or the date is in the future. ' +
      'Find the id (and current balanceDue, in paise) with invoices_list or invoices_get. Sends no email.',
    anyOf: ['invoices.record_payment'],
    kind: 'write',
    input: {
      invoiceId: id('Invoice (from invoices_list)'),
      amountRupees: z.number().positive().describe('Amount received, in rupees'),
      paidAt: isoDate('Date the payment was received (default now)').optional(),
      method: z.enum(PAYMENT_METHODS).optional().describe('Payment method (default bank_transfer)'),
      reference: z.string().trim().max(120).optional().describe('UTR / cheque no. / transaction reference'),
      notes: z.string().trim().max(500).optional(),
    },
    run: ({ invoiceId, amountRupees, ...rest }, { api }) =>
      api.post(`/invoices/${seg(invoiceId)}/payments`, compact({ amount: paise(amountRupees), ...rest })),
  }),

  defineTool({
    name: 'invoices_change_status',
    title: 'Change invoice status',
    description:
      'Moves an invoice through its lifecycle without emailing anyone: draft → sent (mark as sent manually), sent → draft (only if no payments), or sent/partially_paid → paid. ' +
      'Marking paid requires recorded payments to cover the total — prefer invoices_record_payment; otherwise pass override=true with a reason (audited). ' +
      'Paid and cancelled invoices cannot change. To cancel use invoices_cancel; to email the client use invoices_send. Find the id with invoices_list.',
    anyOf: ['invoices.change_status'],
    kind: 'write',
    input: {
      invoiceId: id('Invoice (from invoices_list)'),
      status: z.enum(['draft', 'sent', 'paid']).describe('New status'),
      override: z.boolean().optional().describe('Mark paid even though payments do not cover the total'),
      reason: z.string().trim().max(500).optional().describe('Why (recorded when overriding)'),
    },
    run: ({ invoiceId, ...body }, { api }) => api.patch(`/invoices/${seg(invoiceId)}/status`, compact(body)),
  }),

  defineTool({
    name: 'invoices_cancel',
    title: 'Cancel an invoice',
    description:
      'Cancels an invoice. This cannot be undone — a cancelled invoice can never be reopened, edited or paid, and drops out of receivables. ' +
      'Not allowed once any payment has been recorded. Confirm with the person first. Find the id with invoices_list.',
    anyOf: ['invoices.change_status'],
    kind: 'delete',
    input: { invoiceId: id('Invoice (from invoices_list)') },
    run: ({ invoiceId }, { api }) => api.patch(`/invoices/${seg(invoiceId)}/status`, { status: 'cancelled' }),
  }),

  defineTool({
    name: 'invoices_send',
    title: 'Send an invoice to the client',
    description:
      'Emails the client that the invoice is ready to view in their client portal, and marks a draft invoice as sent. ' +
      'SIDE EFFECTS: sends a real email to recipientEmail; if that address has no portal login for this client yet, one is created and its sign-in details are emailed (this also needs the permission to manage the client portal). ' +
      'Cancelled invoices cannot be sent. Find the id with invoices_list; the client contact email is in clients_get / clients_list.',
    anyOf: ['invoices.send'],
    kind: 'write',
    input: {
      invoiceId: id('Invoice (from invoices_list)'),
      recipientEmail: z.string().email().describe('Client email address to send to'),
      message: z.string().max(2000).optional().describe('Short personal note included in the email'),
    },
    run: ({ invoiceId, ...body }, { api }) => api.post(`/invoices/${seg(invoiceId)}/send`, compact(body)),
  }),

  // ======================= EXPENSES =======================
  defineTool({
    name: 'expenses_list',
    title: 'List expenses',
    description:
      'Lists logged expenses (newest first) with date, category, type, amount, GST and linked client/project — amounts in paise. ' +
      'Filter by category, clientId (from clients_list), projectId, date range (expense date, inclusive) or search the description. ' +
      'Also returns count and totalAmount (paise) across ALL matching expenses, so it answers "how much did we spend on X this month". Use expenses_get for one expense.',
    anyOf: ['expenses.view'],
    kind: 'read',
    input: {
      category: z.enum(EXPENSE_CATEGORIES).optional(),
      clientId: id('Client (from clients_list)').optional(),
      projectId: id('Project').optional(),
      from: isoDate('Expense date on or after').optional(),
      to: isoDate('Expense date on or before (inclusive day)').optional(),
      search: z.string().optional().describe('Text to find in the description or category'),
      limit: limit.describe('Max expenses to list (default 50; totals still cover all matches)'),
    },
    run: async ({ limit: max, ...query }, { api }) => {
      const { items } = unwrapList<ExpenseRow>(await api.get('/expenses', query));
      const totalAmount = items.reduce((a, e) => a + Number(e.amount ?? 0), 0);
      const gstTotal = items.reduce((a, e) => a + Number(e.gstAmount ?? 0), 0);
      const shown = items.slice(0, max ?? 50);
      return {
        count: items.length,
        totalAmount,
        gstTotal,
        returned: shown.length,
        amountsIn: 'paise',
        expenses: shown.map((e) => ({
          id: e.id,
          expenseDate: e.expenseDate,
          category: e.category,
          expenseType: e.expenseType,
          amount: e.amount,
          gstAmount: e.gstAmount,
          description: clip(e.description),
          clientName: e.clientName,
          projectName: e.projectName,
          loggedByName: e.loggedByName,
        })),
      };
    },
  }),

  defineTool({
    name: 'expenses_get',
    title: 'Get expense details',
    description:
      'Full details of one expense (amount and gstAmount in paise, full description, receipt URL, linked client/project, who logged it, and what you may do with it). Find the id with expenses_list.',
    anyOf: ['expenses.view'],
    kind: 'read',
    input: { expenseId: id('Expense (from expenses_list)') },
    run: ({ expenseId }, { api }) => api.get(`/expenses/${seg(expenseId)}`),
  }),

  defineTool({
    name: 'expenses_create',
    title: 'Log an expense',
    description:
      'Logs an agency expense (amount in rupees). expenseType monthly_recurring is for subscriptions/rent that repeat every month — finance reports count it in every month. ' +
      'Optionally link it to a client (clientId from clients_list) or project. expenseDate defaults to today. Receipts can only be linked by URL (no file upload).',
    anyOf: ['expenses.create'],
    kind: 'write',
    input: {
      amountRupees: z.number().nonnegative().describe('Expense amount in rupees'),
      category: z.enum(EXPENSE_CATEGORIES).optional().describe('Category (default other)'),
      expenseType: z.enum(EXPENSE_TYPES).optional().describe('one_time (default) or monthly_recurring'),
      description: z.string().max(2000).optional(),
      expenseDate: isoDate('Date of the expense (default today)').optional(),
      clientId: id('Client (from clients_list)').optional(),
      projectId: id('Project').optional(),
      gstDeductible: z.boolean().optional().describe('Whether GST on this expense can be claimed as input credit'),
      gstAmountRupees: z.number().nonnegative().optional().describe('GST portion in rupees, if known'),
      receiptUrl: z.string().url().max(1000).optional().describe('Link to the receipt'),
    },
    run: ({ amountRupees, gstAmountRupees, ...rest }, { api }) =>
      api.post(
        '/expenses',
        compact({ ...rest, amount: paise(amountRupees), gstAmount: paise(gstAmountRupees) }),
      ),
  }),

  defineTool({
    name: 'expenses_update',
    title: 'Edit an expense',
    description:
      'Changes an expense. Only the fields you pass change; pass null to clear description, clientId, projectId, receiptUrl or gstAmountRupees. Amounts in rupees. Find the id with expenses_list.',
    anyOf: ['expenses.update'],
    kind: 'write',
    input: {
      expenseId: id('Expense (from expenses_list)'),
      amountRupees: z.number().nonnegative().optional().describe('New amount in rupees'),
      category: z.enum(EXPENSE_CATEGORIES).optional(),
      expenseType: z.enum(EXPENSE_TYPES).optional(),
      description: z.string().max(2000).nullable().optional(),
      expenseDate: isoDate('Date of the expense').optional(),
      clientId: z.string().min(1).nullable().optional().describe('Client id (from clients_list), or null to unlink'),
      projectId: z.string().min(1).nullable().optional().describe('Project id, or null to unlink'),
      gstDeductible: z.boolean().optional(),
      gstAmountRupees: z.number().nonnegative().nullable().optional().describe('GST portion in rupees, or null to clear'),
      receiptUrl: z.string().url().max(1000).nullable().optional(),
    },
    run: ({ expenseId, amountRupees, gstAmountRupees, ...rest }, { api }) =>
      api.patch(
        `/expenses/${seg(expenseId)}`,
        compact({ ...rest, amount: paise(amountRupees), gstAmount: paise(gstAmountRupees) }),
      ),
  }),

  defineTool({
    name: 'expenses_delete',
    title: 'Delete an expense',
    description: 'Permanently deletes an expense. This cannot be undone. Find the id with expenses_list.',
    anyOf: ['expenses.delete'],
    kind: 'delete',
    input: { expenseId: id('Expense (from expenses_list)') },
    run: ({ expenseId }, { api }) => api.delete(`/expenses/${seg(expenseId)}`),
  }),

  // ======================= FINANCE =======================
  defineTool({
    name: 'finance_owner_snapshot',
    title: 'Owner money snapshot',
    description:
      'Money at a glance (all amounts in paise). Monthly view: monthlyRevenue = projected project revenue this month (retainer fees + one-time contract values spread over the project duration), split into recurringRevenue and oneTimeMonthly; monthlyExpenses (this month\'s one-time + all recurring); monthlyPayroll and monthlyNet (null without permission to view compensation). ' +
      'Cash view (all time, cancelled invoices excluded): billed, collected, outstanding, expenses, netCash, invoiceCount, overdueCount. Also headcount, salaries (if permitted), recentInvoices and recentExpenses. ' +
      'Use for "project revenue this month" and "how are we doing".',
    anyOf: ['finance.view_overview'],
    kind: 'read',
    input: {},
    run: (_args, { api }) => api.get('/finance/owner-snapshot'),
  }),

  defineTool({
    name: 'finance_overview',
    title: 'Expense overview for a period',
    description:
      'Expense breakdown for a date range (by expense date): total expenses and expensesByCategory, amounts in paise. Defaults to the current Indian financial year (1 Apr – 31 Mar) when from/to are omitted. ' +
      'Note: netProfit here is just −expenses (no revenue term) — for revenue use finance_owner_snapshot, dashboard_money or invoices_summary.',
    anyOf: ['finance.view_overview'],
    kind: 'read',
    input: {
      from: isoDate('Range start').optional(),
      to: isoDate('Range end').optional(),
    },
    run: ({ from, to }, { api }) => api.get('/finance/overview', { from, to }),
  }),

  defineTool({
    name: 'finance_client',
    title: "A client's financials",
    description:
      "One client's all-time money rollup (paise): invoiceCount, billed, paid, outstanding (cancelled invoices excluded), expenses logged against the client, and dealPipelineValue (null without permission to see deal values). " +
      'Needs both finance-report and client-financials access. Get clientId from clients_list.',
    anyOf: ['finance.view_reports'],
    allOf: ['clients.view_financials'],
    kind: 'read',
    input: { clientId: id('Client (from clients_list)') },
    run: ({ clientId }, { api }) => api.get(`/finance/clients/${seg(clientId)}`),
  }),

  // ======================= DASHBOARD =======================
  defineTool({
    name: 'dashboard_money',
    title: 'Money trend dashboard',
    description:
      'Six-month money trend (amounts in paise, months bucketed in IST): per month invoiced (issued, non-draft, non-cancelled), collected (payments received) and expenses; ' +
      'thisMonth and lastMonth with net (collected − expenses − payroll); payroll (null without compensation access); outstanding and overdue receivables with the 5 most overdue invoices. ' +
      'Good for "what did we collect this month vs last month".',
    anyOf: ['finance.view_overview'],
    kind: 'read',
    input: {},
    run: (_args, { api }) => api.get('/dashboard/money'),
  }),

  defineTool({
    name: 'dashboard_content_queue',
    title: 'Content approval queue',
    description:
      'Content posts waiting on clients: awaitingClient (pending client approval) and changesRequested (sent back by the client), with counts, caption preview and how many days each has waited. ' +
      'Covers every client you can see; set mine=true for only posts you created.',
    anyOf: ['posts.view'],
    kind: 'read',
    input: {
      mine: z.boolean().optional().describe('Only posts created by me'),
    },
    run: ({ mine }, { api }) => api.get('/dashboard/content-queue', { mine: mine ? 'true' : undefined }),
  }),
];
