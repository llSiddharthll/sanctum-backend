import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  signupAgency,
  createMemberSession,
  data,
  type Agent,
} from './helpers';

/**
 * Integration coverage for the attendance domain:
 *   policy, punch in/out, calendar, holidays, leaves, regularizations,
 *   notifications, who's-in, tenant isolation, and validation.
 *
 * Mount facts (verified against src/app.ts + the route files):
 *   - attendance      -> /api/v1/attendance              (requireModuleRW('attendance'))
 *   - leaves          -> /api/v1/attendance/leaves       (sub-router)
 *   - regularizations -> /api/v1/attendance/regularizations (sub-router)
 *   - notifications   -> /api/v1/notifications
 *
 * A default member (no permission overrides) gets FULL access, so they pass the
 * module gate. Admin-only actions are role-gated via requirePrivileged (owner/
 * admin), so a plain `member` is still rejected there. To exercise the module
 * gate's write-denial we use a member created with { attendance: 'view' }.
 *
 * Determinism: "today" is whatever the test DB clock says, but the route's
 * calendar classifies past/future relative to that clock. We anchor on months
 * that are unambiguously in the past (2025-03) or future (2099-01) so the
 * assertions never depend on the exact run date.
 */

const ATT = `${BASE}/attendance`;
const LEAVES = `${ATT}/leaves`;
const REG = `${ATT}/regularizations`;
const NOTIF = `${BASE}/notifications`;

async function unreadCount(agent: Agent): Promise<number> {
  const res = await agent.get(`${NOTIF}/unread-count`);
  expect(res.status).toBe(200);
  return data(res).count;
}

describe('attendance: policy', () => {
  let owner: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  it('owner GETs the default policy', async () => {
    const res = await owner.get(`${ATT}/policy`);
    expect(res.status).toBe(200);
    const p = data(res);
    expect(p.timezone).toBe('Asia/Kolkata');
    expect(p.workdays).toEqual([1, 2, 3, 4, 5]);
    expect(p.saturdayOffWeeks).toEqual([]);
  });

  it('owner PUTs policy (2nd & 4th Saturday off) and GET reflects it', async () => {
    const put = await owner.put(`${ATT}/policy`).send({
      workdays: [1, 2, 3, 4, 5, 6],
      saturdayOffWeeks: [2, 4],
      lateGraceMinutes: 20,
    });
    expect(put.status).toBe(200);
    expect(data(put).saturdayOffWeeks).toEqual([2, 4]);
    expect(data(put).workdays).toEqual([1, 2, 3, 4, 5, 6]);

    const get = await owner.get(`${ATT}/policy`);
    expect(data(get).saturdayOffWeeks).toEqual([2, 4]);
    expect(data(get).lateGraceMinutes).toBe(20);
  });

  it('a plain member cannot PUT the policy (403, role-gated)', async () => {
    const { agent } = await createMemberSession(owner, { role: 'member' });
    const res = await agent.put(`${ATT}/policy`).send({ lateGraceMinutes: 5 });
    expect(res.status).toBe(403);
  });

  it('an attendance:view member cannot PUT the policy (403, module gate)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { attendance: 'view' },
    });
    const res = await agent.put(`${ATT}/policy`).send({ lateGraceMinutes: 5 });
    expect(res.status).toBe(403);
    // but can still read
    const get = await agent.get(`${ATT}/policy`);
    expect(get.status).toBe(200);
  });

  it('rejects an invalid policy body (422/400)', async () => {
    // shiftStartMin out of range (max 1439).
    const res = await owner.put(`${ATT}/policy`).send({ shiftStartMin: 5000 });
    expect([400, 422]).toContain(res.status);
  });
});

