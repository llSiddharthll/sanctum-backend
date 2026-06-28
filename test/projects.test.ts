import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  signupAgency,
  createMemberSession,
  data,
  type Agent,
} from './helpers';

/**
 * Integration coverage for the Projects module (projects, tasks, subtasks,
 * comments, dependencies, milestones, labels, members, time tracking) plus the
 * Timers module. Mirrors test/clients.test.ts conventions.
 *
 * Notes from reading src/routes/projects.ts + src/routes/timers.ts:
 *  - The module gate is requireModuleRW('projects'): GET needs `view`, any
 *    mutation needs `manage`. Access is purely permission-based — being a
 *    projectMember does NOT widen/narrow module access.
 *  - A project REQUIRES a clientId, so each suite creates a client first.
 *  - Zod validation failures => 422; not-found => 404; forbidden => 403;
 *    conflict => 409.
 *  - Task statuses: backlog | todo | in_progress | in_review | done.
 *  - Stopping a timer bills at least 1 minute, so a time log is always written.
 */

/** Create a client and return its id (projects require one). */
async function makeClient(agent: Agent, name = 'Acme Co'): Promise<string> {
  const res = await agent.post(`${BASE}/clients`).send({ name });
  if (res.status !== 201) {
    throw new Error(`client create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return data(res).id;
}

/** Create a project under a fresh client and return its id. */
async function makeProject(
  agent: Agent,
  clientId: string,
  name = 'Website Revamp',
): Promise<string> {
  const res = await agent
    .post(`${BASE}/projects`)
    .send({ name, clientId });
  if (res.status !== 201) {
    throw new Error(`project create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return data(res).id;
}

describe('projects module', () => {
  let owner: Agent;
  let clientId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = await makeClient(owner, 'Aurora Cafe');
  });

  // ----------------------------------------------------------------
  // 1. Project CRUD
  // ----------------------------------------------------------------
  it('owner creates, lists, gets and patches a project', async () => {
    const create = await owner.post(`${BASE}/projects`).send({
      name: 'Brand Refresh',
      clientId,
      type: 'fixed_price',
      contractValue: 5000,
    });
    expect(create.status).toBe(201);
    const proj = data(create);
    expect(proj.id).toMatch(/^prj_/);
    expect(proj.clientId).toBe(clientId);
    expect(proj.name).toBe('Brand Refresh');
    expect(proj.status).toBe('planning'); // default
    expect(proj.contractValue).toBe(5000);

    const list = await owner.get(`${BASE}/projects`);
    expect(list.status).toBe(200);
    expect(data(list).some((p: any) => p.id === proj.id)).toBe(true);

    const get = await owner.get(`${BASE}/projects/${proj.id}`);
    expect(get.status).toBe(200);
    expect(data(get).name).toBe('Brand Refresh');

    const patch = await owner
      .patch(`${BASE}/projects/${proj.id}`)
      .send({ name: 'Brand Refresh 2.0', status: 'active' });
    expect(patch.status).toBe(200);
    expect(data(patch).name).toBe('Brand Refresh 2.0');
    expect(data(patch).status).toBe('active');
  });

  it('rejects creating a project for a non-existent client (404)', async () => {
    const res = await owner
      .post(`${BASE}/projects`)
      .send({ name: 'Orphan', clientId: 'cli_does_not_exist' });
    expect(res.status).toBe(404);
  });

  it('rejects an invalid project body (422)', async () => {
    // Missing clientId + empty name.
    const res = await owner.post(`${BASE}/projects`).send({ name: '' });
    expect(res.status).toBe(422);
  });

  it('returns 404 for an unknown project id', async () => {
    const res = await owner.get(`${BASE}/projects/prj_nope`);
    expect(res.status).toBe(404);
  });

  // ----------------------------------------------------------------
  // 2. Tasks
  // ----------------------------------------------------------------
  it('creates, lists, reads, patches and transitions a task', async () => {
    const projectId = await makeProject(owner, clientId);

    const create = await owner
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Design homepage', priority: 'high' });
    expect(create.status).toBe(201);
    const task = data(create);
    expect(task.id).toMatch(/^ptk_/);
    expect(task.projectId).toBe(projectId);
    expect(task.status).toBe('todo'); // default status
    expect(task.priority).toBe('high');

    const list = await owner.get(`${BASE}/projects/${projectId}/tasks`);
    expect(list.status).toBe(200);
    const listed = data(list).find((t: any) => t.id === task.id);
    expect(listed).toBeTruthy();
    // Enriched list fields.
    expect(listed).toMatchObject({
      labels: [],
      subtaskCount: 0,
      blockedByCount: 0,
      commentCount: 0,
    });

    const get = await owner.get(
      `${BASE}/projects/${projectId}/tasks/${task.id}`,
    );
    expect(get.status).toBe(200);
    // Single-task detail bundle.
    expect(data(get).task.id).toBe(task.id);
    expect(Array.isArray(data(get).subtasks)).toBe(true);
    expect(Array.isArray(data(get).comments)).toBe(true);
    expect(data(get).dependencies).toMatchObject({ blockedBy: [], blocks: [] });

    const patch = await owner
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ title: 'Design landing page' });
    expect(patch.status).toBe(200);
    expect(data(patch).title).toBe('Design landing page');

    // Transition to in_progress, then done (done stamps completedAt).
    const toProgress = await owner
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ status: 'in_progress' });
    expect(toProgress.status).toBe(200);
    expect(data(toProgress).status).toBe('in_progress');
    expect(data(toProgress).completedAt).toBeNull();

    const toDone = await owner
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ status: 'done' });
    expect(toDone.status).toBe(200);
    expect(data(toDone).status).toBe('done');
    expect(data(toDone).completedAt).not.toBeNull();
  });

  it('rejects an invalid task status (422)', async () => {
    const projectId = await makeProject(owner, clientId);
    const res = await owner
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Bad', status: 'shipped' });
    expect(res.status).toBe(422);
  });

  it('returns 404 creating a task under a non-existent project', async () => {
    const res = await owner
      .post(`${BASE}/projects/prj_missing/tasks`)
      .send({ title: 'Ghost' });
    expect(res.status).toBe(404);
  });

  // ----------------------------------------------------------------
  // 3. Subtasks
  // ----------------------------------------------------------------
  it('adds a subtask, lists it under the parent and toggles it done', async () => {
    const projectId = await makeProject(owner, clientId);
    const parent = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Parent epic' }),
    );

    const subCreate = await owner
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Subtask A', parentTaskId: parent.id });
    expect(subCreate.status).toBe(201);
    const sub = data(subCreate);
    expect(sub.parentTaskId).toBe(parent.id);

    const subs = await owner.get(
      `${BASE}/projects/${projectId}/tasks/${parent.id}/subtasks`,
    );
    expect(subs.status).toBe(200);
    expect(data(subs).some((s: any) => s.id === sub.id)).toBe(true);

    const done = await owner
      .patch(`${BASE}/projects/${projectId}/tasks/${sub.id}`)
      .send({ status: 'done' });
    expect(done.status).toBe(200);
    expect(data(done).status).toBe('done');

    // Parent's enriched subtask counts should reflect the done subtask.
    const detail = await owner.get(
      `${BASE}/projects/${projectId}/tasks/${parent.id}`,
    );
    expect(data(detail).task.subtaskCount).toBe(1);
    expect(data(detail).task.subtaskDoneCount).toBe(1);
  });

  it('rejects nesting a subtask more than one level deep (422)', async () => {
    const projectId = await makeProject(owner, clientId);
    const parent = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Top' }),
    );
    const child = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Mid', parentTaskId: parent.id }),
    );
    // Attempting to parent a grandchild under the child must fail.
    const grandchild = await owner
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Bottom', parentTaskId: child.id });
    expect(grandchild.status).toBe(422);
  });

  // ----------------------------------------------------------------
  // 4. Task comments
  // ----------------------------------------------------------------
  it('adds a comment that then appears in the comment list', async () => {
    const projectId = await makeProject(owner, clientId);
    const task = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Discuss scope' }),
    );

    const add = await owner
      .post(`${BASE}/projects/${projectId}/tasks/${task.id}/comments`)
      .send({ body: 'Looks good to me.' });
    expect(add.status).toBe(201);
    const comment = data(add);
    expect(comment.id).toMatch(/^pcm_/);
    expect(comment.body).toBe('Looks good to me.');
    expect(comment.authorName).toBeTruthy();

    const list = await owner.get(
      `${BASE}/projects/${projectId}/tasks/${task.id}/comments`,
    );
    expect(list.status).toBe(200);
    expect(data(list).some((c: any) => c.id === comment.id)).toBe(true);
  });

  it('rejects an empty comment body (422)', async () => {
    const projectId = await makeProject(owner, clientId);
    const task = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'T' }),
    );
    const res = await owner
      .post(`${BASE}/projects/${projectId}/tasks/${task.id}/comments`)
      .send({ body: '   ' });
    expect(res.status).toBe(422);
  });

  // ----------------------------------------------------------------
  // 5. Dependencies
  // ----------------------------------------------------------------
  it('makes task B blocked_by task A and surfaces it both ways', async () => {
    const projectId = await makeProject(owner, clientId);
    const a = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Task A' }),
    );
    const b = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Task B' }),
    );

    // B is blocked_by A.
    const dep = await owner
      .post(`${BASE}/projects/${projectId}/tasks/${b.id}/dependencies`)
      .send({ type: 'blocked_by', otherTaskId: a.id });
    expect(dep.status).toBe(201);
    expect(data(dep).blockedBy.some((e: any) => e.task.id === a.id)).toBe(true);

    // From A's side it should surface as "blocks B".
    const aDeps = await owner.get(
      `${BASE}/projects/${projectId}/tasks/${a.id}/dependencies`,
    );
    expect(aDeps.status).toBe(200);
    expect(data(aDeps).blocks.some((e: any) => e.task.id === b.id)).toBe(true);

    // The blocked-by count is reflected in B's enriched list row.
    const list = await owner.get(`${BASE}/projects/${projectId}/tasks`);
    const bRow = data(list).find((t: any) => t.id === b.id);
    expect(bRow.blockedByCount).toBe(1);
  });

  it('rejects a dependency that would create a cycle (422)', async () => {
    const projectId = await makeProject(owner, clientId);
    const a = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'A' }),
    );
    const b = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'B' }),
    );
    // A blocks B.
    const first = await owner
      .post(`${BASE}/projects/${projectId}/tasks/${a.id}/dependencies`)
      .send({ type: 'blocks', otherTaskId: b.id });
    expect(first.status).toBe(201);

    // Now B blocks A would close a loop -> rejected.
    const cycle = await owner
      .post(`${BASE}/projects/${projectId}/tasks/${b.id}/dependencies`)
      .send({ type: 'blocks', otherTaskId: a.id });
    expect(cycle.status).toBe(422);
  });

  it('rejects a task depending on itself (422)', async () => {
    const projectId = await makeProject(owner, clientId);
    const a = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Solo' }),
    );
    const res = await owner
      .post(`${BASE}/projects/${projectId}/tasks/${a.id}/dependencies`)
      .send({ type: 'blocks', otherTaskId: a.id });
    expect(res.status).toBe(422);
  });

  // ----------------------------------------------------------------
  // 6. Milestones + labels
  // ----------------------------------------------------------------
  it('creates a milestone and links a task to it', async () => {
    const projectId = await makeProject(owner, clientId);
    const ms = await owner
      .post(`${BASE}/projects/${projectId}/milestones`)
      .send({ title: 'Phase 1' });
    expect(ms.status).toBe(201);
    const milestone = data(ms);
    expect(milestone.id).toMatch(/^pms_/);
    expect(milestone.status).toBe('pending');

    const msList = await owner.get(`${BASE}/projects/${projectId}/milestones`);
    expect(msList.status).toBe(200);
    expect(data(msList).some((m: any) => m.id === milestone.id)).toBe(true);

    // A task can reference the milestone.
    const task = await owner
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Milestone task', milestoneId: milestone.id });
    expect(task.status).toBe(201);
    expect(data(task).milestoneId).toBe(milestone.id);

    // Completing the milestone stamps completedAt.
    const complete = await owner
      .patch(`${BASE}/projects/${projectId}/milestones/${milestone.id}`)
      .send({ status: 'completed' });
    expect(complete.status).toBe(200);
    expect(data(complete).status).toBe('completed');
    expect(data(complete).completedAt).not.toBeNull();
  });

  it('creates a label and attaches it to a task', async () => {
    const projectId = await makeProject(owner, clientId);
    const label = data(
      await owner
        .post(`${BASE}/projects/${projectId}/labels`)
        .send({ name: 'urgent', color: 'rose' }),
    );
    expect(label.id).toMatch(/^plb_/);
    expect(label.color).toBe('rose');

    const task = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Tag me' }),
    );

    // PUT replaces the full label set for the task.
    const put = await owner
      .put(`${BASE}/projects/${projectId}/tasks/${task.id}/labels`)
      .send({ labelIds: [label.id] });
    expect(put.status).toBe(200);
    expect(data(put).some((l: any) => l.id === label.id)).toBe(true);

    // The label surfaces on the task's enriched list row.
    const list = await owner.get(`${BASE}/projects/${projectId}/tasks`);
    const row = data(list).find((t: any) => t.id === task.id);
    expect(row.labels.some((l: any) => l.id === label.id)).toBe(true);
  });

  it('rejects a duplicate label name in the same project (409)', async () => {
    const projectId = await makeProject(owner, clientId);
    const first = await owner
      .post(`${BASE}/projects/${projectId}/labels`)
      .send({ name: 'dup' });
    expect(first.status).toBe(201);
    const second = await owner
      .post(`${BASE}/projects/${projectId}/labels`)
      .send({ name: 'dup' });
    expect(second.status).toBe(409);
  });

  // ----------------------------------------------------------------
  // 7. Members
  // ----------------------------------------------------------------
  it('assigns a teammate as a project member and lists them', async () => {
    const projectId = await makeProject(owner, clientId);
    const { user: member } = await createMemberSession(owner, {
      fullName: 'Pat Member',
    });

    const add = await owner
      .post(`${BASE}/projects/${projectId}/members`)
      .send({ userId: member.id, role: 'contributor' });
    expect(add.status).toBe(201);
    expect(data(add).userId).toBe(member.id);
    expect(data(add).role).toBe('contributor');

    const list = await owner.get(`${BASE}/projects/${projectId}/members`);
    expect(list.status).toBe(200);
    // Owner is auto-added as 'owner' on creation; the teammate is now present too.
    expect(data(list).some((m: any) => m.userId === member.id)).toBe(true);
    expect(data(list).some((m: any) => m.role === 'owner')).toBe(true);
  });

  it('returns 404 assigning a member that is not an agency user', async () => {
    const projectId = await makeProject(owner, clientId);
    const res = await owner
      .post(`${BASE}/projects/${projectId}/members`)
      .send({ userId: 'usr_outsider' });
    expect(res.status).toBe(404);
  });

  it('lets a member with default (manage) access see and act on projects', async () => {
    // A fresh member with no permission overrides inherits full access, so they
    // can read all agency projects regardless of project membership.
    const projectId = await makeProject(owner, clientId);
    const { agent: memberAgent } = await createMemberSession(owner, {});

    const list = await memberAgent.get(`${BASE}/projects`);
    expect(list.status).toBe(200);
    expect(data(list).some((p: any) => p.id === projectId)).toBe(true);

    // And can create a task (manage access).
    const create = await memberAgent
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Member task' });
    expect(create.status).toBe(201);
  });

  // ----------------------------------------------------------------
  // 8. Timers (start / active / stop) + project time rollups
  // ----------------------------------------------------------------
  it('starts a timer on a task, reads it active, stops it and records a log', async () => {
    const projectId = await makeProject(owner, clientId);
    const task = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Timed work' }),
    );

    // Use a dedicated member so this user's single-running-timer is isolated.
    const { agent: worker, user } = await createMemberSession(owner, {
      fullName: 'Timer Worker',
    });

    const start = await worker
      .post(`${BASE}/timers/start`)
      .send({ projectId, taskId: task.id, note: 'focus block' });
    expect(start.status).toBe(201);
    const running = data(start);
    expect(running.id).toMatch(/^tmr_/);
    expect(running.projectId).toBe(projectId);
    expect(running.taskId).toBe(task.id);
    expect(running.userId).toBe(user.id);
    expect(running.elapsedMinutes).toBe(0);

    const active = await worker.get(`${BASE}/timers/active`);
    expect(active.status).toBe(200);
    expect(data(active).id).toBe(running.id);

    // The running timer shows up in the project's who's-in list.
    const projTimers = await owner.get(`${BASE}/projects/${projectId}/timers`);
    expect(projTimers.status).toBe(200);
    expect(data(projTimers).some((t: any) => t.userId === user.id)).toBe(true);

    const stop = await worker.post(`${BASE}/timers/stop`);
    expect(stop.status).toBe(200);
    expect(data(stop).stopped).toBe(true);
    expect(data(stop).minutes).toBeGreaterThanOrEqual(1); // billed >= 1 min
    expect(data(stop).timeLog.taskId).toBe(task.id);

    // After stopping, there is no active timer.
    const afterActive = await worker.get(`${BASE}/timers/active`);
    expect(afterActive.status).toBe(200);
    expect(data(afterActive)).toBeNull();

    // The project's time-summary + time-logs reflect the recorded log.
    const summary = await owner.get(
      `${BASE}/projects/${projectId}/time-summary`,
    );
    expect(summary.status).toBe(200);
    expect(data(summary).totalMinutes).toBeGreaterThanOrEqual(1);
    expect(data(summary).logCount).toBeGreaterThanOrEqual(1);
    expect(data(summary).byTask.some((t: any) => t.taskId === task.id)).toBe(
      true,
    );

    const logs = await owner.get(`${BASE}/projects/${projectId}/time-logs`);
    expect(logs.status).toBe(200);
    expect(data(logs).some((l: any) => l.taskId === task.id)).toBe(true);

    // The task-scoped timeline returns this task's logs + a summed total.
    const taskLogs = await owner.get(
      `${BASE}/projects/${projectId}/tasks/${task.id}/time-logs`,
    );
    expect(taskLogs.status).toBe(200);
    expect(data(taskLogs).totalMinutes).toBeGreaterThanOrEqual(1);
    expect(data(taskLogs).logCount).toBeGreaterThanOrEqual(1);
    expect(data(taskLogs).activeTimerCount).toBe(0);
    expect(data(taskLogs).logs[0].userId).toBe(user.id);

    // The note recorded at start carries through to the log, and can be edited.
    const logId = data(taskLogs).logs[0].id;
    const edit = await worker
      .patch(`${BASE}/timers/logs/${logId}`)
      .send({ note: 'reviewed and updated' });
    expect(edit.status).toBe(200);
    expect(data(edit).note).toBe('reviewed and updated');

    const afterEdit = await owner.get(
      `${BASE}/projects/${projectId}/tasks/${task.id}/time-logs`,
    );
    expect(data(afterEdit).logs[0].note).toBe('reviewed and updated');
  });

  it('starting a second timer auto-stops the first (one running per user)', async () => {
    const projectId = await makeProject(owner, clientId);
    const t1 = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'First' }),
    );
    const t2 = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Second' }),
    );
    const { agent: worker } = await createMemberSession(owner, {});

    const start1 = await worker
      .post(`${BASE}/timers/start`)
      .send({ projectId, taskId: t1.id });
    expect(start1.status).toBe(201);

    const start2 = await worker
      .post(`${BASE}/timers/start`)
      .send({ projectId, taskId: t2.id });
    expect(start2.status).toBe(201);

    // Only the second timer is active now.
    const active = await worker.get(`${BASE}/timers/active`);
    expect(data(active).taskId).toBe(t2.id);

    // The auto-stopped first timer produced a log on t1.
    const logs = await owner.get(`${BASE}/projects/${projectId}/time-logs`);
    expect(data(logs).some((l: any) => l.taskId === t1.id)).toBe(true);

    // Clean up the running timer for tidiness.
    await worker.post(`${BASE}/timers/stop`);
  });

  it('returns null active timer and 404 stopping when none is running', async () => {
    const { agent: worker } = await createMemberSession(owner, {});
    const active = await worker.get(`${BASE}/timers/active`);
    expect(active.status).toBe(200);
    expect(data(active)).toBeNull();

    const stop = await worker.post(`${BASE}/timers/stop`);
    expect(stop.status).toBe(404);
  });

  it('rejects starting a timer for a non-existent project (404)', async () => {
    const res = await owner
      .post(`${BASE}/timers/start`)
      .send({ projectId: 'prj_nope' });
    expect(res.status).toBe(404);
  });

  // ----------------------------------------------------------------
  // 10. Multiple assignees per task
  // ----------------------------------------------------------------
  it('supports multiple assignees with assigneeId as the primary', async () => {
    const projectId = await makeProject(owner, clientId);
    const m1 = (await createMemberSession(owner, { fullName: 'Alice A' })).user;
    const m2 = (await createMemberSession(owner, { fullName: 'Bob B' })).user;

    // Create with two assignees: assignees[] has both; assigneeId is the first.
    const create = await owner
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Ship it', assigneeIds: [m1.id, m2.id] });
    expect(create.status).toBe(201);
    const task = data(create);
    expect(task.assigneeId).toBe(m1.id);
    expect(task.assignees).toHaveLength(2);
    expect(task.assignees.map((a: any) => a.userId).sort()).toEqual(
      [m1.id, m2.id].sort(),
    );
    expect(task.assignees.find((a: any) => a.userId === m1.id).name).toBe(
      'Alice A',
    );

    // List enriches assignees too.
    const list = await owner.get(`${BASE}/projects/${projectId}/tasks`);
    const listed = data(list).find((t: any) => t.id === task.id);
    expect(listed.assignees).toHaveLength(2);

    // PATCH down to a single assignee -> primary follows the first.
    const toOne = await owner
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ assigneeIds: [m2.id] });
    expect(toOne.status).toBe(200);
    expect(data(toOne).assigneeId).toBe(m2.id);
    expect(data(toOne).assignees).toHaveLength(1);
    expect(data(toOne).assignees[0].userId).toBe(m2.id);

    // Filter ?assignee[]=m2 finds the task via the join (any assignee matches).
    const filtered = await owner.get(
      `${BASE}/projects/${projectId}/tasks?assignee[]=${m2.id}`,
    );
    expect(filtered.status).toBe(200);
    expect(data(filtered).some((t: any) => t.id === task.id)).toBe(true);

    // PATCH to an empty set -> no assignees, primary cleared.
    const toNone = await owner
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ assigneeIds: [] });
    expect(toNone.status).toBe(200);
    expect(data(toNone).assigneeId).toBeNull();
    expect(data(toNone).assignees).toEqual([]);

    // Unassigned filter now matches the task.
    const unassigned = await owner.get(
      `${BASE}/projects/${projectId}/tasks?assignee[]=unassigned`,
    );
    expect(data(unassigned).some((t: any) => t.id === task.id)).toBe(true);
  });

  it('keeps the legacy single assigneeId path working (mirrors into assignees)', async () => {
    const projectId = await makeProject(owner, clientId);
    const m1 = (await createMemberSession(owner, { fullName: 'Carol C' })).user;

    // Legacy create with assigneeId only.
    const create = await owner
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Legacy', assigneeId: m1.id });
    expect(create.status).toBe(201);
    expect(data(create).assigneeId).toBe(m1.id);
    expect(data(create).assignees).toHaveLength(1);
    expect(data(create).assignees[0].userId).toBe(m1.id);

    // Legacy PATCH clearing the assignee syncs the join to empty.
    const clear = await owner
      .patch(`${BASE}/projects/${projectId}/tasks/${data(create).id}`)
      .send({ assigneeId: null });
    expect(clear.status).toBe(200);
    expect(data(clear).assigneeId).toBeNull();
    expect(data(clear).assignees).toEqual([]);
  });
});

