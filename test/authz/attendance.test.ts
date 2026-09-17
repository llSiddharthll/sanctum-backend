import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  createMemberSession,
  data,
  signupAgency,
  systemRoleIdFor,
  type Agent,
  type SignupResult,
} from '../helpers';
import { closeOverRequires, systemRole, type Grant } from '../../src/authz/catalog.js';
import { systemActor } from '../../src/authz/actor.js';
import { emailEmployeeReports } from '../../src/services/reports.js';
import { MONTHLY_REPORTS_GRANTS } from '../../src/services/scheduler.js';

/**
 * Authorization scenarios for attendance, leave, regularizations and
 * out-of-office checkouts (design §D.6, §G.2): no self-approval, manageable
 * subjects only, own vs organization scope, tenant isolation, immutable
 * decisions, cancel rules, mark-never-self, policy field masking, notification
 * recipients by capability and system-actor report jobs.
 */

const ATT = `${BASE}/attendance`;
const LEAVES = `${ATT}/leaves`;
const REG = `${ATT}/regularizations`;
const NOTIF = `${BASE}/notifications`;

const org = (permission: string): Grant => ({ permission, scope: 'organization' });

async function employee(owner: Agent) {
  return createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')] });
}

/** Employee grants + the given organization-scope extras (strictly more authority). */
function employeePlus(extra: string[]): Grant[] {
  return closeOverRequires([...systemRole('employee').grants(), ...extra.map(org)], 'staff');
}

async function unread(agent: Agent): Promise<number> {
  const res = await agent.get(`${NOTIF}/unread-count`);
  expect(res.status).toBe(200);
  return data(res).count;
}

async function leaveType(owner: Agent, body: Record<string, unknown> = {}): Promise<string> {
  const res = await owner
    .post(`${LEAVES}/types`)
    .send({ name: `Type ${Date.now()}-${Math.random()}`, ...body });
  expect(res.status).toBe(201);
  return data(res).id;
}

async function requestLeave(agent: Agent, typeId: string, startDay: string, endDay = startDay) {
  const res = await agent.post(`${LEAVES}/`).send({ leaveTypeId: typeId, startDay, endDay, reason: 'r' });
  expect(res.status).toBe(201);
  return data(res);
}

async function raiseReg(agent: Agent, day: string) {
  const res = await agent.post(`${REG}/`).send({ day, type: 'late', reason: 'Traffic jam' });
  expect(res.status).toBe(201);
  return data(res);
}

describe('authz/attendance: self-approval is never allowed', () => {
  let a: SignupResult;
  let typeId: string;

  beforeAll(async () => {
    a = await signupAgency();
    typeId = await leaveType(a.agent);
  });

  it('owner cannot approve their own leave (403) but the request stays pending', async () => {
    const lr = await requestLeave(a.agent, typeId, '2025-03-17');
    expect(lr.capabilities['leaves.approve']).toBe(false);
    const res = await a.agent.post(`${LEAVES}/${lr.id}/decide`).send({ decision: 'approved' });
    expect(res.status).toBe(403);
    const mine = await a.agent.get(`${LEAVES}/`);
    expect(data(mine).find((r: any) => r.id === lr.id).status).toBe('pending');
  });

  it('owner cannot reject their own leave either (403)', async () => {
    const lr = await requestLeave(a.agent, typeId, '2025-03-18');
    const res = await a.agent.post(`${LEAVES}/${lr.id}/decide`).send({ decision: 'rejected' });
    expect(res.status).toBe(403);
  });

  it('an administrator cannot approve their own regularization (403)', async () => {
    const { agent: admin } = await createMemberSession(a.agent, { role: 'admin' });
    const reg = await raiseReg(admin, '2025-03-19');
    const res = await admin.post(`${REG}/${reg.id}/decide`).send({ decision: 'approved' });
    expect(res.status).toBe(403);
    // …but the owner (who manages the admin) can.
    const ok = await a.agent.post(`${REG}/${reg.id}/decide`).send({ decision: 'approved' });
    expect(ok.status).toBe(200);
  });
});