describe('attendance: punch in / out', () => {
  let owner: Agent;
  let member: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    member = (await createMemberSession(owner, { role: 'member' })).agent;
  });

  it('check-in opens a record (201) and reflects an open status', async () => {
    const res = await member.post(`${ATT}/check-in`).send({});
    expect(res.status).toBe(201);
    const rec = data(res);
    expect(rec.checkInAt).toBeTruthy();
    expect(rec.checkOutAt).toBeNull();
    expect(['present', 'late']).toContain(rec.status);
  });

  it('checking in twice the same day is rejected (409)', async () => {
    const res = await member.post(`${ATT}/check-in`).send({});
    expect(res.status).toBe(409);
  });

  it('GET /today reflects the open record', async () => {
    const res = await member.get(`${ATT}/today`);
    expect(res.status).toBe(200);
    const t = data(res);
    expect(t.record).not.toBeNull();
    expect(t.record.checkInAt).toBeTruthy();
    expect(t.record.checkOutAt).toBeNull();
  });

  it('check-out closes the record (200) and GET /today shows checkout', async () => {
    const out = await member.post(`${ATT}/check-out`).send({});
    expect(out.status).toBe(200);
    expect(data(out).checkOutAt).toBeTruthy();

    const today = await member.get(`${ATT}/today`);
    expect(data(today).record.checkOutAt).toBeTruthy();
  });

  it('checking out again is rejected (409)', async () => {
    const res = await member.post(`${ATT}/check-out`).send({});
    expect(res.status).toBe(409);
  });

  it('check-out before any check-in is rejected (409)', async () => {
    const fresh = (await createMemberSession(owner, { role: 'member' })).agent;
    const res = await fresh.post(`${ATT}/check-out`).send({});
    expect(res.status).toBe(409);
  });
});

describe('attendance: re-check-in same day', () => {
  it('allows checking in again after check-out (re-opens the day)', async () => {
    const owner = (await signupAgency()).agent;
    const member = (await createMemberSession(owner, { role: 'member' })).agent;

    const in1 = await member.post(`${ATT}/check-in`).send({});
    expect(in1.status).toBe(201);
    const firstCheckIn = data(in1).checkInAt;

    const out1 = await member.post(`${ATT}/check-out`).send({});
    expect(out1.status).toBe(200);
    expect(data(out1).checkOutAt).toBeTruthy();

    // Re-check-in corrects an accidental checkout: succeeds + clears checkout,
    // and preserves the original check-in time.
    const in2 = await member.post(`${ATT}/check-in`).send({});
    expect(in2.status).toBe(201);
    expect(data(in2).checkOutAt).toBeNull();
    expect(data(in2).checkInAt).toBe(firstCheckIn);

    const today = await member.get(`${ATT}/today`);
    expect(data(today).record.checkOutAt).toBeNull();

    // They can then check out again.
    const out2 = await member.post(`${ATT}/check-out`).send({});
    expect(out2.status).toBe(200);
  });

  it('still rejects a second check-in while STILL checked in (409)', async () => {
    const owner = (await signupAgency()).agent;
    const member = (await createMemberSession(owner, { role: 'member' })).agent;
    await member.post(`${ATT}/check-in`).send({});
    const again = await member.post(`${ATT}/check-in`).send({});
    expect(again.status).toBe(409);
  });
});

describe('attendance: mandatory location (enforceGeo)', () => {
  it('blocks check-in without coordinates when location is required (403)', async () => {
    const owner = (await signupAgency()).agent;
    await owner.put(`${ATT}/policy`).send({ enforceGeo: true });
    const member = (await createMemberSession(owner, { role: 'member' })).agent;

    const noCoords = await member.post(`${ATT}/check-in`).send({});
    expect(noCoords.status).toBe(403);

    const withCoords = await member
      .post(`${ATT}/check-in`)
      .send({ lat: 19.07, lng: 72.87, location: 'Mumbai' });
    expect(withCoords.status).toBe(201);
    expect(data(withCoords).checkInLocation).toBe('Mumbai');
  });

  it('enforces the geo-fence radius when one is configured', async () => {
    const owner = (await signupAgency()).agent;
    await owner.put(`${ATT}/policy`).send({
      enforceGeo: true,
      geoLat: 19.076,
      geoLng: 72.8777,
      geoRadiusM: 200,
    });
    const member = (await createMemberSession(owner, { role: 'member' })).agent;

    // ~6 km away → outside the 200 m fence → 403.
    const far = await member
      .post(`${ATT}/check-in`)
      .send({ lat: 19.1197, lng: 72.8468 });
    expect(far.status).toBe(403);

    // At the centre → inside the fence → 201.
    const near = await member
      .post(`${ATT}/check-in`)
      .send({ lat: 19.076, lng: 72.8777 });
    expect(near.status).toBe(201);
  });
});

