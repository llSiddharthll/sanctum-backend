import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  signupAgency,
  createMemberSession,
  data,
  type Agent,
} from './helpers';
import type { Grant } from '../src/authz/catalog';
import { addDays, dayStartInTz } from '../src/routes/timers';

/**
 * Timesheet endpoints: GET /timers/logs, POST /timers/logs,
 * PATCH/DELETE /timers/logs/:id, GET /timers/summary.
 * Own entries are self-service; other people's time needs organization-wide
 * time_logs.view; nothing crosses agencies.
 */

const g = (permission: string, scope: Grant['scope']): Grant => ({ permission, scope });

/** An everyday team member: own timer + own logs. */
const STAFF: Grant[] = [
  g('projects.view', 'organization'),
  g('tasks.view', 'organization'),
  g('timers.use', 'own'),
  g('time_logs.view', 'own'),
  g('time_logs.update', 'own'),
  g('time_logs.delete', 'own'),
];

const TZ = 'Asia/Kolkata'; // default attendance policy timezone
const todayKey = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );

async function makeProject(agent: Agent, name = 'Timesheet Project') {
  const client = await agent.post(`${BASE}/clients`).send({ name: `${name} client` });
  expect(client.status).toBe(201);
  const res = await agent.post(`${BASE}/projects`).send({ name, clientId: data(client).id });
  expect(res.status).toBe(201);
  return data(res).id as string;
}

