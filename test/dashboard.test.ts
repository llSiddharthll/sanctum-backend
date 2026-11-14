import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, signupAgency, createMemberSession, data, type Agent } from './helpers';

/**
 * Dashboard aggregates (read-only):
 *   GET /dashboard/money          finance.view_overview
 *   GET /dashboard/content-queue  posts.view, rows limited to clients in scope
 */
describe('dashboard aggregates', () => {
  let owner: Agent;
  let clientId: string;
  let invoiceId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Dash Co' })).id;

    // One sent invoice of ₹1,180 (₹1,000 + 18% GST), half paid today, due in the past.
    const inv = await owner.post(`${BASE}/invoices`).send({
      clientId,
      dueDate: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      items: [{ description: 'Retainer', quantity: 1, rate: 100_000, gstRate: 18 }],
    });
    expect(inv.status).toBe(201);
    invoiceId = data(inv).id;
    expect((await owner.patch(`${BASE}/invoices/${invoiceId}/status`).send({ status: 'sent' })).status).toBe(200);
    expect(
      (await owner.post(`${BASE}/invoices/${invoiceId}/payments`).send({ amount: 50_000 })).status,
    ).toBe(200);

    // A one-time expense today.
    expect(
      (
        await owner.post(`${BASE}/expenses`).send({
          category: 'software',
          amount: 20_000,
          expenseDate: new Date().toISOString(),
        })
      ).status,
    ).toBe(201);

    // Two posts: one waiting on the client.
    const p = await owner.post(`${BASE}/clients/${clientId}/posts`).send({ postType: 'post', caption: 'Hello' });
    expect(p.status).toBe(201);
    const t = await owner
      .post(`${BASE}/clients/${clientId}/posts/${data(p).id}/transition`)
      .send({ to: 'pending_approval' });
    expect(t.status).toBe(200);
    expect((await owner.post(`${BASE}/clients/${clientId}/posts`).send({ postType: 'reel' })).status).toBe(201);
  });

  it('money: 6-month trend, this month figures, receivables and overdue list', async () => {
    const res = await owner.get(`${BASE}/dashboard/money`);
    expect(res.status).toBe(200);
    const d = data(res);
    expect(d.months).toHaveLength(6);
    expect(d.months[5].month).toBe(d.thisMonth.month);
    expect(d.thisMonth.collected).toBe(50_000);
    expect(d.thisMonth.expenses).toBe(20_000);
    expect(d.outstanding).toBe(118_000 - 50_000);
    expect(d.overdueCount).toBe(1);
    expect(d.overdueInvoices[0]).toMatchObject({ id: invoiceId, balance: 68_000, clientName: 'Dash Co' });
    expect(d.overdueInvoices[0].daysOverdue).toBeGreaterThanOrEqual(1);
    // Owner holds users.view_compensation → payroll is a number (0 here) and net subtracts it.
    expect(typeof d.payroll).toBe('number');
    expect(d.thisMonth.net).toBe(50_000 - 20_000 - d.payroll);
  });

  it('money: 403 without finance.view_overview', async () => {
    const member = await createMemberSession(owner, {
      grants: [{ permission: 'tasks.view', scope: 'own' }],
    });
    expect((await member.agent.get(`${BASE}/dashboard/money`)).status).toBe(403);
  });

  it('content-queue: lists posts waiting on the client; drafts are excluded', async () => {
    const res = await owner.get(`${BASE}/dashboard/content-queue`);
    expect(res.status).toBe(200);
    const d = data(res);
    expect(d.awaitingClientCount).toBe(1);
    expect(d.awaitingClient[0]).toMatchObject({ clientId, clientName: 'Dash Co', caption: 'Hello' });
    expect(d.changesRequestedCount).toBe(0);

    // ?mine=true keeps only the caller's own posts — the owner created this one.
    expect(data(await owner.get(`${BASE}/dashboard/content-queue?mine=true`)).awaitingClientCount).toBe(1);
  });

  it('content-queue: assigned-scope member sees nothing for clients they are not on; no posts.view → 403', async () => {
    const assigned = await createMemberSession(owner, {
      grants: [{ permission: 'posts.view', scope: 'assigned' }],
    });
    const r = await assigned.agent.get(`${BASE}/dashboard/content-queue`);
    expect(r.status).toBe(200);
    expect(data(r).awaitingClientCount).toBe(0);

    const none = await createMemberSession(owner, {
      grants: [{ permission: 'tasks.view', scope: 'own' }],
    });
    expect((await none.agent.get(`${BASE}/dashboard/content-queue`)).status).toBe(403);
  });
});