describe('attendance: who is in', () => {
  it('who-is-in includes a member who has punched in', async () => {
    const owner = (await signupAgency()).agent;
    const { agent: member, user } = await createMemberSession(owner, {
      role: 'member',
    });
    await member.post(`${ATT}/check-in`).send({});

    const res = await owner.get(`${ATT}/whos-in`);
    expect(res.status).toBe(200);
    const me = data(res).members.find((m: any) => m.userId === user.id);
    expect(me).toBeDefined();
    expect(me.checkInAt).toBeTruthy();
    expect(['present', 'late']).toContain(me.status);
  });

  it('a plain member cannot call who-is-in (403)', async () => {
    const owner = (await signupAgency()).agent;
    const { agent: member } = await createMemberSession(owner, {
      role: 'member',
    });
    const res = await member.get(`${ATT}/whos-in`);
    expect(res.status).toBe(403);
  });
});

describe('attendance: calendar', () => {
  let owner: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    // Saturday a workday, with the 2nd & 4th Saturday carved out.
    await owner.put(`${ATT}/policy`).send({
      workdays: [1, 2, 3, 4, 5, 6],
      saturdayOffWeeks: [2, 4],
    });
    // A holiday on a past Monday (working day) so it overrides 'absent'.
    await owner
      .post(`${ATT}/holidays`)
      .send({ day: '2025-03-10', name: 'Demo Holiday' });
  });

  it('returns a day array for a month', async () => {
    const res = await owner.get(`${ATT}/calendar?month=2025-03`);
    expect(res.status).toBe(200);
    const body = data(res);
    expect(body.month).toBe('2025-03');
    expect(Array.isArray(body.days)).toBe(true);
    expect(body.days).toHaveLength(31);
  });

  it('a configured holiday shows status "holiday"', async () => {
    const res = await owner.get(`${ATT}/calendar?month=2025-03`);
    const day = data(res).days.find((d: any) => d.day === '2025-03-10');
    expect(day.status).toBe('holiday');
    expect(day.holidayName).toBe('Demo Holiday');
  });

  it('a 2nd Saturday shows "weekly_off"; a 3rd Saturday is a working day', async () => {
    const res = await owner.get(`${ATT}/calendar?month=2025-03`);
    const days = data(res).days;
    // 2025-03-08 is the 2nd Saturday -> off.
    expect(days.find((d: any) => d.day === '2025-03-08').status).toBe(
      'weekly_off',
    );
    // 2025-03-15 is the 3rd Saturday -> a working day (past, no punch -> absent).
    const thirdSat = days.find((d: any) => d.day === '2025-03-15');
    expect(thirdSat.isWorkday).toBe(true);
    expect(thirdSat.status).toBe('absent');
  });

  it('a FUTURE day is not classified "absent"', async () => {
    // 2099-01 is unambiguously in the future for any plausible run date.
    const res = await owner.get(`${ATT}/calendar?month=2099-01`);
    expect(res.status).toBe(200);
    const days = data(res).days;
    // 2099-01-05 is a Monday (a working day) yet still in the future.
    const future = days.find((d: any) => d.day === '2099-01-05');
    expect(future.isWorkday).toBe(true);
    // The route marks unmarked today/future working days as 'none', never 'absent'.
    expect(future.status).not.toBe('absent');
    expect(future.status).toBe('none');
  });

  it('rejects a malformed month (400)', async () => {
    const res = await owner.get(`${ATT}/calendar?month=not-a-month`);
    expect(res.status).toBe(400);
  });
});