describe('authz/attendance: approver must be able to manage the subject', () => {
  let a: SignupResult;
  let typeId: string;
  let approver: Agent;
  let approver2: Agent;
  let emp: Agent;
  let admin: Agent;

  beforeAll(async () => {
    a = await signupAgency();
    typeId = await leaveType(a.agent);
    const grants = employeePlus(['leaves.view', 'leaves.approve', 'regularizations.view', 'regularizations.approve']);
    approver = (await createMemberSession(a.agent, { grants })).agent;
    approver2 = (await createMemberSession(a.agent, { grants })).agent;
    emp = (await employee(a.agent)).agent;
    admin = (await createMemberSession(a.agent, { role: 'admin' })).agent;
  });

  it('approves an employee (strictly less authority)', async () => {
    const lr = await requestLeave(emp, typeId, '2025-04-07');
    const list = await approver.get(`${LEAVES}/?scope=pending`);
    expect(data(list).find((r: any) => r.id === lr.id).capabilities['leaves.approve']).toBe(true);
    const res = await approver.post(`${LEAVES}/${lr.id}/decide`).send({ decision: 'approved' });
    expect(res.status).toBe(200);
  });

  it('cannot approve an administrator (more authority) → 403', async () => {
    const lr = await requestLeave(admin, typeId, '2025-04-08');
    const list = await approver.get(`${LEAVES}/?scope=pending`);
    expect(data(list).find((r: any) => r.id === lr.id).capabilities['leaves.approve']).toBe(false);
    const res = await approver.post(`${LEAVES}/${lr.id}/decide`).send({ decision: 'approved' });
    expect(res.status).toBe(403);
  });

  it('cannot approve a peer with identical authority → 403', async () => {
    const reg = await raiseReg(approver2, '2025-04-09');
    const res = await approver.post(`${REG}/${reg.id}/decide`).send({ decision: 'approved' });
    expect(res.status).toBe(403);
  });

  it('cannot approve the owner → 403', async () => {
    const lr = await requestLeave(a.agent, typeId, '2025-04-10');
    const res = await admin.post(`${LEAVES}/${lr.id}/decide`).send({ decision: 'approved' });
    expect(res.status).toBe(403);
  });
});

describe('authz/attendance: own vs organization scope on lists and reads', () => {
  let a: SignupResult;
  let typeId: string;
  let emp1: Awaited<ReturnType<typeof employee>>;
  let emp2: Awaited<ReturnType<typeof employee>>;
  let viewer: Agent;

  beforeAll(async () => {
    a = await signupAgency();
    typeId = await leaveType(a.agent);
    emp1 = await employee(a.agent);
    emp2 = await employee(a.agent);
    viewer = (
      await createMemberSession(a.agent, {
        grants: [org('leaves.view'), org('regularizations.view'), org('attendance.view')],
      })
    ).agent;
    await requestLeave(emp1.agent, typeId, '2025-05-05');
    await requestLeave(emp2.agent, typeId, '2025-05-06');
    await raiseReg(emp1.agent, '2025-05-07');
    await raiseReg(emp2.agent, '2025-05-08');
  });

  it('an employee sees only their own leaves and regularizations, even with scope=all', async () => {
    for (const url of [`${LEAVES}/?scope=all`, `${LEAVES}/?scope=pending`, `${REG}/?scope=all`]) {
      const res = await emp1.agent.get(url);
      expect(res.status).toBe(200);
      expect(data(res).length).toBeGreaterThan(0);
      expect(data(res).every((r: any) => r.userId === emp1.user.id)).toBe(true);
    }
  });

  it("an employee can't read someone else's calendar, balances or requests (403)", async () => {
    expect((await emp1.agent.get(`${ATT}/calendar?month=2025-05&userId=${emp2.user.id}`)).status).toBe(403);
    expect((await emp1.agent.get(`${LEAVES}/balances?userId=${emp2.user.id}`)).status).toBe(403);
    expect((await emp1.agent.get(`${LEAVES}/?scope=all&userId=${emp2.user.id}`)).status).toBe(403);
  });

  it('an organization viewer sees everyone and can read others', async () => {
    const leaves = await viewer.get(`${LEAVES}/?scope=all`);
    expect(leaves.status).toBe(200);
    const ids = new Set(data(leaves).map((r: any) => r.userId));
    expect(ids.has(emp1.user.id) && ids.has(emp2.user.id)).toBe(true);
    const regs = await viewer.get(`${REG}/?scope=all`);
    expect(new Set(data(regs).map((r: any) => r.userId)).size).toBeGreaterThanOrEqual(2);
    expect((await viewer.get(`${ATT}/calendar?month=2025-05&userId=${emp2.user.id}`)).status).toBe(200);
    expect((await viewer.get(`${LEAVES}/balances?userId=${emp2.user.id}`)).status).toBe(200);
    // Viewing is not approving.
    const row = data(leaves).find((r: any) => r.userId === emp1.user.id);
    expect(row.capabilities['leaves.approve']).toBe(false);
    expect((await viewer.post(`${LEAVES}/${row.id}/decide`).send({ decision: 'approved' })).status).toBe(403);
  });

  it('team-summary: own-scope viewer gets only their row; who-is-in needs view_live', async () => {
    const mine = await emp1.agent.get(`${ATT}/team-summary?month=2025-05`);
    expect(mine.status).toBe(200);
    expect(data(mine).members.map((m: any) => m.userId)).toEqual([emp1.user.id]);
    const all = await viewer.get(`${ATT}/team-summary?month=2025-05`);
    expect(data(all).members.length).toBeGreaterThanOrEqual(3);
    expect((await viewer.get(`${ATT}/whos-in`)).status).toBe(403);
    expect((await emp1.agent.get(`${ATT}/team-report`)).status).toBe(403);
  });

  it('a user in another agency is a 404 on ?userId', async () => {
    const other = await signupAgency();
    const res = await viewer.get(`${ATT}/calendar?month=2025-05&userId=${other.user.id}`);
    expect(res.status).toBe(404);
  });
});

