import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { BASE, signupAgency, data, type Agent } from './helpers';
import { db } from '../src/db/client.js';
import { clients, invoiceItems, invoicePayments, invoices } from '../src/db/schema.js';
import { env } from '../src/env.js';
import {
  mapPaymentMethod,
  mapStatus,
  paiseToRupees,
  rupeesToPaise,
  settledPaise,
} from '../src/services/refrens.js';
import { pullInvoices, pushInvoice } from '../src/services/refrens-sync.js';

/**
 * Refrens ⇄ Sanctum sync. The Refrens API is stubbed at `fetch`, so these run
 * offline and assert the behaviour that actually matters: rupee↔paise
 * conversion, TDS counting as settled, idempotent re-polling (no duplicate
 * invoices/payments/clients), and that a push records the Refrens id + number.
 */

// A real P-256 key so `importPKCS8` in the client succeeds.
const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function refrensInvoice(over: Record<string, any> = {}) {
  return {
    _id: 'r_inv_1',
    invoiceNumber: 'A00472',
    billType: 'INVOICE',
    status: 'UNPAID',
    invoiceDate: '2026-09-01T18:30:01.000Z',
    dueDate: null,
    currency: 'INR',
    igst: false,
    billedTo: {
      name: 'Y Y Systems Private Limited',
      gstin: '03AAACY7615G1ZH',
      street: 'Plot D-257',
      city: 'Mohali',
      state: 'Punjab',
      pincode: '160055',
      clientId: '1763631981932',
    },
    items: [
      {
        name: 'Social Media Marketing',
        description: '45 posts a month',
        quantity: 1,
        rate: 45000,
        gstRate: 18,
        subTotal: 45000,
      },
    ],
    finalTotal: { total: 53100, subTotal: 45000, amount: 45000, igst: 8100, cgst: 4050, sgst: 4050 },
    payments: [],
    ...over,
  };
}

/** Stub Refrens: /authentication → token, invoice list → one page. */
function stubRefrens(invoiceList: any[], onCreate?: (body: any) => any) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  vi.stubGlobal('fetch', async (url: any, init: any = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: u, body });
    if (u.endsWith('/authentication')) {
      return new Response(JSON.stringify({ accessToken: 'test-token' }), { status: 201 });
    }
    if (method === 'POST' && u.includes('/invoices')) {
      const created = onCreate?.(body) ?? { _id: 'r_new_1', invoiceNumber: 'A00500', billedTo: body?.billedTo };
      return new Response(JSON.stringify(created), { status: 201 });
    }
    if (method === 'PATCH' && u.includes('/invoices/')) {
      return new Response(JSON.stringify({ _id: 'r_new_1', invoiceNumber: 'A00500' }), { status: 200 });
    }
    if (u.includes('/invoices')) {
      const skip = Number(new URL(u).searchParams.get('$skip') ?? 0);
      const pageData = skip === 0 ? invoiceList : [];
      return new Response(
        JSON.stringify({ total: invoiceList.length, limit: 50, skip, data: pageData }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  });
  return calls;
}

describe('Refrens sync — pure mapping', () => {
  it('converts rupees ↔ paise without drift', () => {
    expect(rupeesToPaise(53100)).toBe(5_310_000);
    expect(rupeesToPaise(1234.56)).toBe(123_456);
    expect(paiseToRupees(5_310_000)).toBe(53100);
    expect(rupeesToPaise(null)).toBe(0);
  });

  it('counts TDS as settled (a TDS invoice is not short-paid)', () => {
    // ₹1,89,000 received + ₹17,500 withheld = ₹2,06,500 discharged.
    const paid = settledPaise([{ _id: 'p1', amount: 189000, tds: 17500 } as any]);
    expect(paid).toBe(20_650_000);
  });

  it('ignores removed and refund payments', () => {
    expect(
      settledPaise([
        { _id: 'p1', amount: 100, isRemoved: true } as any,
        { _id: 'p2', amount: 50, isRefund: true } as any,
        { _id: 'p3', amount: 25 } as any,
      ]),
    ).toBe(2500);
  });

  it('maps Refrens statuses onto Sanctum statuses', () => {
    expect(mapStatus('CANCELED', [], 100)).toBe('cancelled');
    expect(mapStatus('PAID', [], 100)).toBe('paid');
    expect(mapStatus('UNPAID', [], 100)).toBe('sent'); // issued, not a draft
    expect(mapStatus('PARTIAL', [{ _id: 'p', amount: 1 } as any], 10_000)).toBe('partially_paid');
  });

  it('maps payment methods, falling back to other', () => {
    expect(mapPaymentMethod('ACCOUNT_TRANSFER')).toBe('bank_transfer');
    expect(mapPaymentMethod('UPI')).toBe('upi');
    expect(mapPaymentMethod('SOMETHING_ELSE')).toBe('other');
  });
});