describe('attendance: holidays', () => {
  let owner: Agent;
  let member: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    member = (await createMemberSession(owner, { role: 'member' })).agent;
  });

  it('admin creates a holiday (201), visible to members and listable by year', async () => {
    const create = await owner
      .post(`${ATT}/holidays`)
      .send({ day: '2025-08-15', name: 'Independence Day' });
    expect(create.status).toBe(201);
    expect(data(create).day).toBe('2025-08-15');

    const memberList = await member.get(`${ATT}/holidays?year=2025`);
    expect(memberList.status).toBe(200);
    expect(
      data(memberList).some((h: any) => h.day === '2025-08-15'),
    ).toBe(true);

    // Listing a different year excludes it.
    const otherYear = await owner.get(`${ATT}/holidays?year=2024`);
    expect(
      data(otherYear).some((h: any) => h.day === '2025-08-15'),
    ).toBe(false);
  });

  it('a plain member cannot create a holiday (403)', async () => {
    const res = await member
      .post(`${ATT}/holidays`)
      .send({ day: '2025-09-01', name: 'Nope Day' });
    expect(res.status).toBe(403);
  });

  it('duplicate holiday on the same date is rejected (409)', async () => {
    const res = await owner
      .post(`${ATT}/holidays`)
      .send({ day: '2025-08-15', name: 'Dup' });
    expect(res.status).toBe(409);
  });
});

