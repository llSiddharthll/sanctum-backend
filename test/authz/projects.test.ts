import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  BASE,
  signupAgency,
  createMemberSession,
  systemRoleIdFor,
  data,
  db,
  schema,
  type Agent,
} from '../helpers';
import type { Grant } from '../../src/authz/catalog';

/**
 * Authorization scenarios for projects / tasks / comments / timers / me /
 * analytics (docs/authorization/audit/01-projects.md): allow + deny,
 * cross-tenant, object ownership, scoped lists, money fields, side effects.
 */

const g = (permission: string, scope: Grant['scope']): Grant => ({ permission, scope });

async function makeClient(agent: Agent, name = 'Acme Co'): Promise<string> {
  const res = await agent.post(`${BASE}/clients`).send({ name });
  if (res.status !== 201) throw new Error(`client create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return data(res).id;
}

async function makeProject(agent: Agent, clientId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await agent.post(`${BASE}/projects`).send({ name: 'Scoped Project', clientId, ...extra });
  if (res.status !== 201) throw new Error(`project create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return data(res).id;
}

async function makeTask(agent: Agent, projectId: string, body: Record<string, unknown> = {}) {
  const res = await agent.post(`${BASE}/projects/${projectId}/tasks`).send({ title: 'A task', ...body });
  if (res.status !== 201) throw new Error(`task create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return data(res);
}

async function addMember(owner: Agent, projectId: string, userId: string, role = 'member') {
  const res = await owner.post(`${BASE}/projects/${projectId}/members`).send({ userId, role });
  if (res.status !== 201) throw new Error(`member add failed ${res.status}: ${JSON.stringify(res.body)}`);
}

/** A contributor WITHOUT tasks.assign / structure permissions. */
const CONTRIBUTOR: Grant[] = [
  g('projects.view', 'organization'),
  g('tasks.view', 'own'),
  g('tasks.view', 'assigned'),
  g('tasks.view', 'project'),
  g('tasks.create', 'project'),
  g('tasks.update', 'own'),
  g('tasks.update', 'assigned'),
  g('tasks.delete', 'own'),
  g('task_comments.create', 'assigned'),
  g('task_comments.update', 'own'),
  g('timers.use', 'own'),
  g('time_logs.view', 'own'),
  g('time_logs.update', 'own'),
];

describe('authz: projects & tasks', () => {
  let owner: Agent;
  let clientId: string;
  let projectId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = await makeClient(owner, 'Authz Client');
    projectId = await makeProject(owner, clientId, { contractValue: 90000, billingType: 'retainer' });
  });

  it('viewer can read but cannot edit someone else\'s task (403); non-viewer gets 404', async () => {
    const task = await makeTask(owner, projectId, { title: 'Owner task' });
    const viewer = await createMemberSession(owner, {
      grants: [g('projects.view', 'organization'), g('tasks.view', 'organization')],
    });
    const read = await viewer.agent.get(`${BASE}/projects/${projectId}/tasks/${task.id}`);
    expect(read.status).toBe(200);
    expect(data(read).task.capabilities['tasks.update']).toBe(false);

    const edit = await viewer.agent
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ title: 'hijack' });
    expect(edit.status).toBe(403);

    // A contributor who is neither member, creator nor assignee cannot see it.
    const outsider = await createMemberSession(owner, { grants: CONTRIBUTOR });
    const edit2 = await outsider.agent
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ title: 'hijack' });
    expect(edit2.status).toBe(404);
  });

  it('assignee can update their assigned task but not delete it (no assignee-delete rule)', async () => {
    const c = await createMemberSession(owner, { grants: CONTRIBUTOR });
    const task = await makeTask(owner, projectId, { title: 'For contributor', assigneeIds: [c.user.id] });

    const upd = await c.agent
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ status: 'in_progress' });
    expect(upd.status).toBe(200);
    expect(data(upd).status).toBe('in_progress');
    expect(data(upd).capabilities).toMatchObject({ 'tasks.update': true, 'tasks.delete': false });

    const del = await c.agent.delete(`${BASE}/projects/${projectId}/tasks/${task.id}`);
    expect(del.status).toBe(403);
  });

  it('cannot assign other people without tasks.assign; self-only assignment is allowed', async () => {
    const c = await createMemberSession(owner, { grants: CONTRIBUTOR });
    const other = await createMemberSession(owner, { grants: CONTRIBUTOR });
    await addMember(owner, projectId, c.user.id);

    // Create with someone else as assignee → 403.
    const createOther = await c.agent
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'x', assigneeIds: [other.user.id] });
    expect(createOther.status).toBe(403);

    // Create for self → OK; created_by is recorded.
    const mine = await c.agent.post(`${BASE}/projects/${projectId}/tasks`).send({ title: 'mine' });
    expect(mine.status).toBe(201);
    expect(data(mine).createdBy).toBe(c.user.id);
    expect(data(mine).assigneeId).toBe(c.user.id);

    // Re-assigning to another person → 403; adding them alongside self → 403.
    const reassign = await c.agent
      .patch(`${BASE}/projects/${projectId}/tasks/${data(mine).id}`)
      .send({ assigneeIds: [other.user.id] });
    expect(reassign.status).toBe(403);
    const both = await c.agent
      .patch(`${BASE}/projects/${projectId}/tasks/${data(mine).id}`)
      .send({ assigneeIds: [c.user.id, other.user.id] });
    expect(both.status).toBe(403);
  });

  it('assignees must be active staff (owner with tasks.assign gets 400 for unknown users)', async () => {
    const res = await owner
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'bad assignee', assigneeIds: ['usr_nope'] });
    expect(res.status).toBe(400);
  });

  it('self-assign then delete bypass is closed (employee project member)', async () => {
    const emp = await createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')] });
    await addMember(owner, projectId, emp.user.id);
    const task = await makeTask(owner, projectId, { title: 'Protected' });

    const selfAssign = await emp.agent
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ assigneeIds: [emp.user.id] });
    expect(selfAssign.status).toBe(200);
    const del = await emp.agent.delete(`${BASE}/projects/${projectId}/tasks/${task.id}`);
    expect(del.status).toBe(403);
  });

  it('project structure edits require membership (assigned scope) for employees', async () => {
    const pid = await makeProject(owner, clientId);
    const emp = await createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')] });

    const ms = await emp.agent.post(`${BASE}/projects/${pid}/milestones`).send({ title: 'M1' });
    expect(ms.status).toBe(403);
    const patch = await emp.agent.patch(`${BASE}/projects/${pid}`).send({ name: 'Renamed' });
    expect(patch.status).toBe(403);
    const label = await emp.agent.post(`${BASE}/projects/${pid}/labels`).send({ name: 'L' });
    expect(label.status).toBe(403);

    await addMember(owner, pid, emp.user.id);
    const detail = await emp.agent.get(`${BASE}/projects/${pid}`);
    expect(data(detail).capabilities).toMatchObject({
      'projects.update': true,
      'project_milestones.manage': true,
      'projects.delete': false,
      'projects.view_financials': false,
    });
    expect((await emp.agent.post(`${BASE}/projects/${pid}/milestones`).send({ title: 'M1' })).status).toBe(201);
    expect((await emp.agent.patch(`${BASE}/projects/${pid}`).send({ name: 'Renamed' })).status).toBe(200);
    expect((await emp.agent.delete(`${BASE}/projects/${pid}`)).status).toBe(403);
  });

  it('input foreign keys are bound to the project (milestone, parent, labels, dependencies)', async () => {
    const other = await makeProject(owner, clientId);
    const foreignMs = data(await owner.post(`${BASE}/projects/${other}/milestones`).send({ title: 'X' }));
    const foreignTask = await makeTask(owner, other, { title: 'foreign' });
    const foreignLabel = data(await owner.post(`${BASE}/projects/${other}/labels`).send({ name: 'foreign' }));
    const task = await makeTask(owner, projectId, { title: 'local' });

    expect(
      (await owner.post(`${BASE}/projects/${projectId}/tasks`).send({ title: 't', milestoneId: foreignMs.id })).status,
    ).toBe(404);
    expect(
      (await owner.post(`${BASE}/projects/${projectId}/tasks`).send({ title: 't', parentTaskId: foreignTask.id })).status,
    ).toBe(404);
    expect(
      (await owner.put(`${BASE}/projects/${projectId}/tasks/${task.id}/labels`).send({ labelIds: [foreignLabel.id] })).status,
    ).toBe(422);
    expect(
      (
        await owner
          .post(`${BASE}/projects/${projectId}/tasks/${task.id}/dependencies`)
          .send({ type: 'blocks', otherTaskId: foreignTask.id })
      ).status,
    ).toBe(404);
  });

  it('comments: only the author (or organization moderators) may edit/delete', async () => {
    const c = await createMemberSession(owner, { grants: CONTRIBUTOR });
    const task = await makeTask(owner, projectId, { title: 'Discuss', assigneeIds: [c.user.id] });
    const ownerComment = data(
      await owner.post(`${BASE}/projects/${projectId}/tasks/${task.id}/comments`).send({ body: 'owner says' }),
    );
    const mine = await c.agent.post(`${BASE}/projects/${projectId}/tasks/${task.id}/comments`).send({ body: 'mine' });
    expect(mine.status).toBe(201);

    expect(
      (
        await c.agent
          .patch(`${BASE}/projects/${projectId}/tasks/${task.id}/comments/${ownerComment.id}`)
          .send({ body: 'edited' })
      ).status,
    ).toBe(403);
    expect(
      (
        await c.agent
          .patch(`${BASE}/projects/${projectId}/tasks/${task.id}/comments/${data(mine).id}`)
          .send({ body: 'edited' })
      ).status,
    ).toBe(200);
    // Organization-scope moderation (owner) may delete someone else's comment.
    expect(
      (await owner.delete(`${BASE}/projects/${projectId}/tasks/${task.id}/comments/${data(mine).id}`)).status,
    ).toBe(200);
  });

  it('lists only return rows in the actor\'s scope', async () => {
    const pid = await makeProject(owner, clientId);
    const c = await createMemberSession(owner, { grants: CONTRIBUTOR });
    const mineTask = await makeTask(owner, pid, { title: 'assigned to c', assigneeIds: [c.user.id] });
    const hidden = await makeTask(owner, pid, { title: 'not for c' });

    const board = data(await c.agent.get(`${BASE}/projects/${pid}/tasks`));
    expect(board.map((t: any) => t.id)).toEqual([mineTask.id]);
    expect(board[0].capabilities['tasks.update']).toBe(true);

    const all = data(await c.agent.get(`${BASE}/projects/all-tasks`)).map((t: any) => t.id);
    expect(all).toContain(mineTask.id);
    expect(all).not.toContain(hidden.id);

    const me = data(await c.agent.get(`${BASE}/me/tasks`)).map((t: any) => t.id);
    expect(me).toContain(mineTask.id);
    expect(me).not.toContain(hidden.id);

    const overview = data(await c.agent.get(`${BASE}/projects/${pid}/overview`));
    expect(overview.taskTotal).toBe(1);

    // Hidden task is 404 through every task route.
    expect((await c.agent.get(`${BASE}/projects/${pid}/tasks/${hidden.id}`)).status).toBe(404);
    expect((await c.agent.get(`${BASE}/projects/${pid}/tasks/${hidden.id}/comments`)).status).toBe(404);
    expect((await c.agent.get(`${BASE}/projects/${pid}/tasks/${hidden.id}/subtasks`)).status).toBe(404);

    // Activity feed does not leak entries about the hidden task.
    const activity = data(await c.agent.get(`${BASE}/projects/${pid}/activity`));
    expect(activity.some((a: any) => a.entityId === hidden.id)).toBe(false);
    expect(activity.some((a: any) => a.entityId === mineTask.id)).toBe(true);

    // Owner sees both.
    const ownerBoard = data(await owner.get(`${BASE}/projects/${pid}/tasks`)).map((t: any) => t.id);
    expect(ownerBoard).toEqual(expect.arrayContaining([mineTask.id, hidden.id]));
  });

  it('project list is filtered by projects.view scope (assigned = member)', async () => {
    const pMember = await makeProject(owner, clientId);
    const pOther = await makeProject(owner, clientId);
    const m = await createMemberSession(owner, { grants: [g('projects.view', 'assigned')] });
    await addMember(owner, pMember, m.user.id);

    const ids = data(await m.agent.get(`${BASE}/projects`)).map((p: any) => p.id);
    expect(ids).toEqual([pMember]);
    expect((await m.agent.get(`${BASE}/projects/${pOther}`)).status).toBe(404);
  });

  it('money fields are hidden without projects.view_financials and forbidden to write without update_financials', async () => {
    const emp = await createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')] });
    await addMember(owner, projectId, emp.user.id, 'lead');

    const asOwner = data(await owner.get(`${BASE}/projects/${projectId}`));
    expect(asOwner.contractValue).toBe(90000);
    expect(asOwner.billingType).toBe('retainer');
    expect(asOwner.capabilities['projects.view_financials']).toBe(true);

    const asEmp = data(await emp.agent.get(`${BASE}/projects/${projectId}`));
    expect(asEmp.contractValue).toBeNull();
    expect(asEmp.recurringPaise).toBeNull();
    expect(asEmp.billingType).toBeNull();
    const listed = data(await emp.agent.get(`${BASE}/projects`)).find((p: any) => p.id === projectId);
    expect(listed.contractValue).toBeNull();

    const write = await emp.agent.patch(`${BASE}/projects/${projectId}`).send({ contractValue: 1 });
    expect(write.status).toBe(403);
    const write2 = await emp.agent.patch(`${BASE}/projects/${projectId}`).send({ billingType: 'one_time' });
    expect(write2.status).toBe(403);
    expect(data(await owner.get(`${BASE}/projects/${projectId}`)).contractValue).toBe(90000);

    // Creating a project with money needs update_financials too.
    const creator = await createMemberSession(owner, {
      grants: [g('projects.view', 'organization'), g('projects.create', 'organization')],
    });
    const c1 = await creator.agent.post(`${BASE}/projects`).send({ name: 'P', clientId, contractValue: 5 });
    expect(c1.status).toBe(403);
    const c2 = await creator.agent.post(`${BASE}/projects`).send({ name: 'P', clientId });
    expect(c2.status).toBe(201);
    expect(data(c2).contractValue).toBeNull();
  });

  it('time log note IDOR is fixed (time_logs.update own only)', async () => {
    const a = await createMemberSession(owner, { grants: CONTRIBUTOR });
    const b = await createMemberSession(owner, { grants: CONTRIBUTOR });
    expect((await a.agent.post(`${BASE}/timers/start`).send({ projectId })).status).toBe(201);
    const stop = await a.agent.post(`${BASE}/timers/stop`);
    const logId = data(stop).timeLog.id;

    const idor = await b.agent.patch(`${BASE}/timers/logs/${logId}`).send({ note: 'pwned' });
    expect([403, 404]).toContain(idor.status);
    const own = await a.agent.patch(`${BASE}/timers/logs/${logId}`).send({ note: 'mine' });
    expect(own.status).toBe(200);
    const org = await owner.patch(`${BASE}/timers/logs/${logId}`).send({ note: 'owner fix' });
    expect(org.status).toBe(200);

    // b cannot see a's logs in project time lists either (own scope only).
    const logs = data(await b.agent.get(`${BASE}/projects/${projectId}/time-logs`));
    expect(logs.some((l: any) => l.id === logId)).toBe(false);
  });

  it("completing a task stops other users' timers as the system actor", async () => {
    const worker = await createMemberSession(owner, { grants: CONTRIBUTOR });
    const task = await makeTask(owner, projectId, { title: 'Timed', assigneeIds: [worker.user.id] });
    expect((await worker.agent.post(`${BASE}/timers/start`).send({ projectId, taskId: task.id })).status).toBe(201);

    const done = await owner.patch(`${BASE}/projects/${projectId}/tasks/${task.id}`).send({ status: 'done' });
    expect(done.status).toBe(200);
    expect(data(await worker.agent.get(`${BASE}/timers/active`))).toBeNull();

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'timer.stop'), eq(schema.auditLog.actorType, 'system')));
    const ours = rows.filter((r) => (r.metadataJson ?? '').includes(task.id));
    expect(ours.length).toBe(1);
    expect(ours[0]!.actorId).toBe('system:task_completion');
  });

  it('archive-run and unarchive require tasks.archive / tasks.restore', async () => {
    const emp = await createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')] });
    expect((await emp.agent.post(`${BASE}/projects/tasks/archive-run`).send({})).status).toBe(403);

    const task = await makeTask(owner, projectId, { title: 'active one' });
    expect((await emp.agent.post(`${BASE}/projects/tasks/${task.id}/unarchive`).send({})).status).toBe(403);
    // Owner: restoring a task that is not archived is 404.
    expect((await owner.post(`${BASE}/projects/tasks/${task.id}/unarchive`).send({})).status).toBe(404);

    // tasks.archive without posts.archive sweeps tasks only.
    const archiver = await createMemberSession(owner, { grants: [g('tasks.archive', 'organization')] });
    const run = await archiver.agent.post(`${BASE}/projects/tasks/archive-run`).send({});
    expect(run.status).toBe(200);
    expect(data(run).posts).toBe(0);
  });

  it('leaderboard requires reports.view_leaderboard; attendance only with attendance.view_reports', async () => {
    const emp = await createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')] });
    expect((await emp.agent.get(`${BASE}/analytics/leaderboard`)).status).toBe(403);

    const worker = await createMemberSession(owner, { grants: CONTRIBUTOR, fullName: 'Top Performer' });
    for (let i = 0; i < 3; i++) {
      await makeTask(owner, projectId, { title: `done ${i}`, status: 'done', assigneeIds: [worker.user.id] });
    }
    const lb = await createMemberSession(owner, { grants: [g('reports.view_leaderboard', 'organization')] });
    const res = await lb.agent.get(`${BASE}/analytics/leaderboard`);
    expect(res.status).toBe(200);
    const entry = data(res).entries.find((e: any) => e.userId === worker.user.id);
    expect(entry).toBeTruthy();
    expect('attendance' in entry).toBe(false);

    const full = data(await owner.get(`${BASE}/analytics/leaderboard`));
    expect('attendance' in full.entries.find((e: any) => e.userId === worker.user.id)).toBe(true);
  });
});

describe('authz: projects cross-tenant', () => {
  it('ids from another agency are 404 (project, task, comment, time log)', async () => {
    const a = (await signupAgency()).agent;
    const aProject = await makeProject(a, await makeClient(a, 'A'));
    const aTask = await makeTask(a, aProject, { title: 'A secret' });
    const aComment = data(
      await a.post(`${BASE}/projects/${aProject}/tasks/${aTask.id}/comments`).send({ body: 'secret' }),
    );
    await a.post(`${BASE}/timers/start`).send({ projectId: aProject, taskId: aTask.id });
    const aLog = data(await a.post(`${BASE}/timers/stop`)).timeLog.id;

    const b = (await signupAgency()).agent;
    const bProject = await makeProject(b, await makeClient(b, 'B'));
    const bTask = await makeTask(b, bProject, { title: 'B task' });

    expect((await b.get(`${BASE}/projects/${aProject}`)).status).toBe(404);
    expect((await b.get(`${BASE}/projects/${aProject}/tasks`)).status).toBe(404);
    expect((await b.get(`${BASE}/projects/${aProject}/tasks/${aTask.id}`)).status).toBe(404);
    // A's task through B's project path.
    expect((await b.patch(`${BASE}/projects/${bProject}/tasks/${aTask.id}`).send({ title: 'x' })).status).toBe(404);
    // A's comment through B's task path.
    expect(
      (await b.patch(`${BASE}/projects/${bProject}/tasks/${bTask.id}/comments/${aComment.id}`).send({ body: 'x' }))
        .status,
    ).toBe(404);
    expect((await b.delete(`${BASE}/projects/${bProject}/tasks/${bTask.id}/comments/${aComment.id}`)).status).toBe(404);
    expect((await b.patch(`${BASE}/timers/logs/${aLog}`).send({ note: 'x' })).status).toBe(404);
    expect((await b.post(`${BASE}/projects/tasks/${aTask.id}/unarchive`).send({})).status).toBe(404);
    expect((await b.post(`${BASE}/timers/start`).send({ projectId: aProject })).status).toBe(404);
    // A's milestone id as a foreign key in B's task.
    const aMs = data(await a.post(`${BASE}/projects/${aProject}/milestones`).send({ title: 'A ms' }));
    expect(
      (await b.post(`${BASE}/projects/${bProject}/tasks`).send({ title: 't', milestoneId: aMs.id })).status,
    ).toBe(404);
  });
});
