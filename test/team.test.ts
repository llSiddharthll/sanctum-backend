import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  signupAgency,
  createMemberSession,
  data,
  type Agent,
} from './helpers';

// ============================================================
//  TEAM — new surfaces: presence fields on the roster, and the
//  per-user activity (audit) feed with its access gating.
// ============================================================

describe('team: roster presence fields', () => {
  it('GET /team rows carry presence fields; checking in flips the owner to "in"', async () => {
    // Fresh tenant so the owner is the only one who has checked in.
    const { agent: owner, user } = await signupAgency();

    // Before any check-in every presence field is at its resting state.
    const before = await owner.get(`${BASE}/team`);
    expect(before.status).toBe(200);
    const meBefore = data(before).find((m: any) => m.id === user.id);
    expect(meBefore).toBeDefined();
    // The contract exposes all four presence fields on every row.
    expect(meBefore).toHaveProperty('presence');
    expect(meBefore).toHaveProperty('checkedInToday');
    expect(meBefore).toHaveProperty('checkInAt');
    expect(meBefore).toHaveProperty('checkOutAt');
    expect(meBefore.checkedInToday).toBe(false);
    expect(meBefore.presence).toBeNull();
    expect(meBefore.checkInAt).toBeNull();
    expect(meBefore.checkOutAt).toBeNull();

    // Owner checks in.
    const checkIn = await owner.post(`${BASE}/attendance/check-in`).send({});
    expect(checkIn.status).toBe(201);

    const after = await owner.get(`${BASE}/team`);
    const meAfter = data(after).find((m: any) => m.id === user.id);
    expect(meAfter.checkedInToday).toBe(true);
    expect(meAfter.presence).toBe('in');
    expect(meAfter.checkInAt).not.toBeNull();
    expect(meAfter.checkOutAt).toBeNull();
  });

  it('after check-out the roster presence reads "out"', async () => {
    const { agent: owner, user } = await signupAgency();

    await owner.post(`${BASE}/attendance/check-in`).send({});
    const checkOut = await owner.post(`${BASE}/attendance/check-out`).send({});
    expect(checkOut.status).toBe(200);

    const list = await owner.get(`${BASE}/team`);
    const me = data(list).find((m: any) => m.id === user.id);
    expect(me.checkedInToday).toBe(true);
    expect(me.presence).toBe('out');
    expect(me.checkOutAt).not.toBeNull();
  });

  it("a member who has not checked in shows presence=null in the owner's roster", async () => {
    const { agent: owner } = await signupAgency();
    const { user: member } = await createMemberSession(owner);

    const list = await owner.get(`${BASE}/team`);
    const row = data(list).find((m: any) => m.id === member.id);
    expect(row).toBeDefined();
    expect(row.checkedInToday).toBe(false);
    expect(row.presence).toBeNull();
  });
});

describe('team: per-user activity feed', () => {
  let owner: Agent;
  let ownerId: string;

  beforeAll(async () => {
    const s = await signupAgency();
    owner = s.agent;
    ownerId = s.user.id;
  });

  it('GET /team/:userId/activity returns the actor\'s recent audit events', async () => {
    // The owner performs an auditable action (check-in is audited).
    const ci = await owner.post(`${BASE}/attendance/check-in`).send({});
    expect(ci.status).toBe(201);

    const res = await owner.get(`${BASE}/team/${ownerId}/activity`);
    expect(res.status).toBe(200);
    expect(Array.isArray(data(res))).toBe(true);
    const actions = data(res).map((e: any) => e.action);
    expect(actions).toContain('attendance.check_in');
    // Each row carries the audit shape.
    const checkIn = data(res).find(
      (e: any) => e.action === 'attendance.check_in',
    );
    expect(checkIn.entityType).toBe('attendance');
    expect(checkIn).toHaveProperty('createdAt');
    expect(checkIn).toHaveProperty('metadata');
  });

  it('respects ?limit', async () => {
    // A member generates several auditable events of their own.
    const member = await createMemberSession(owner);
    const clientId = data(
      await owner.post(`${BASE}/clients`).send({ name: 'Activity Co' }),
    ).id;
    const projectId = data(
      await owner
        .post(`${BASE}/projects`)
        .send({ name: 'Activity Project', clientId }),
    ).id;
    // The member runs a timer cycle a few times (each stop audits timer.stop).
    for (let i = 0; i < 3; i++) {
      await member.agent
        .post(`${BASE}/timers/start`)
        .send({ projectId, note: `cycle ${i}` });
      await member.agent.post(`${BASE}/timers/stop`);
    }

    const full = await member.agent.get(
      `${BASE}/team/${member.user.id}/activity`,
    );
    expect(full.status).toBe(200);
    expect(data(full).length).toBeGreaterThanOrEqual(2);

    const limited = await member.agent.get(
      `${BASE}/team/${member.user.id}/activity?limit=1`,
    );
    expect(limited.status).toBe(200);
    expect(data(limited).length).toBe(1);
  });

  it('a member CAN read their OWN activity', async () => {
    const member = await createMemberSession(owner);
    const res = await member.agent.get(
      `${BASE}/team/${member.user.id}/activity`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(data(res))).toBe(true);
  });

  it("a member CANNOT read another member's activity (403)", async () => {
    const memberA = await createMemberSession(owner);
    const memberB = await createMemberSession(owner);

    const res = await memberA.agent.get(
      `${BASE}/team/${memberB.user.id}/activity`,
    );
    expect(res.status).toBe(403);
  });

  it('an owner CAN read any member\'s activity (privileged)', async () => {
    const member = await createMemberSession(owner);
    const res = await owner.get(`${BASE}/team/${member.user.id}/activity`);
    expect(res.status).toBe(200);
  });

  it("isolates tenants — cannot read a foreign agency member's activity", async () => {
    const other = await signupAgency();
    const res = await owner.get(`${BASE}/team/${other.user.id}/activity`);
    // Foreign user id is not an agency member → 404 (not found in this tenant).
    expect([403, 404]).toContain(res.status);
  });

  it('a member with team:none cannot reach the activity feed (403)', async () => {
    const member = await createMemberSession(owner, {
      permissions: { team: 'none' },
    });
    const res = await member.agent.get(
      `${BASE}/team/${member.user.id}/activity`,
    );
    expect(res.status).toBe(403);
  });
});