describe('authz/attendance: tenant isolation', () => {
  it("another agency's owner gets 404 deciding or cancelling A's requests", async () => {
    const a = await signupAgency();
    const emp = await employee(a.agent);
    const typeId = await leaveType(a.agent);
    const lr = await requestLeave(emp.agent, typeId, '2025-06-02');
    const reg = await raiseReg(emp.agent, '2025-06-03');

    const b = await signupAgency();
    expect((await b.agent.post(`${LEAVES}/${lr.id}/decide`).send({ decision: 'approved' })).status).toBe(404);
    expect((await b.agent.post(`${LEAVES}/${lr.id}/cancel`)).status).toBe(404);
    expect((await b.agent.post(`${REG}/${reg.id}/decide`).send({ decision: 'approved' })).status).toBe(404);
    expect((await b.agent.post(`${REG}/${reg.id}/cancel`)).status).toBe(404);
    expect((await b.agent.patch(`${LEAVES}/types/${typeId}`).send({ name: 'Hijack' })).status).toBe(404);
    expect((await b.agent.delete(`${LEAVES}/types/${typeId}`)).status).toBe(404);
    expect((await b.agent.post(`${ATT}/mark`).send({ userId: emp.user.id, day: '2025-06-02', status: 'present' })).status).toBe(404);

    // A's type is unchanged.
    const types = await a.agent.get(`${LEAVES}/types`);
    expect(data(types).find((t: any) => t.id === typeId).active).toBe(true);
  });
});

