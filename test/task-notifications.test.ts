import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, signupAgency, createMemberSession, data, type Agent } from './helpers';

/**
 * Being given a task must reach the person it lands on — in-app, and (through
 * the same notify() call) over the socket and as a device push. Before this,
 * only the calendar sheet publish notified anyone: tasks created or reassigned
 * by hand were silent, which is why assignments went unnoticed on mobile.
 */
describe('task assignment notifications', () => {
  let owner: Agent;
  let clientId: string;
  let projectId: string;
  let alice: { id: string; agent: Agent };
  let bob: { id: string; agent: Agent };

  const taskNotifs = async (agent: Agent, taskId?: string) => {
    const res = data(await agent.get(`${BASE}/notifications`));
    const list = Array.isArray(res) ? res : (res.items ?? []);
    return list.filter(
      (n: any) => n.type === 'task.assigned' && (!taskId || n.entityId === taskId),
    );
  };

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Notify Co' })).id;
    projectId = data(
      await owner.post(`${BASE}/projects`).send({ name: 'Notify Project', clientId }),
    ).id;
    const a = await createMemberSession(owner, { permissions: { projects: 'edit' } });
    const b = await createMemberSession(owner, { permissions: { projects: 'edit' } });
    alice = { id: a.user.id, agent: a.agent };
    bob = { id: b.user.id, agent: b.agent };
    for (const u of [alice.id, bob.id]) {
      await owner.post(`${BASE}/projects/${projectId}/members`).send({ userId: u });
    }
  });

  it('notifies each assignee when a task is created, with the task and its due date', async () => {
    const task = data(
      await owner.post(`${BASE}/projects/${projectId}/tasks`).send({
        title: 'Shoot the launch reel',
        assigneeIds: [alice.id, bob.id],
        dueDate: '2026-11-20',
      }),
    );

    for (const u of [alice, bob]) {
      const got = await taskNotifs(u.agent, task.id);
      expect(got).toHaveLength(1);
      expect(got[0].title).toBe('New task: Shoot the launch reel');
      expect(got[0].body).toContain('2026-11-20');
      expect(got[0].entityType).toBe('task');
    }
  });

  it('never notifies the person doing the assigning about their own task', async () => {
    const before = (await taskNotifs(alice.agent)).length;
    const task = data(
      await alice.agent.post(`${BASE}/projects/${projectId}/tasks`).send({
        title: 'Self-assigned work',
        assigneeIds: [alice.id],
      }),
    );
    expect(await taskNotifs(alice.agent, task.id)).toHaveLength(0);
    expect((await taskNotifs(alice.agent)).length).toBe(before);
  });

  it('on reassignment notifies only who is newly added, not who was already on it', async () => {
    const task = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Edit the cutdown', assigneeIds: [alice.id] }),
    );
    expect(await taskNotifs(alice.agent, task.id)).toHaveLength(1);

    // Alice stays on the task, Bob joins: only Bob hears about it.
    await owner
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ assigneeIds: [alice.id, bob.id] });

    expect(await taskNotifs(alice.agent, task.id)).toHaveLength(1); // unchanged
    expect(await taskNotifs(bob.agent, task.id)).toHaveLength(1);
  });

  it('does not re-notify when the assignee set is rewritten unchanged', async () => {
    const task = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Stable assignees', assigneeIds: [bob.id] }),
    );
    await owner
      .patch(`${BASE}/projects/${projectId}/tasks/${task.id}`)
      .send({ assigneeIds: [bob.id], priority: 'high' });

    expect(await taskNotifs(bob.agent, task.id)).toHaveLength(1);
  });

  it('carries a link to the task list so a push can open the right place', async () => {
    const task = data(
      await owner
        .post(`${BASE}/projects/${projectId}/tasks`)
        .send({ title: 'Linked task', assigneeIds: [alice.id] }),
    );
    const [n] = await taskNotifs(alice.agent, task.id);
    expect(n.link).toMatch(/\/tasks$/);
  });
});
