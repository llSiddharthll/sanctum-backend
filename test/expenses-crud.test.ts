import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, signupAgency, data, type Agent } from './helpers';

/**
 * Expenses CRUD coverage for the gaps that let real bugs ship:
 *  - gstDeductible round-trip (the web client was sending 0/1 against z.boolean(),
 *    so every create and edit 422'd and no test ever noticed),
 *  - PATCH cross-tenant isolation (only GET/DELETE were covered),
 *  - PATCH validation + 404s, and FK rejection for project/client.
 */
describe('expenses: full CRUD', () => {
  let owner: Agent;
  let clientId: string;
  let projectId: string;

  beforeAll(async () => {
    const s = await signupAgency();
    owner = s.agent;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Expense Co' })).id;
    projectId = data(
      await owner.post(`${BASE}/projects`).send({ name: 'Expense Project', clientId }),
    ).id;
  });

  const create = (over: Record<string, unknown> = {}) =>
    owner.post(`${BASE}/expenses`).send({ amount: 250_000, category: 'software', ...over });

  it('creates, reads, updates and deletes', async () => {
    const made = data(await create({ description: 'Figma seats' }));
    expect(made.amount).toBe(250_000);

    const got = data(await owner.get(`${BASE}/expenses/${made.id}`));
    expect(got.description).toBe('Figma seats');

    const patched = data(
      await owner.patch(`${BASE}/expenses/${made.id}`).send({ amount: 300_000, category: 'marketing' }),
    );
    expect(patched.amount).toBe(300_000);
    expect(patched.category).toBe('marketing');

    expect((await owner.delete(`${BASE}/expenses/${made.id}`)).status).toBe(200);
    expect((await owner.get(`${BASE}/expenses/${made.id}`)).status).toBe(404);
  });

  it('round-trips gstDeductible as a BOOLEAN on create and patch', async () => {
    // The web client used to send 0/1 here, which 422'd against z.boolean().
    const made = data(await create({ gstDeductible: true, gstAmount: 45_000 }));
    expect(made.gstDeductible).toBe(true);
    expect(made.gstAmount).toBe(45_000);

    const off = data(
      await owner.patch(`${BASE}/expenses/${made.id}`).send({ gstDeductible: false }),
    );
    expect(off.gstDeductible).toBe(false);

    // A numeric 0/1 must be rejected loudly rather than silently mis-stored.
    const bad = await owner.patch(`${BASE}/expenses/${made.id}`).send({ gstDeductible: 1 });
    expect(bad.status).toBe(422);
  });

  it('keeps an expense inside date-ranged reports after a partial edit', async () => {
    const made = data(await create({ expenseDate: '2026-06-15T00:00:00.000Z' }));
    // Editing an unrelated field must not blank the date (it used to be nullable,
    // which silently removed the row from every finance report).
    await owner.patch(`${BASE}/expenses/${made.id}`).send({ description: 'renamed' });
    const after = data(await owner.get(`${BASE}/expenses/${made.id}`));
    expect(after.expenseDate).toBeTruthy();

    const ranged = data(await owner.get(`${BASE}/expenses?from=2026-06-01&to=2026-06-30`));
    expect(ranged.some((e: any) => e.id === made.id)).toBe(true);

    // And an explicit null is refused rather than accepted.
    const nulled = await owner.patch(`${BASE}/expenses/${made.id}`).send({ expenseDate: null });
    expect(nulled.status).toBe(422);
  });

  it('validates amount, category and receipt URL', async () => {
    expect((await create({ amount: -1 })).status).toBe(422);
    expect((await create({ amount: 12.5 })).status).toBe(422);
    expect((await create({ category: 'not-a-category' })).status).toBe(422);
    const made = data(await create());
    expect(
      (await owner.patch(`${BASE}/expenses/${made.id}`).send({ amount: -5 })).status,
    ).toBe(422);
    expect(
      (await owner.patch(`${BASE}/expenses/${made.id}`).send({ category: 'bogus' })).status,
    ).toBe(422);
  });

  it('accepts project + client links and exposes them', async () => {
    const made = data(await create({ projectId, clientId }));
    expect(made.projectId).toBe(projectId);
    expect(made.clientId).toBe(clientId);
    // And they show up on the per-client finance rollup.
    const roll = data(await owner.get(`${BASE}/finance/clients/${clientId}`));
    expect(roll.expenses).toBeGreaterThan(0);
  });

  it('404s on unknown ids for patch and delete', async () => {
    expect((await owner.patch(`${BASE}/expenses/exp_nope`).send({ amount: 1 })).status).toBe(404);
    expect((await owner.delete(`${BASE}/expenses/exp_nope`)).status).toBe(404);
  });

  it('never lets another agency read, edit or delete an expense', async () => {
    const mine = data(await create({ description: 'private' }));
    const other = (await signupAgency()).agent;

    expect((await other.get(`${BASE}/expenses/${mine.id}`)).status).toBe(404);
    // PATCH cross-tenant was previously untested — the one path that could
    // silently corrupt another tenant's financial row.
    expect((await other.patch(`${BASE}/expenses/${mine.id}`).send({ amount: 1 })).status).toBe(404);
    expect((await other.delete(`${BASE}/expenses/${mine.id}`)).status).toBe(404);

    // Untouched.
    const still = data(await owner.get(`${BASE}/expenses/${mine.id}`));
    expect(still.amount).toBe(250_000);
    expect(still.description).toBe('private');
  });

  it('rejects attaching another agency\'s project or client', async () => {
    const outsider = (await signupAgency()).agent;
    const theirClient = data(await outsider.post(`${BASE}/clients`).send({ name: 'Theirs' })).id;
    const res = await create({ clientId: theirClient });
    expect(res.status).toBe(404);
  });
});