describe('Refrens sync — pull + push', () => {
  let owner: Agent;
  let agencyId: string;

  beforeAll(async () => {
    const s = await signupAgency();
    owner = s.agent;
    agencyId = s.agency.id;
    (env as any).REFRENS_URL_KEY = 'creative-monk';
    (env as any).REFRENS_APP_ID = 'creative-monk-TEST';
    (env as any).REFRENS_PRIVATE_KEY = privateKey as string;
  });

  afterEach(() => vi.unstubAllGlobals());

  it('pulls an invoice, creating the client, items and money in paise', async () => {
    stubRefrens([refrensInvoice()]);
    const r = await pullInvoices(agencyId);
    expect(r.created).toBe(1);
    expect(r.clientsCreated).toBe(1);

    const [inv] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.agencyId, agencyId), eq(invoices.refrensId, 'r_inv_1')));
    expect(inv).toBeTruthy();
    expect(inv!.invoiceNumber).toBe('A00472');
    expect(inv!.total).toBe(5_310_000); // ₹53,100 in paise
    expect(inv!.subtotal).toBe(4_500_000);
    expect(inv!.cgst).toBe(405_000);
    expect(inv!.sgst).toBe(405_000);
    expect(inv!.igst).toBe(0); // intrastate
    expect(inv!.status).toBe('sent');
    expect(inv!.externalSource).toBe('refrens');

    const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, inv!.id));
    expect(items).toHaveLength(1);
    expect(items[0]!.rate).toBe(4_500_000);

    const [cli] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.agencyId, agencyId), eq(clients.refrensClientId, '1763631981932')));
    expect(cli!.gstNumber).toBe('03AAACY7615G1ZH');
  });

  it('is idempotent — re-polling updates in place, never duplicates', async () => {
    stubRefrens([refrensInvoice()]);
    const r2 = await pullInvoices(agencyId);
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(1);
    expect(r2.clientsCreated).toBe(0);

    const rows = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.agencyId, agencyId), eq(invoices.refrensId, 'r_inv_1')));
    expect(rows).toHaveLength(1);
    const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, rows[0]!.id));
    expect(items).toHaveLength(1); // replaced, not appended
  });

  it('adds payments once and flips status to paid (TDS included)', async () => {
    const withPayment = refrensInvoice({
      status: 'PAID',
      payments: [
        { _id: 'r_pay_1', amount: 35600, tds: 17500, paymentDate: '2026-09-02T00:00:00.000Z', paymentMethod: 'ACCOUNT_TRANSFER' },
      ],
    });
    stubRefrens([withPayment]);
    await pullInvoices(agencyId);
    await pullInvoices(agencyId); // second poll must not duplicate the receipt

    const [inv] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.agencyId, agencyId), eq(invoices.refrensId, 'r_inv_1')));
    expect(inv!.status).toBe('paid');

    const pays = await db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, inv!.id));
    expect(pays).toHaveLength(1);
    expect(pays[0]!.amount).toBe(5_310_000); // ₹35,600 + ₹17,500 TDS
  });

  it('maps interstate invoices to IGST only', async () => {
    const inter = refrensInvoice({ _id: 'r_inv_2', invoiceNumber: 'A00473', igst: true });
    stubRefrens([inter]);
    await pullInvoices(agencyId);
    const [inv] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.agencyId, agencyId), eq(invoices.refrensId, 'r_inv_2')));
    expect(inv!.isInterstate).toBe(true);
    expect(inv!.igst).toBe(810_000);
    expect(inv!.cgst).toBe(0);
    expect(inv!.sgst).toBe(0);
  });

  it('pushes a Sanctum invoice up and adopts the Refrens id + number', async () => {
    const client = data(await owner.post(`${BASE}/clients`).send({ name: 'Push Co' }));
    const inv = data(
      await owner.post(`${BASE}/invoices`).send({
        clientId: client.id,
        items: [{ description: 'Retainer', quantity: 1, rate: 5_000_000, gstRate: 18 }],
      }),
    );
    expect(inv.invoiceNumber).toMatch(/^INV-/); // Sanctum's provisional number

    const calls = stubRefrens([], (body) => {
      // The payload must carry rupees, not paise.
      expect(body.items[0].rate).toBe(50000);
      expect(body.billedTo.name).toBe('Push Co');
      return { _id: 'r_pushed_1', invoiceNumber: 'A00501', billedTo: { clientId: 'rc_9' } };
    });

    const res = await pushInvoice(agencyId, inv.id);
    expect(res.ok).toBe(true);
    expect(res.refrensId).toBe('r_pushed_1');
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/invoices'))).toBe(true);

    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row!.refrensId).toBe('r_pushed_1');
    expect(row!.invoiceNumber).toBe('A00501'); // Refrens owns the real number
    expect(row!.refrensSyncError).toBeNull();
  });

  it('records the error instead of throwing when Refrens is down', async () => {
    const client = data(await owner.post(`${BASE}/clients`).send({ name: 'Down Co' }));
    const inv = data(
      await owner.post(`${BASE}/invoices`).send({
        clientId: client.id,
        items: [{ description: 'X', quantity: 1, rate: 1000, gstRate: 18 }],
      }),
    );
    vi.stubGlobal('fetch', async (url: any) =>
      String(url).endsWith('/authentication')
        ? new Response(JSON.stringify({ accessToken: 't' }), { status: 201 })
        : new Response(JSON.stringify({ message: 'Refrens exploded' }), { status: 500 }),
    );
    const res = await pushInvoice(agencyId, inv.id);
    expect(res.ok).toBe(false);
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row!.refrensSyncError).toContain('Refrens exploded');
  });
});