describe('timesheet day math', () => {
  it('local midnight in Asia/Kolkata is 18:30 UTC the day before', () => {
    expect(dayStartInTz('2026-11-09', TZ).toISOString()).toBe('2026-11-08T18:30:00.000Z');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('timesheet: own entries', () => {
  let owner: Agent;
  let projectId: string;
  let taskId: string;
  let a: Awaited<ReturnType<typeof createMemberSession>>;
  let b: Awaited<ReturnType<typeof createMemberSession>>;
  const today = todayKey();
  const yesterday = addDays(today, -1);
  const range = `from=${addDays(today, -6)}&to=${today}`;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    projectId = await makeProject(owner);
    const t = await owner.post(`${BASE}/projects/${projectId}/tasks`).send({ title: 'Design banner' });
    expect(t.status).toBe(201);
    taskId = data(t).id;
    a = await createMemberSession(owner, { grants: STAFF, fullName: 'Asha Staff' });
    b = await createMemberSession(owner, { grants: STAFF, fullName: 'Bala Staff' });
  });

  it('adds manual entries (minutes, or start/end) and lists them with names and day totals', async () => {
    const m = await a.agent
      .post(`${BASE}/timers/logs`)
      .send({ projectId, taskId, date: today, minutes: 90, note: 'First draft' });
    expect(m.status).toBe(201);
    expect(data(m)).toMatchObject({
      minutes: 90,
      day: today,
      projectName: 'Timesheet Project',
      taskTitle: 'Design banner',
      note: 'First draft',
      capabilities: { 'time_logs.update': true, 'time_logs.delete': true },
    });

    const se = await a.agent
      .post(`${BASE}/timers/logs`)
      .send({ projectId, date: yesterday, startTime: '10:15', endTime: '12:00' });
    expect(se.status).toBe(201);
    expect(data(se).minutes).toBe(105);
    expect(data(se).day).toBe(yesterday);
    expect(data(se).workDate).toBe(
      new Date(dayStartInTz(yesterday, TZ).getTime() + (10 * 60 + 15) * 60000).toISOString(),
    );

    const list = data(await a.agent.get(`${BASE}/timers/logs?${range}`));
    expect(list.user.name).toBe('Asha Staff');
    expect(list.totalMinutes).toBe(195);
    expect(list.days).toHaveLength(7);
    expect(list.days.find((d: any) => d.date === today).minutes).toBe(90);
    expect(list.days.find((d: any) => d.date === yesterday).minutes).toBe(105);
    expect(list.logs.map((l: any) => l.minutes).sort()).toEqual([105, 90]);
    expect(list.dailyTargetMinutes).toBe(480);
    expect(list.targetMinutes).toBe(list.workingDays.length * 480);

    // B sees none of A's entries in their own sheet.
    const bl = data(await b.agent.get(`${BASE}/timers/logs?${range}`));
    expect(bl.logs).toHaveLength(0);
  });

  it('includes timer-stopped entries alongside manual ones', async () => {
    expect((await b.agent.post(`${BASE}/timers/start`).send({ projectId, taskId })).status).toBe(201);
    expect((await b.agent.post(`${BASE}/timers/stop`)).status).toBe(200);
    const bl = data(await b.agent.get(`${BASE}/timers/logs?${range}`));
    expect(bl.logs).toHaveLength(1);
    expect(bl.logs[0]).toMatchObject({ taskTitle: 'Design banner', minutes: 1, day: today });
  });

  it('validates manual entries', async () => {
    const post = (body: Record<string, unknown>) => a.agent.post(`${BASE}/timers/logs`).send(body);
    expect((await post({ projectId, date: today })).status).toBe(422);
    expect((await post({ projectId, date: today, startTime: '12:00', endTime: '11:00' })).status).toBe(422);
    expect((await post({ projectId, date: today, startTime: '12:00' })).status).toBe(422);
    expect((await post({ projectId, date: '2026-02-31x', minutes: 5 })).status).toBe(422);
    expect((await post({ projectId, date: today, minutes: 0 })).status).toBe(422);
    expect((await post({ projectId, date: addDays(today, 2), minutes: 30 })).status).toBe(400);
    expect((await post({ projectId: 'prj_nope', date: today, minutes: 30 })).status).toBe(404);
    expect((await a.agent.get(`${BASE}/timers/logs?from=${today}&to=${yesterday}`)).status).toBe(400);
    expect((await a.agent.get(`${BASE}/timers/logs?from=2026-01-01&to=2026-12-31`)).status).toBe(400);
  });

  it('needs the project to be visible to log time on it', async () => {
    const timerOnly = await createMemberSession(owner, { grants: [g('timers.use', 'own')] });
    const res = await timerOnly.agent.post(`${BASE}/timers/logs`).send({ projectId, date: today, minutes: 30 });
    expect(res.status).toBe(404);
  });

  it('edits and deletes own entries only; owner can manage anyone\'s', async () => {
    const e = data(
      await a.agent.post(`${BASE}/timers/logs`).send({ projectId, date: today, minutes: 30, note: 'edit me' }),
    );

    const moved = await a.agent
      .patch(`${BASE}/timers/logs/${e.id}`)
      .send({ minutes: 45, date: yesterday, taskId, note: 'moved' });
    expect(moved.status).toBe(200);
    expect(data(moved)).toMatchObject({ minutes: 45, day: yesterday, taskId, note: 'moved' });

    // Note-only edit (the legacy body shape) still works.
    expect((await a.agent.patch(`${BASE}/timers/logs/${e.id}`).send({ note: null })).status).toBe(200);

    // B cannot see (404) — so cannot edit or delete — A's entry.
    expect((await b.agent.patch(`${BASE}/timers/logs/${e.id}`).send({ minutes: 1 })).status).toBe(404);
    expect((await b.agent.delete(`${BASE}/timers/logs/${e.id}`)).status).toBe(404);

    expect((await a.agent.delete(`${BASE}/timers/logs/${e.id}`)).status).toBe(200);
    expect((await a.agent.delete(`${BASE}/timers/logs/${e.id}`)).status).toBe(404);

    const other = data(await b.agent.post(`${BASE}/timers/logs`).send({ projectId, date: today, minutes: 20 }));
    expect((await owner.delete(`${BASE}/timers/logs/${other.id}`)).status).toBe(200);
  });

  it('team time (others\' logs + summary) is managers-only', async () => {
    expect((await a.agent.get(`${BASE}/timers/logs?userId=${b.user.id}`)).status).toBe(403);
    expect((await a.agent.get(`${BASE}/timers/summary`)).status).toBe(403);

    const asOwner = data(await owner.get(`${BASE}/timers/logs?${range}&userId=${a.user.id}`));
    expect(asOwner.user.name).toBe('Asha Staff');
    expect(asOwner.totalMinutes).toBe(195);
    // Owner holds organization-wide update/delete.
    expect(asOwner.logs[0].capabilities['time_logs.update']).toBe(true);

    const sum = data(await owner.get(`${BASE}/timers/summary?${range}`));
    const asha = sum.people.find((p: any) => p.userId === a.user.id);
    const bala = sum.people.find((p: any) => p.userId === b.user.id);
    expect(asha).toMatchObject({ name: 'Asha Staff', totalMinutes: 195, entries: 2 });
    expect(asha.days[today]).toBe(90);
    expect(asha.days[yesterday]).toBe(105);
    expect(bala.totalMinutes).toBe(1);
    expect(sum.totalMinutes).toBe(196);
    expect(sum.days.find((d: any) => d.date === today).minutes).toBe(91);
    // People with no time still appear (so managers can spot them).
    expect(sum.people.length).toBeGreaterThanOrEqual(3);
    // Sorted by most hours first.
    expect(sum.people[0].userId).toBe(a.user.id);
  });

  it('never crosses agencies', async () => {
    const other = (await signupAgency()).agent;
    const otherProject = await makeProject(other, 'Other agency project');
    expect((await other.get(`${BASE}/timers/logs?userId=${a.user.id}`)).status).toBe(404);
    expect(
      (await other.post(`${BASE}/timers/logs`).send({ projectId, date: today, minutes: 10 })).status,
    ).toBe(404);
    expect(
      (await a.agent.post(`${BASE}/timers/logs`).send({ projectId: otherProject, date: today, minutes: 10 })).status,
    ).toBe(404);
    const sum = data(await other.get(`${BASE}/timers/summary?${range}`));
    expect(sum.people.some((p: any) => p.userId === a.user.id)).toBe(false);
    expect(sum.totalMinutes).toBe(0);
  });
});
