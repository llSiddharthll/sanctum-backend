/**
 * Additive finance dummy-data seeder.
 *
 * Unlike `seed.ts` this NEVER deletes: it appends expenses, invoices, invoice
 * items and payments to whatever agency already exists, so it can be run on a
 * seeded local DB to give the finance module a fuller dataset (a year of
 * spend, every invoice status, every payment method).
 *
 * Money is INTEGER PAISE throughout, matching the schema.
 *   pnpm exec tsx src/seed-finance.ts
 */
import { db, ensurePragmas } from './db/client.js';
import {
  agencies,
  clients,
  projects,
  users,
  expenses,
  invoices,
  invoiceItems,
  invoicePayments,
} from './db/schema.js';
import { newId } from './lib/ids.js';
import { eq, desc } from 'drizzle-orm';

/** Rupees -> integer paise. */
const inr = (rupees: number): number => Math.round(rupees * 100);

const TODAY = new Date();

/** A UTC instant `offsetDays` from today at the given hour. */
function at(offsetDays: number, hour = 11): Date {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

type ExpCategory =
  | 'software'
  | 'salaries'
  | 'marketing'
  | 'travel'
  | 'office'
  | 'equipment'
  | 'contractor'
  | 'taxes'
  | 'utilities'
  | 'other';
type ExpType = 'one_time' | 'monthly_recurring';
type InvStatus = 'draft' | 'sent' | 'partially_paid' | 'paid' | 'cancelled';
type PayMethod = 'bank_transfer' | 'upi' | 'cash' | 'card' | 'cheque' | 'other';

async function main(): Promise<void> {
  await ensurePragmas();

  // ---- Resolve the existing agency / people / clients / projects ----------
  const [agency] = await db.select().from(agencies).limit(1);
  if (!agency) throw new Error('No agency found - run `pnpm db:seed` first.');
  const agencyId = agency.id;

  const staff = await db
    .select()
    .from(users)
    .where(eq(users.agencyId, agencyId));
  const actor =
    staff.find((u) => u.role === 'admin') ??
    staff.find((u) => u.role === 'owner') ??
    staff[0];
  if (!actor) throw new Error('No users found for this agency.');

  const clientRows = await db
    .select()
    .from(clients)
    .where(eq(clients.agencyId, agencyId));
  if (clientRows.length === 0) {
    throw new Error('No clients found - run `pnpm db:seed` first.');
  }

  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.agencyId, agencyId));
  const projectsFor = (clientId: string) =>
    projectRows.filter((p) => p.clientId === clientId);

  // Round-robin over whatever client rows actually exist.
  const pickClient = (i: number) => clientRows[i % clientRows.length]!;

  // ---- 1. EXPENSES -------------------------------------------------------
  // Recurring SaaS / rent / payroll replayed monthly, plus lumpy one-offs.
  console.log('Appending expenses...');

  const expenseRows: Array<typeof expenses.$inferInsert> = [];
  const addExpense = (o: {
    category: ExpCategory;
    amount: number;
    description: string;
    offset: number;
    expenseType?: ExpType;
    gstDeductible?: boolean;
    clientIdx?: number;
    withProject?: boolean;
  }) => {
    const gstDeductible = o.gstDeductible ?? false;
    let clientId: string | null = null;
    let projectId: string | null = null;
    if (o.clientIdx !== undefined) {
      const c = pickClient(o.clientIdx);
      clientId = c.id;
      if (o.withProject) projectId = projectsFor(c.id)[0]?.id ?? null;
    }
    expenseRows.push({
      id: newId('exp'),
      agencyId,
      projectId,
      clientId,
      category: o.category,
      expenseType: o.expenseType ?? 'one_time',
      amount: o.amount,
      description: o.description,
      expenseDate: at(o.offset, 12),
      gstDeductible,
      // GST component embedded in a tax-inclusive amount at 18%.
      gstAmount: gstDeductible ? Math.round(o.amount - o.amount / 1.18) : null,
      loggedBy: actor.id,
      createdAt: at(o.offset, 12),
      updatedAt: at(o.offset, 12),
    });
  };

  const recurring: Array<{
    category: ExpCategory;
    amount: number;
    description: string;
  }> = [
    { category: 'software', amount: inr(4899), description: 'Adobe Creative Cloud - team' },
    { category: 'software', amount: inr(2499), description: 'Figma team seats' },
    { category: 'software', amount: inr(1180), description: 'Google Workspace' },
    { category: 'office', amount: inr(34000), description: 'Coworking office rent' },
    { category: 'utilities', amount: inr(2360), description: 'Internet + phone' },
    { category: 'salaries', amount: inr(485000), description: 'Monthly payroll' },
  ];
  for (let m = 1; m <= 6; m++) {
    for (const r of recurring) {
      addExpense({
        ...r,
        offset: -30 * m,
        expenseType: 'monthly_recurring',
        gstDeductible: r.category !== 'salaries',
      });
    }
  }

  const oneOffs: Array<{
    category: ExpCategory;
    amount: number;
    description: string;
    offset: number;
    gstDeductible?: boolean;
    clientIdx?: number;
    withProject?: boolean;
  }> = [
    { category: 'marketing', amount: inr(42000), description: 'Meta ads - Q3 brand campaign', offset: -8, gstDeductible: true, clientIdx: 0, withProject: true },
    { category: 'marketing', amount: inr(18500), description: 'Google Ads - lead gen', offset: -21, gstDeductible: true, clientIdx: 1, withProject: true },
    { category: 'marketing', amount: inr(9500), description: 'Influencer collaboration fee', offset: -47, gstDeductible: false, clientIdx: 2 },
    { category: 'contractor', amount: inr(35000), description: 'Freelance motion designer - 2 reels', offset: -12, gstDeductible: true, clientIdx: 0, withProject: true },
    { category: 'contractor', amount: inr(22000), description: 'Freelance copywriter - website', offset: -33, gstDeductible: false, clientIdx: 1 },
    { category: 'contractor', amount: inr(15000), description: 'Product photographer - half day', offset: -63, gstDeductible: false, clientIdx: 2, withProject: true },
    { category: 'equipment', amount: inr(184000), description: 'MacBook Pro M4 - design lead', offset: -74, gstDeductible: true },
    { category: 'equipment', amount: inr(28500), description: 'Sony 24-70mm lens', offset: -119, gstDeductible: true },
    { category: 'equipment', amount: inr(12400), description: 'Studio lighting kit', offset: -152, gstDeductible: true },
    { category: 'travel', amount: inr(18600), description: 'Client pitch - Mumbai (flights + stay)', offset: -26, gstDeductible: true, clientIdx: 0 },
    { category: 'travel', amount: inr(4200), description: 'Cab - client workshop', offset: -5, gstDeductible: false, clientIdx: 1 },
    { category: 'travel', amount: inr(9800), description: 'Team offsite travel', offset: -88, gstDeductible: true },
    { category: 'office', amount: inr(7600), description: 'Office furniture - 2 desks', offset: -101, gstDeductible: true },
    { category: 'office', amount: inr(3150), description: 'Pantry + supplies restock', offset: -16, gstDeductible: true },
    { category: 'taxes', amount: inr(96000), description: 'Advance tax - Q2 instalment', offset: -40, gstDeductible: false },
    { category: 'taxes', amount: inr(52000), description: 'GST payment - monthly filing', offset: -11, gstDeductible: false },
    { category: 'taxes', amount: inr(14500), description: 'CA retainer - annual filing', offset: -134, gstDeductible: true },
    { category: 'software', amount: inr(66000), description: 'Refrens annual plan', offset: -57, gstDeductible: true },
    { category: 'software', amount: inr(23600), description: 'Semrush - 6 month prepay', offset: -95, gstDeductible: true },
    { category: 'utilities', amount: inr(6800), description: 'Electricity - quarterly true-up', offset: -68, gstDeductible: true },
    { category: 'other', amount: inr(11000), description: 'Diwali client gifting', offset: -145, gstDeductible: false },
    { category: 'other', amount: inr(5400), description: 'Team lunch - project wrap', offset: -3, gstDeductible: false },
  ];
  for (const o of oneOffs) addExpense(o);

  await db.insert(expenses).values(expenseRows);

  // ---- 2. INVOICES + ITEMS + PAYMENTS ------------------------------------
  console.log('Appending invoices...');

  // Continue the invoice-number series past whatever already exists, so the
  // (agency_id, invoice_number) unique index never collides.
  const existing = await db
    .select({ n: invoices.invoiceNumber })
    .from(invoices)
    .where(eq(invoices.agencyId, agencyId))
    .orderBy(desc(invoices.invoiceNumber));
  let seq = 100;
  for (const r of existing) {
    const m = /(\d+)\s*$/.exec(r.n ?? '');
    if (m) seq = Math.max(seq, Number(m[1]));
  }

  let invCount = 0;
  let itemCount = 0;
  let payCount = 0;

  async function insertInvoice(o: {
    clientId: string;
    projectId?: string | null;
    status: InvStatus;
    issueOffset: number;
    dueOffset: number;
    isInterstate?: boolean;
    items: Array<{ description: string; quantity: number; rate: number }>;
    /** Fraction of total collected: 1 = fully paid, 0.4 = part paid. */
    payFraction?: number;
    method?: PayMethod;
    payOffset?: number;
  }): Promise<void> {
    const invId = newId('inv');
    seq += 1;
    const number = `INV-2026-${String(seq).padStart(3, '0')}`;

    let subtotal = 0;
    const itemRows = o.items.map((it, i) => {
      const amount = Math.round(it.quantity * it.rate);
      subtotal += amount;
      return {
        id: newId('ini'),
        agencyId,
        invoiceId: invId,
        description: it.description,
        quantity: it.quantity,
        unit: 'piece',
        rate: it.rate,
        gstRate: 18,
        amount,
        position: i,
      };
    });

    const taxTotal = Math.round(subtotal * 0.18);
    const isInterstate = o.isInterstate ?? false;
    // Interstate supply attracts IGST; intrastate splits into CGST + SGST.
    const igst = isInterstate ? taxTotal : 0;
    const cgst = isInterstate ? 0 : Math.round(taxTotal / 2);
    const sgst = isInterstate ? 0 : taxTotal - cgst;
    const total = subtotal + taxTotal;

    await db.insert(invoices).values({
      id: invId,
      agencyId,
      clientId: o.clientId,
      projectId: o.projectId ?? null,
      invoiceNumber: number,
      status: o.status,
      issueDate: at(o.issueOffset, 10),
      dueDate: at(o.dueOffset, 10),
      isInterstate,
      currency: 'INR',
      subtotal,
      taxTotal,
      cgst,
      sgst,
      igst,
      total,
      notes: 'Thank you for your business.',
      terms: 'Payment due within the stated period.',
      bankDetails: 'Sanctum Studio | HDFC Bank | A/C 50100XXXXXX | IFSC HDFC0000123',
      createdBy: actor.id,
      createdAt: at(o.issueOffset, 10),
      updatedAt: at(o.issueOffset, 10),
    });
    await db.insert(invoiceItems).values(itemRows);
    invCount += 1;
    itemCount += itemRows.length;

    if (o.payFraction && o.payFraction > 0) {
      // A 'paid' invoice must reconcile exactly; partials round to the rupee.
      const amount =
        o.payFraction >= 1
          ? total
          : Math.round((total * o.payFraction) / 100) * 100;
      const method = o.method ?? 'bank_transfer';
      await db.insert(invoicePayments).values({
        id: newId('pay'),
        agencyId,
        invoiceId: invId,
        amount,
        paidAt: at(o.payOffset ?? o.issueOffset + 9, 12),
        method,
        reference: `${method.toUpperCase()}-${String(seq).padStart(3, '0')}${Math.floor(Math.random() * 9000 + 1000)}`,
        recordedBy: actor.id,
        createdAt: at(o.payOffset ?? o.issueOffset + 9, 12),
      });
      payCount += 1;
    }
  }

  const c0 = pickClient(0);
  const c1 = pickClient(1);
  const c2 = pickClient(2);
  const c3 = pickClient(3);

  // Paid history - one retainer per month, cycling clients & payment methods.
  const months = ['March', 'April', 'May', 'June', 'July', 'August'];
  const methods: PayMethod[] = [
    'bank_transfer',
    'upi',
    'cheque',
    'card',
    'bank_transfer',
    'upi',
  ];
  for (let i = 0; i < months.length; i++) {
    const c = pickClient(i);
    await insertInvoice({
      clientId: c.id,
      projectId: projectsFor(c.id)[0]?.id ?? null,
      status: 'paid',
      issueOffset: -30 * (months.length - i) - 4,
      dueOffset: -30 * (months.length - i) + 11,
      items: [
        {
          description: `Monthly social media retainer - ${months[i]}`,
          quantity: 1,
          rate: inr(45000 + i * 5000),
        },
      ],
      payFraction: 1,
      method: methods[i],
      payOffset: -30 * (months.length - i) + 6,
    });
  }

  // Larger project invoices across the remaining statuses.
  await insertInvoice({
    clientId: c0.id,
    projectId: projectsFor(c0.id)[0]?.id ?? null,
    status: 'paid',
    issueOffset: -52,
    dueOffset: -37,
    items: [
      { description: 'Brand identity system - logo, type, palette', quantity: 1, rate: inr(145000) },
      { description: 'Brand guidelines document', quantity: 1, rate: inr(35000) },
    ],
    payFraction: 1,
    method: 'bank_transfer',
    payOffset: -39,
  });

  await insertInvoice({
    clientId: c1.id,
    projectId: projectsFor(c1.id)[0]?.id ?? null,
    status: 'partially_paid',
    issueOffset: -24,
    dueOffset: 6,
    items: [
      { description: 'Website design & build - 8 pages', quantity: 1, rate: inr(220000) },
      { description: 'Copywriting - full site', quantity: 1, rate: inr(45000) },
    ],
    payFraction: 0.4,
    method: 'bank_transfer',
    payOffset: -14,
  });

  await insertInvoice({
    clientId: c2.id,
    projectId: projectsFor(c2.id)[0]?.id ?? null,
    status: 'partially_paid',
    issueOffset: -16,
    dueOffset: 14,
    items: [
      { description: 'Video production - 3 brand films', quantity: 3, rate: inr(65000) },
      { description: 'Post-production & colour grade', quantity: 1, rate: inr(40000) },
    ],
    payFraction: 0.5,
    method: 'upi',
    payOffset: -6,
  });

  // Overdue: 'sent' with a due date in the past ('overdue' is derived, never stored).
  await insertInvoice({
    clientId: c3.id,
    projectId: projectsFor(c3.id)[0]?.id ?? null,
    status: 'sent',
    issueOffset: -58,
    dueOffset: -28,
    items: [
      { description: 'Performance marketing retainer - July', quantity: 1, rate: inr(75000) },
    ],
  });
  await insertInvoice({
    clientId: c1.id,
    status: 'sent',
    issueOffset: -44,
    dueOffset: -14,
    isInterstate: true,
    items: [
      { description: 'SEO audit & technical fixes', quantity: 1, rate: inr(85000) },
      { description: 'Content strategy workshop', quantity: 1, rate: inr(30000) },
    ],
  });

  // Current, not yet due.
  await insertInvoice({
    clientId: c0.id,
    projectId: projectsFor(c0.id)[0]?.id ?? null,
    status: 'sent',
    issueOffset: -6,
    dueOffset: 24,
    items: [
      { description: 'Monthly social media retainer - September', quantity: 1, rate: inr(70000) },
      { description: 'Additional reel production', quantity: 4, rate: inr(12000) },
    ],
  });
  await insertInvoice({
    clientId: c2.id,
    status: 'sent',
    issueOffset: -2,
    dueOffset: 28,
    isInterstate: true,
    items: [{ description: 'Packaging design - 6 SKUs', quantity: 6, rate: inr(18000) }],
  });

  // Drafts.
  await insertInvoice({
    clientId: c3.id,
    projectId: projectsFor(c3.id)[0]?.id ?? null,
    status: 'draft',
    issueOffset: 0,
    dueOffset: 30,
    items: [
      { description: 'Q4 campaign - creative retainer', quantity: 1, rate: inr(160000) },
      { description: 'Media planning', quantity: 1, rate: inr(40000) },
    ],
  });
  await insertInvoice({
    clientId: c1.id,
    status: 'draft',
    issueOffset: 0,
    dueOffset: 45,
    items: [
      { description: 'Annual brand retainer - proposal draft', quantity: 12, rate: inr(55000) },
    ],
  });

  // Cancelled.
  await insertInvoice({
    clientId: c2.id,
    status: 'cancelled',
    issueOffset: -71,
    dueOffset: -41,
    items: [
      { description: 'Event coverage - cancelled by client', quantity: 1, rate: inr(48000) },
    ],
  });

  // ---- Summary -----------------------------------------------------------
  const allInv = await db
    .select()
    .from(invoices)
    .where(eq(invoices.agencyId, agencyId));
  const allExp = await db
    .select()
    .from(expenses)
    .where(eq(expenses.agencyId, agencyId));
  const allPay = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.agencyId, agencyId));

  const rupees = (paise: number) =>
    'INR ' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const billed = sum(
    allInv
      .filter((i) => i.status !== 'draft' && i.status !== 'cancelled')
      .map((i) => i.total),
  );
  const collected = sum(allPay.map((p) => p.amount));
  const spent = sum(allExp.map((e) => e.amount));

  const byStatus = allInv.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log('\n===================== FINANCE DUMMY DATA =====================');
  console.log(
    `Added this run:  ${invCount} invoices, ${itemCount} line items, ${payCount} payments, ${expenseRows.length} expenses`,
  );
  console.log('\nAgency totals now:');
  console.log(
    `  invoices          ${allInv.length}   (${Object.entries(byStatus)
      .map(([k, v]) => `${k}:${v}`)
      .join('  ')})`,
  );
  console.log(`  expenses          ${allExp.length}`);
  console.log(`  payments          ${allPay.length}`);
  console.log(`  billed (ex-draft) ${rupees(billed)}`);
  console.log(`  collected         ${rupees(collected)}`);
  console.log(`  outstanding       ${rupees(billed - collected)}`);
  console.log(`  total spend       ${rupees(spent)}`);
  console.log('==============================================================\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
