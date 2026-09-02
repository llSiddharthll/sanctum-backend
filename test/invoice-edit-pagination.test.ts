import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, signupAgency, data, type Agent } from './helpers';

/**
 * Invoice pagination, the KPI summary (which must exclude cancelled invoices),
 * and the new full edit endpoint that makes Refrens editing two-way.
 */
describe('invoices: pagination, summary, edit', () => {
  let owner: Agent;
  let clientId: string;
  const made: string[] = [];

  const makeInvoice = async (rate: number) =>
    data(
      await owner.post(`${BASE}/invoices`).send({
        clientId,
        items: [{ description: 'Service', quantity: 1, rate, gstRate: 18 }],
      }),
    );

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Paging Co' })).id;
    for (let i = 0; i < 5; i += 1) {
      const inv = await makeInvoice(100_000 * (i + 1));
      made.push(inv.id);
    }
  });

  it('returns everything when no limit is given (back-compat for the shipped app)', async () => {
    const res = await owner.get(`${BASE}/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(5);
    expect(res.body.total).toBeGreaterThanOrEqual(5);
    expect(res.body.limit).toBeNull();
  });

  it('paginates with limit/offset and reports the full total', async () => {
    const p1 = await owner.get(`${BASE}/invoices?limit=2&offset=0`);
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.total).toBeGreaterThanOrEqual(5);
    expect(p1.body.limit).toBe(2);

    const p2 = await owner.get(`${BASE}/invoices?limit=2&offset=2`);
    expect(p2.body.data).toHaveLength(2);
    // Different page ⇒ different rows.
    const ids1 = p1.body.data.map((i: any) => i.id);
    const ids2 = p2.body.data.map((i: any) => i.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it('filters by search term and status', async () => {
    const byClient = await owner.get(`${BASE}/invoices?search=paging`);
    expect(byClient.body.data.length).toBeGreaterThanOrEqual(5);
    const nonsense = await owner.get(`${BASE}/invoices?search=zzzznotathing`);
    expect(nonsense.body.data).toHaveLength(0);
    expect(nonsense.body.total).toBe(0);

    const drafts = await owner.get(`${BASE}/invoices?status=draft`);
    expect(drafts.body.data.every((i: any) => i.rawStatus === 'draft')).toBe(true);
  });

  it('summary excludes cancelled invoices from outstanding + total invoiced', async () => {
    const before = data(await owner.get(`${BASE}/invoices/summary`));
    const doomed = await makeInvoice(500_000); // ₹5,000 + GST
    const afterAdd = data(await owner.get(`${BASE}/invoices/summary`));
    expect(afterAdd.totalInvoiced).toBeGreaterThan(before.totalInvoiced);
    expect(afterAdd.outstanding).toBeGreaterThan(before.outstanding);

    await owner.patch(`${BASE}/invoices/${doomed.id}/status`).send({ status: 'cancelled' });
    const afterCancel = data(await owner.get(`${BASE}/invoices/summary`));
    // Cancelling must remove it from both — this is the bug that made the live
    // Outstanding KPI read high after the Refrens import.
    expect(afterCancel.totalInvoiced).toBe(before.totalInvoiced);
    expect(afterCancel.outstanding).toBe(before.outstanding);
    expect(afterCancel.cancelledCount).toBeGreaterThanOrEqual(1);
  });

  it('edits an invoice, replacing items and recomputing tax', async () => {
    const inv = await makeInvoice(100_000);
    const res = await owner.patch(`${BASE}/invoices/${inv.id}`).send({
      notes: 'Revised scope',
      items: [
        { description: 'Retainer', quantity: 2, rate: 250_000, gstRate: 18 },
        { description: 'Ads', quantity: 1, rate: 100_000, gstRate: 18 },
      ],
    });
    expect(res.status).toBe(200);
    const out = data(res);
    expect(out.notes).toBe('Revised scope');
    expect(out.subtotal).toBe(600_000); // 2×2500 + 1000 = ₹6,000
    expect(out.taxTotal).toBe(108_000); // 18%
    expect(out.total).toBe(708_000);
    expect(out.cgst).toBe(54_000);
    expect(out.sgst).toBe(54_000);
    expect(out.igst).toBe(0);
    expect(out.items).toHaveLength(2);

    const reload = data(await owner.get(`${BASE}/invoices/${inv.id}`));
    expect(reload.items).toHaveLength(2);
    expect(reload.total).toBe(708_000);
  });

  it('switching to interstate moves the tax into IGST', async () => {
    const inv = await makeInvoice(100_000);
    const out = data(
      await owner.patch(`${BASE}/invoices/${inv.id}`).send({ isInterstate: true }),
    );
    expect(out.igst).toBe(out.taxTotal);
    expect(out.cgst).toBe(0);
    expect(out.sgst).toBe(0);
  });

  it('404s on an unknown invoice and refuses to edit a cancelled one', async () => {
    expect((await owner.patch(`${BASE}/invoices/inv_nope`).send({ notes: 'x' })).status).toBe(404);

    const inv = await makeInvoice(100_000);
    await owner.patch(`${BASE}/invoices/${inv.id}/status`).send({ status: 'cancelled' });
    const res = await owner.patch(`${BASE}/invoices/${inv.id}`).send({ notes: 'x' });
    expect(res.status).toBe(400);
    expect(String(res.body?.error?.message ?? '')).toMatch(/cancelled/i);
  });

  it('does not leak another agency\'s invoice', async () => {
    const other = (await signupAgency()).agent;
    const res = await other.patch(`${BASE}/invoices/${made[0]}`).send({ notes: 'hax' });
    expect(res.status).toBe(404);
  });
});