// ----------------------------------------------------------------
// 9. Permission gates (separate suite, fresh tenant)
// ----------------------------------------------------------------
describe('projects permissions', () => {
  let owner: Agent;
  let clientId: string;
  let projectId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = await makeClient(owner);
    projectId = await makeProject(owner, clientId);
  });

  it('denies a member with projects:none any access (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { projects: 'none' },
    });
    const res = await agent.get(`${BASE}/projects`);
    expect(res.status).toBe(403);
  });

  it('lets a projects:view member read but not create a project (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { projects: 'view' },
    });
    const list = await agent.get(`${BASE}/projects`);
    expect(list.status).toBe(200);

    const create = await agent
      .post(`${BASE}/projects`)
      .send({ name: 'Nope', clientId });
    expect(create.status).toBe(403);
  });

  it('lets a projects:view member read but not create a task (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { projects: 'view' },
    });
    const get = await agent.get(`${BASE}/projects/${projectId}`);
    expect(get.status).toBe(200);

    const create = await agent
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Should fail' });
    expect(create.status).toBe(403);
  });

  // timersRouter is now gated by requireModuleRW('projects'), so a projects:none
  // member is denied (403) when trying to start a timer (privilege leak fixed).
  it('denies a projects:none member starting a timer (module gate)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { projects: 'none' },
    });
    const res = await agent.post(`${BASE}/timers/start`).send({ projectId });
    expect(res.status).toBe(403);
    // Clean up if it actually started (so we don't leak a running timer).
    await agent.post(`${BASE}/timers/stop`);
  });
});

