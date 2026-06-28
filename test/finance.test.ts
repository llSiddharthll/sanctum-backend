import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, signupAgency, createMemberSession, data, type Agent } from './helpers';

/**
 * Finance suite — Expenses and the Finance overview.
 *
 * Money is INTEGER PAISE everywhere (₹1 = 100 paise).
 *
 * Gate: every finance router uses requireModuleRW('finance') — GET needs
 * `view`, any mutation needs `manage`. Owner has full access.
 */
describe('finance workflow', () => {
  let owner: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    const c = await owner
      .post(`${BASE}/clients`)
      .send({ name: 'Finance Client', contactEmail: 'fin@client.test' });
    expect(c.status).toBe(201);
  });

  // ----------------------------------------------------------------
  //  Expenses CRUD
  // ----------------------------------------------------------------
  it('creates, lists (filtered), patches and deletes an expense', async () => {
    const create = await owner.post(`${BASE}/expenses`).send({
      category: 'software',
      amount: 25000, // ₹250
      description: 'Figma subscription',
      expenseDate: '2026-06-10',
    });
    expect(create.status).toBe(201);
    const exp = data(create);
    expect(exp.id).toMatch(/^exp_/);
    expect(exp.category).toBe('software');
    expect(exp.amount).toBe(25000);

    // list filtered by category
    const byCat = await owner.get(`${BASE}/expenses`).query({ category: 'software' });
    expect(byCat.status).toBe(200);
    expect(data(byCat).some((e: any) => e.id === exp.id)).toBe(true);
    expect(data(byCat).every((e: any) => e.category === 'software')).toBe(true);

    // list filtered by date range (month window covering Jun 2026)
    const byDate = await owner
      .get(`${BASE}/expenses`)
      .query({ from: '2026-06-01', to: '2026-06-30' });
    expect(byDate.status).toBe(200);
    expect(data(byDate).some((e: any) => e.id === exp.id)).toBe(true);

    // patch amount + category
    const patch = await owner
      .patch(`${BASE}/expenses/${exp.id}`)
      .send({ amount: 30000, category: 'marketing' });
    expect(patch.status).toBe(200);
    expect(data(patch).amount).toBe(30000);
    expect(data(patch).category).toBe('marketing');

    // delete
    const del = await owner.delete(`${BASE}/expenses/${exp.id}`);
    expect(del.status).toBe(200);
    expect(data(del).deleted).toBe(true);

    const gone = await owner.get(`${BASE}/expenses/${exp.id}`);
    expect(gone.status).toBe(404);
  });

  it('rejects an expense with a non-integer / negative amount → 422', async () => {
    const negative = await owner
      .post(`${BASE}/expenses`)
      .send({ amount: -100, category: 'office' });
    expect(negative.status).toBe(422);

    const fractional = await owner
      .post(`${BASE}/expenses`)
      .send({ amount: 12.5, category: 'office' });
    expect(fractional.status).toBe(422);
  });

  // ----------------------------------------------------------------
  //  Finance overview — expense numbers move in the right direction
  // ----------------------------------------------------------------
  it('reflects a logged expense in the overview totals', async () => {
    // Fresh tenant so the overview totals are deterministic.
    const fresh = (await signupAgency()).agent;

    // Baseline.
    const before = await fresh.get(`${BASE}/finance/overview`);
    expect(before.status).toBe(200);
    const b = data(before);
    expect(b.expenses).toBe(0);
    expect(b.netProfit).toBe(0);

    // Log an expense of ₹500.
    const exp = await fresh
      .post(`${BASE}/expenses`)
      .send({ category: 'software', amount: 50000 });
    expect(exp.status).toBe(201);

    const after = await fresh.get(`${BASE}/finance/overview`);
    const ai = data(after);
    expect(ai.expenses).toBe(50000);
    // Net profit is just negative expenses now (no revenue term).
    expect(ai.netProfit).toBe(-50000);
    // Expenses-by-category breakdown surfaces the logged category.
    expect(
      ai.expensesByCategory.some(
        (r: any) => r.category === 'software' && r.amount === 50000,
      ),
    ).toBe(true);
  });

  // ----------------------------------------------------------------
  //  Permissions — finance is manage-gated for writes
  // ----------------------------------------------------------------
  it('denies a member with finance:none any access (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { finance: 'none' },
    });
    expect((await agent.get(`${BASE}/expenses`)).status).toBe(403);
    expect((await agent.get(`${BASE}/finance/overview`)).status).toBe(403);
  });

  it('lets a finance:view member read but not create/patch (403 on writes)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { finance: 'view' },
    });
    // Reads allowed.
    expect((await agent.get(`${BASE}/expenses`)).status).toBe(200);
    expect((await agent.get(`${BASE}/finance/overview`)).status).toBe(200);

    // Writes forbidden (needs `manage`).
    const createExpense = await agent
      .post(`${BASE}/expenses`)
      .send({ amount: 1000, category: 'office' });
    expect(createExpense.status).toBe(403);
  });

  // ----------------------------------------------------------------
  //  Tenant isolation
  // ----------------------------------------------------------------
  it("isolates tenants — agency B cannot read agency A's expenses", async () => {
    // Agency A creates an expense.
    const aExpense = await owner
      .post(`${BASE}/expenses`)
      .send({ amount: 4242, category: 'office' });
    const aExpId = data(aExpense).id;

    // Agency B.
    const b = (await signupAgency()).agent;
    expect((await b.get(`${BASE}/expenses/${aExpId}`)).status).toBe(404);
    expect((await b.delete(`${BASE}/expenses/${aExpId}`)).status).toBe(404);

    // B's list never surfaces A's records.
    const bExpenses = await b.get(`${BASE}/expenses`);
    expect(data(bExpenses).some((e: any) => e.id === aExpId)).toBe(false);
  });
});