describe('attendance: leaves', () => {
  let ownerRes: Awaited<ReturnType<typeof signupAgency>>;
  let owner: Agent;
  let member: Agent;
  let typeId: string;

  beforeAll(async () => {
    ownerRes = await signupAgency();
    owner = ownerRes.agent;
    member = (await createMemberSession(owner, { role: 'member' })).agent;

    const t = await owner
      .post(`${LEAVES}/types`)
      .send({ name: 'Annual Leave', paid: true, annualQuota: 12 });
    expect(t.status).toBe(201);
    typeId = data(t).id;
  });

  it('a member cannot create a leave type (403)', async () => {
    const res = await member
      .post(`${LEAVES}/types`)
      .send({ name: 'Member Type' });
    expect(res.status).toBe(403);
  });

  it('member submits a leave request (201) and notifies the owner', async () => {
    const before = await unreadCount(owner);

    const res = await member.post(`${LEAVES}/`).send({
      leaveTypeId: typeId,
      startDay: '2025-03-17',
      endDay: '2025-03-18',
      reason: 'Family event',
    });
    expect(res.status).toBe(201);
    const lr = data(res);
    expect(lr.status).toBe('pending');
    expect(lr.days).toBe(2);

    const after = await unreadCount(owner);
    expect(after).toBeGreaterThan(before);
  });

  it('member lists their own leave requests', async () => {
    const res = await member.get(`${LEAVES}/`);
    expect(res.status).toBe(200);
    expect(data(res).length).toBeGreaterThanOrEqual(1);
    expect(data(res).every((r: any) => r.status !== undefined)).toBe(true);
  });

  it('a member cannot list scope=all (admins only, 403)', async () => {
    const res = await member.get(`${LEAVES}/?scope=all`);
    expect(res.status).toBe(403);
  });

  it('admin approves a leave; requester is notified and request is approved', async () => {
    // Find the pending request from the admin's queue.
    const pending = await owner.get(`${LEAVES}/?scope=pending`);
    expect(pending.status).toBe(200);
    const lr = data(pending)[0];
    expect(lr).toBeDefined();

    const memberBefore = await unreadCount(
      // re-fetch member's own count via member agent
      member,
    );

    const decide = await owner
      .post(`${LEAVES}/${lr.id}/decide`)
      .send({ decision: 'approved' });
    expect(decide.status).toBe(200);
    expect(data(decide).status).toBe('approved');

    const memberAfter = await unreadCount(member);
    expect(memberAfter).toBeGreaterThan(memberBefore);
  });

  it('a member cannot decide a leave request (403)', async () => {
    const sub = await member.post(`${LEAVES}/`).send({
      leaveTypeId: typeId,
      startDay: '2025-04-07',
      endDay: '2025-04-07',
      reason: 'Errand',
    });
    expect(sub.status).toBe(201);
    const id = data(sub).id;

    const res = await member
      .post(`${LEAVES}/${id}/decide`)
      .send({ decision: 'approved' });
    expect(res.status).toBe(403);
  });

  it('rejects a leave with startDay after endDay (400)', async () => {
    const res = await member.post(`${LEAVES}/`).send({
      leaveTypeId: typeId,
      startDay: '2025-05-10',
      endDay: '2025-05-01',
      reason: 'Backwards range',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a leave with a malformed date (422/400)', async () => {
    const res = await member.post(`${LEAVES}/`).send({
      leaveTypeId: typeId,
      startDay: '2025-5-1', // not zero-padded -> fails the YYYY-MM-DD regex
      endDay: '2025-05-02',
      reason: 'Bad format',
    });
    expect([400, 422]).toContain(res.status);
  });

  it('balances reflect approved leave usage', async () => {
    const res = await member.get(`${LEAVES}/balances?year=2025`);
    expect(res.status).toBe(200);
    const bal = data(res).balances.find((b: any) => b.leaveTypeId === typeId);
    expect(bal).toBeDefined();
    expect(bal.annualQuota).toBe(12);
    // The approved 2-day request above should be counted as used.
    expect(bal.used).toBeGreaterThanOrEqual(2);
  });
});

describe('attendance: regularizations', () => {
  let owner: Agent;
  let member: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    member = (await createMemberSession(owner, { role: 'member' })).agent;
  });

  it('member submits a regularization (201) and notifies the owner', async () => {
    const before = await unreadCount(owner);
    const res = await member.post(`${REG}/`).send({
      day: '2025-03-12',
      type: 'missed_punch',
      requestedCheckInAt: '2025-03-12T09:30:00.000Z',
      requestedCheckOutAt: '2025-03-12T18:00:00.000Z',
      reason: 'Forgot to punch in',
    });
    expect(res.status).toBe(201);
    expect(data(res).status).toBe('pending');
    expect(data(res).type).toBe('missed_punch');

    const after = await unreadCount(owner);
    expect(after).toBeGreaterThan(before);
  });

  it('a duplicate pending regularization for the same day is rejected (409)', async () => {
    const res = await member.post(`${REG}/`).send({
      day: '2025-03-12',
      type: 'late',
      reason: 'Another one',
    });
    expect(res.status).toBe(409);
  });

  it('rejects a regularization with too-short reason (422/400)', async () => {
    const res = await member.post(`${REG}/`).send({
      day: '2025-03-13',
      type: 'late',
      reason: 'x', // min 3 chars
    });
    expect([400, 422]).toContain(res.status);
  });

  it('admin approves a regularization; requester is notified', async () => {
    const pending = await owner.get(`${REG}/?scope=pending`);
    expect(pending.status).toBe(200);
    const reg = data(pending).find((r: any) => r.day === '2025-03-12');
    expect(reg).toBeDefined();

    const memberBefore = await unreadCount(member);
    const decide = await owner
      .post(`${REG}/${reg.id}/decide`)
      .send({ decision: 'approved' });
    expect(decide.status).toBe(200);
    expect(data(decide).status).toBe('approved');
    const memberAfter = await unreadCount(member);
    expect(memberAfter).toBeGreaterThan(memberBefore);

    // The approval should have written the day into the member's record.
    const cal = await member.get(`${ATT}/calendar?month=2025-03`);
    const day = data(cal).days.find((d: any) => d.day === '2025-03-12');
    expect(day.checkInAt).toBeTruthy();
    expect(day.source).toBe('regularized');
  });

  it('admin can reject a regularization', async () => {
    const sub = await member.post(`${REG}/`).send({
      day: '2025-03-20',
      type: 'late',
      reason: 'Heavy traffic',
    });
    expect(sub.status).toBe(201);
    const id = data(sub).id;

    const res = await owner
      .post(`${REG}/${id}/decide`)
      .send({ decision: 'rejected', note: 'Not enough detail' });
    expect(res.status).toBe(200);
    expect(data(res).status).toBe('rejected');
  });

  it('a member cannot decide a regularization (403)', async () => {
    const sub = await member.post(`${REG}/`).send({
      day: '2025-03-25',
      type: 'late',
      reason: 'Slept in',
    });
    expect(sub.status).toBe(201);
    const id = data(sub).id;

    const res = await member
      .post(`${REG}/${id}/decide`)
      .send({ decision: 'approved' });
    expect(res.status).toBe(403);
  });
});

