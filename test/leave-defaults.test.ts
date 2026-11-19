import { describe, it, expect } from 'vitest';
import { BASE, signupAgency, createMemberSession, data, systemRoleIdFor } from './helpers';
import { ROLE_TEMPLATES } from '../src/authz/catalog.js';

/**
 * "Leaves not working": new workspaces had no leave types (so nobody could
 * apply), and the Manager template could not approve leave.
 */
describe('leave defaults and manager approval', () => {
  it('gives a workspace without leave types sensible defaults, exactly once', async () => {
    const { agent: owner } = await signupAgency();
    // Parallel first loads must not create duplicates.
    const [a, b, c] = await Promise.all([
      owner.get(`${BASE}/attendance/leaves/types`),
      owner.get(`${BASE}/attendance/leaves/types`),
      owner.get(`${BASE}/attendance/leaves/balances`),
    ]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    const types = data(await owner.get(`${BASE}/attendance/leaves/types`)) as Array<{ name: string; active: boolean }>;
    expect(types.map((t) => t.name)).toEqual(['Casual', 'Sick', 'Earned', 'Unpaid']);
    expect(types.every((t) => t.active)).toBe(true);
  });

  it('leaves a workspace that set up its own types alone', async () => {
    const { agent: owner } = await signupAgency();
    const created = await owner.post(`${BASE}/attendance/leaves/types`).send({ name: 'Annual', annualQuota: 20 });
    expect(created.status).toBe(201);
    const types = data(await owner.get(`${BASE}/attendance/leaves/types`)) as Array<{ name: string }>;
    expect(types.map((t) => t.name)).toEqual(['Annual']);
  });

  it('lets an employee apply and a Manager (from the template) approve', async () => {
    const { agent: owner } = await signupAgency();
    // A real employee: the built-in Employee role.
    const employee = await createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')], fullName: 'Asha Employee' });
    const managerGrants = ROLE_TEMPLATES.find((t) => t.key === 'manager')!.grants;
    const manager = await createMemberSession(owner, { grants: managerGrants, fullName: 'Ravi Manager' });

    const types = data(await employee.agent.get(`${BASE}/attendance/leaves/types`)) as Array<{ id: string; name: string }>;
    const casual = types.find((t) => t.name === 'Casual')!;
    const applied = await employee.agent
      .post(`${BASE}/attendance/leaves`)
      .send({ leaveTypeId: casual.id, startDay: '2027-01-05', endDay: '2027-01-06', reason: 'Family function' });
    expect(applied.status).toBe(201);
    const leaveId = data(applied).id as string;

    const pending = data(await manager.agent.get(`${BASE}/attendance/leaves`).query({ scope: 'pending' })) as Array<{
      id: string;
      capabilities?: Record<string, boolean>;
    }>;
    const mine = pending.find((l) => l.id === leaveId);
    expect(mine).toBeTruthy();
    expect(mine!.capabilities?.['leaves.approve']).toBe(true);

    const decided = await manager.agent
      .post(`${BASE}/attendance/leaves/${leaveId}/decide`)
      .send({ decision: 'approved' });
    expect(decided.status).toBe(200);
    expect(data(decided).status).toBe('approved');
  });
});