describe('authz/attendance: decisions are immutable; cancel rules', () => {
  let a: SignupResult;
  let typeId: string;
  let emp: Awaited<ReturnType<typeof employee>>;
  let emp2: Awaited<ReturnType<typeof employee>>;

  beforeAll(async () => {
    a = await signupAgency();
    typeId = await leaveType(a.agent);
    emp = await employee(a.agent);
    emp2 = await employee(a.agent);
  });

  it('a decided leave / regularization cannot be decided again (409)', async () => {
    const lr = await requestLeave(emp.agent, typeId, '2025-07-01');
    expect((await a.agent.post(`${LEAVES}/${lr.id}/decide`).send({ decision: 'rejected' })).status).toBe(200);
    expect((await a.agent.post(`${LEAVES}/${lr.id}/decide`).send({ decision: 'approved' })).status).toBe(409);

    const reg = await raiseReg(emp.agent, '2025-07-02');
    expect((await a.agent.post(`${REG}/${reg.id}/decide`).send({ decision: 'approved' })).status).toBe(200);
    expect((await a.agent.post(`${REG}/${reg.id}/decide`).send({ decision: 'rejected' })).status).toBe(409);
    // Own cancel of a decided regularization is refused.
    expect((await emp.agent.post(`${REG}/${reg.id}/cancel`)).status).toBe(409);
  });

  it('own pending leave can be cancelled by the requester', async () => {
    const lr = await requestLeave(emp.agent, typeId, '2025-07-03');
    expect(lr.capabilities['leaves.cancel']).toBe(true);
    expect((await emp.agent.post(`${LEAVES}/${lr.id}/cancel`)).status).toBe(200);
    expect((await emp.agent.post(`${LEAVES}/${lr.id}/cancel`)).status).toBe(409);
  });

  it('own APPROVED leave cannot be cancelled by the requester; an approver can', async () => {
    const lr = await requestLeave(emp.agent, typeId, '2025-07-04');
    expect((await a.agent.post(`${LEAVES}/${lr.id}/decide`).send({ decision: 'approved' })).status).toBe(200);
    const mine = data(await emp.agent.get(`${LEAVES}/`)).find((r: any) => r.id === lr.id);
    expect(mine.capabilities['leaves.cancel']).toBe(false);
    expect((await emp.agent.post(`${LEAVES}/${lr.id}/cancel`)).status).toBe(403);

    const before = await unread(emp.agent);
    expect((await a.agent.post(`${LEAVES}/${lr.id}/cancel`)).status).toBe(200);
    expect(await unread(emp.agent)).toBeGreaterThan(before);
  });

  it('an administrator cannot approve the owner; the owner may withdraw their own pending leave', async () => {
    const lr = await requestLeave(a.agent, typeId, '2025-07-07');
    const { agent: admin } = await createMemberSession(a.agent, { role: 'admin' });
    // The admin can't approve the owner either (owner not manageable) → stays pending.
    expect((await admin.post(`${LEAVES}/${lr.id}/decide`).send({ decision: 'approved' })).status).toBe(403);
    // Pending own leave: owner may withdraw it.
    expect((await a.agent.post(`${LEAVES}/${lr.id}/cancel`)).status).toBe(200);
  });

  it("an employee can't cancel someone else's request (404: not visible)", async () => {
    const lr = await requestLeave(emp2.agent, typeId, '2025-07-08');
    const reg = await raiseReg(emp2.agent, '2025-07-09');
    expect((await emp.agent.post(`${LEAVES}/${lr.id}/cancel`)).status).toBe(404);
    expect((await emp.agent.post(`${REG}/${reg.id}/cancel`)).status).toBe(404);
  });
});

describe('authz/attendance: leave quota counts pending and is re-checked at approval', () => {
  it('pending requests consume balance; approval re-validates', async () => {
    const a = await signupAgency();
    const emp = await employee(a.agent);
    const typeId = await leaveType(a.agent, { annualQuota: 2 });

    const first = await requestLeave(emp.agent, typeId, '2025-08-04', '2025-08-05'); // 2 days
    const over = await emp.agent
      .post(`${LEAVES}/`)
      .send({ leaveTypeId: typeId, startDay: '2025-08-06', endDay: '2025-08-06', reason: 'x' });
    expect(over.status).toBe(409);

    const bal = await emp.agent.get(`${LEAVES}/balances?year=2025`);
    const b = data(bal).balances.find((x: any) => x.leaveTypeId === typeId);
    expect(b.pending).toBe(2);
    expect(b.remaining).toBe(0);

    // Lower the quota after the request was filed → approval re-checks and refuses.
    expect((await a.agent.patch(`${LEAVES}/types/${typeId}`).send({ annualQuota: 1 })).status).toBe(200);
    expect((await a.agent.post(`${LEAVES}/${first.id}/decide`).send({ decision: 'approved' })).status).toBe(409);
  });
});

describe('authz/attendance: mark', () => {
  it('never own; target must be manageable', async () => {
    const a = await signupAgency();
    const emp = await employee(a.agent);
    const adminRes = await createMemberSession(a.agent, { role: 'admin' });

    const self = await a.agent.post(`${ATT}/mark`).send({ userId: a.user.id, day: '2025-03-03', status: 'present' });
    expect(self.status).toBe(403);

    const other = await a.agent.post(`${ATT}/mark`).send({ userId: emp.user.id, day: '2025-03-03', status: 'present' });
    expect(other.status).toBe(200);
    expect(data(other).source).toBe('admin');

    const adminOnOwner = await adminRes.agent
      .post(`${ATT}/mark`)
      .send({ userId: a.user.id, day: '2025-03-03', status: 'absent' });
    expect(adminOnOwner.status).toBe(403);

    const empMark = await emp.agent.post(`${ATT}/mark`).send({ userId: adminRes.user.id, day: '2025-03-03' });
    expect(empMark.status).toBe(403);
  });
});