describe('attendance: notifications', () => {
  let owner: Agent;
  let member: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    member = (await createMemberSession(owner, { role: 'member' })).agent;
    // Generate a couple of notifications for the owner via member submissions.
    const t = await owner
      .post(`${LEAVES}/types`)
      .send({ name: 'Casual', annualQuota: 0 });
    const typeId = data(t).id;
    await member.post(`${LEAVES}/`).send({
      leaveTypeId: typeId,
      startDay: '2025-03-17',
      endDay: '2025-03-17',
      reason: 'One',
    });
    await member.post(`${REG}/`).send({
      day: '2025-03-19',
      type: 'late',
      reason: 'Two',
    });
  });

  it('owner lists notifications and has a positive unread count', async () => {
    const list = await owner.get(`${NOTIF}/`);
    expect(list.status).toBe(200);
    expect(data(list).length).toBeGreaterThanOrEqual(2);

    const count = await unreadCount(owner);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('marking one notification read decrements the unread count', async () => {
    const before = await unreadCount(owner);
    expect(before).toBeGreaterThan(0);

    const unread = await owner.get(`${NOTIF}/?unreadOnly=true`);
    const first = data(unread)[0];
    expect(first).toBeDefined();
    expect(first.readAt).toBeNull();

    const mark = await owner.post(`${NOTIF}/${first.id}/read`);
    expect(mark.status).toBe(200);

    const after = await unreadCount(owner);
    expect(after).toBe(before - 1);
  });

  it('mark-all read zeroes the unread count', async () => {
    const res = await owner.post(`${NOTIF}/read-all`);
    expect(res.status).toBe(200);
    expect(await unreadCount(owner)).toBe(0);
  });
});

describe('attendance: tenant isolation', () => {
  it("agency B admin cannot see agency A's attendance, leaves, or regularizations", async () => {
    // Agency A: a member punches in, takes leave, raises a regularization.
    const a = await signupAgency();
    const aOwner = a.agent;
    const { agent: aMember, user: aMemberUser } = await createMemberSession(
      aOwner,
      { role: 'member' },
    );
    await aMember.post(`${ATT}/check-in`).send({});

    const aType = await aOwner
      .post(`${LEAVES}/types`)
      .send({ name: 'Secret Leave' });
    await aMember.post(`${LEAVES}/`).send({
      leaveTypeId: data(aType).id,
      startDay: '2025-03-17',
      endDay: '2025-03-17',
      reason: 'A only',
    });
    await aMember.post(`${REG}/`).send({
      day: '2025-03-18',
      type: 'late',
      reason: 'A only reg',
    });

    // Agency B is a separate tenant.
    const bOwner = (await signupAgency()).agent;

    // B's who's-in only lists B's members (A's member absent).
    const whosIn = await bOwner.get(`${ATT}/whos-in`);
    expect(whosIn.status).toBe(200);
    expect(
      data(whosIn).members.some((m: any) => m.userId === aMemberUser.id),
    ).toBe(false);

    // B sees none of A's leaves or regularizations.
    const bLeaves = await bOwner.get(`${LEAVES}/?scope=all`);
    expect(bLeaves.status).toBe(200);
    expect(data(bLeaves)).toHaveLength(0);

    const bRegs = await bOwner.get(`${REG}/?scope=all`);
    expect(bRegs.status).toBe(200);
    expect(data(bRegs)).toHaveLength(0);

    // B cannot decide A's leave (scoped by agencyId -> 404).
    const aPending = await aOwner.get(`${LEAVES}/?scope=pending`);
    const aLeaveId = data(aPending)[0].id;
    const cross = await bOwner
      .post(`${LEAVES}/${aLeaveId}/decide`)
      .send({ decision: 'approved' });
    expect([403, 404]).toContain(cross.status);
  });
});