// ----------------------------------------------------------------
// 10. Tenant isolation (separate suite, two tenants)
// ----------------------------------------------------------------
describe('projects tenant isolation', () => {
  it("agency B cannot read or mutate agency A's project or tasks", async () => {
    const a = (await signupAgency()).agent;
    const aClient = await makeClient(a, 'A Client');
    const aProject = await makeProject(a, aClient, 'A Project');
    const aTask = data(
      await a
        .post(`${BASE}/projects/${aProject}/tasks`)
        .send({ title: 'A secret task' }),
    );

    const b = (await signupAgency()).agent;

    // Read project -> 404 (scoped by agency).
    const readProject = await b.get(`${BASE}/projects/${aProject}`);
    expect([403, 404]).toContain(readProject.status);

    // Read tasks list under A's project -> 404.
    const readTasks = await b.get(`${BASE}/projects/${aProject}/tasks`);
    expect([403, 404]).toContain(readTasks.status);

    // Read a specific task -> 404.
    const readTask = await b.get(
      `${BASE}/projects/${aProject}/tasks/${aTask.id}`,
    );
    expect([403, 404]).toContain(readTask.status);

    // Mutate A's project -> 404.
    const patch = await b
      .patch(`${BASE}/projects/${aProject}`)
      .send({ name: 'Hijacked' });
    expect([403, 404]).toContain(patch.status);

    // Start a timer against A's project from B -> 404 (project not in B's agency).
    const timer = await b.post(`${BASE}/timers/start`).send({ projectId: aProject });
    expect([403, 404]).toContain(timer.status);
  });
});