describe('authz/attendance: policy field masking', () => {
  it('coordinates and IP allowlist only with attendance.manage_policy', async () => {
    const a = await signupAgency();
    const put = await a.agent.put(`${ATT}/policy`).send({
      enforceGeo: true,
      geoLat: 12.9716,
      geoLng: 77.5946,
      geoRadiusM: 300,
      enforceIp: true,
      allowedIps: ['10.0.0.0/8'],
    });
    expect(put.status).toBe(200);
    expect(data(put).geoLat).toBe(12.9716);

    const emp = await employee(a.agent);
    const res = await emp.agent.get(`${ATT}/policy`);
    expect(res.status).toBe(200);
    const p = data(res);
    expect(p.enforceGeo).toBe(true);
    expect(p.enforceIp).toBe(true);
    expect(p.hasGeoFence).toBe(true);
    expect(p.geoLat).toBeNull();
    expect(p.geoLng).toBeNull();
    expect(p.geoRadiusM).toBeNull();
    expect(p.allowedIps).toEqual([]);
    expect(p.capabilities['attendance.manage_policy']).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('77.5946');

    // Server-side fencing still applies (IP not in allowlist → 403).
    expect((await emp.agent.post(`${ATT}/check-in`).send({ lat: 12.9716, lng: 77.5946 })).status).toBe(403);
    expect((await emp.agent.put(`${ATT}/policy`).send({ enforceGeo: false })).status).toBe(403);
  });
});

describe('authz/attendance: notifications go to permission holders', () => {
  it('leave / regularization requests notify approvers only (never the requester)', async () => {
    const a = await signupAgency();
    const approver = (
      await createMemberSession(a.agent, {
        grants: employeePlus(['leaves.view', 'leaves.approve']),
      })
    ).agent;
    const regApprover = (
      await createMemberSession(a.agent, {
        grants: employeePlus(['regularizations.view', 'regularizations.approve']),
      })
    ).agent;
    const bystander = (await employee(a.agent)).agent;
    const requester = (await employee(a.agent)).agent;
    const typeId = await leaveType(a.agent);

    const before = {
      owner: await unread(a.agent),
      approver: await unread(approver),
      regApprover: await unread(regApprover),
      bystander: await unread(bystander),
      requester: await unread(requester),
    };
    await requestLeave(requester, typeId, '2025-09-01');
    expect(await unread(a.agent)).toBe(before.owner + 1);
    expect(await unread(approver)).toBe(before.approver + 1);
    expect(await unread(regApprover)).toBe(before.regApprover);
    expect(await unread(bystander)).toBe(before.bystander);
    expect(await unread(requester)).toBe(before.requester);

    await raiseReg(requester, '2025-09-02');
    expect(await unread(regApprover)).toBe(before.regApprover + 1);
    expect(await unread(approver)).toBe(before.approver + 1);
    expect(await unread(bystander)).toBe(before.bystander);
  });

  it("the owner's own leave request does not notify the owner", async () => {
    const a = await signupAgency();
    const typeId = await leaveType(a.agent);
    const before = await unread(a.agent);
    await requestLeave(a.agent, typeId, '2025-09-03');
    expect(await unread(a.agent)).toBe(before);
  });
});

describe('authz/attendance: report jobs run as an explicit system actor', () => {
  it('refuses a system actor without report grants; succeeds with the job grants', async () => {
    const a = await signupAgency();
    await employee(a.agent);
    await expect(
      emailEmployeeReports(systemActor('test', a.agency.id, []), '2025-03-01', '2025-03-31'),
    ).rejects.toMatchObject({ status: 403 });
    const r = await emailEmployeeReports(
      systemActor('monthly_reports', a.agency.id, MONTHLY_REPORTS_GRANTS),
      '2025-03-01',
      '2025-03-31',
    );
    expect(r.employees).toBeGreaterThanOrEqual(1);
    expect(r.owners).toBeGreaterThanOrEqual(1);
  });

  it('email-reports over HTTP needs attendance.email_reports and a bounded range', async () => {
    const a = await signupAgency();
    const emp = await employee(a.agent);
    expect((await emp.agent.post(`${ATT}/email-reports`).send({})).status).toBe(403);
    const tooLong = await a.agent.post(`${ATT}/email-reports`).send({ from: '2025-01-01', to: '2025-06-30' });
    expect(tooLong.status).toBe(400);
  });
});
