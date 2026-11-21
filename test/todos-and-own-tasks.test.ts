import { describe, it, expect } from 'vitest';
import { BASE, signupAgency, createMemberSession, data, systemRoleIdFor } from './helpers';

/** "Can we add our own tasks?" — private to-dos, and tasks in any visible project. */
describe('My to-dos', () => {
  it('is private to each person and supports add / tick / edit / delete', async () => {
    const { agent: owner } = await signupAgency();
    const a = await createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')], fullName: 'Asha' });
    const b = await createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')], fullName: 'Bilal' });

    const made = await a.agent.post(`${BASE}/me/todos`).send({ title: 'Prepare moodboard', dueDay: '2026-12-01' });
    expect(made.status).toBe(201);
    const id = data(made).id as string;

    expect((data(await a.agent.get(`${BASE}/me/todos`)) as Array<{ id: string }>).map((t) => t.id)).toEqual([id]);
    // Nobody else sees or touches it — not a colleague, not the owner.
    expect(data(await b.agent.get(`${BASE}/me/todos`))).toEqual([]);
    expect(data(await owner.get(`${BASE}/me/todos`))).toEqual([]);
    expect((await b.agent.patch(`${BASE}/me/todos/${id}`).send({ done: true })).status).toBe(404);
    expect((await owner.delete(`${BASE}/me/todos/${id}`)).status).toBe(404);

    const ticked = await a.agent.patch(`${BASE}/me/todos/${id}`).send({ done: true, title: 'Prepare moodboard v2' });
    expect(ticked.status).toBe(200);
    expect(data(ticked)).toMatchObject({ done: true, title: 'Prepare moodboard v2' });
    expect(data(ticked).doneAt).toBeTruthy();

    expect((await a.agent.delete(`${BASE}/me/todos/${id}`)).status).toBe(200);
    expect(data(await a.agent.get(`${BASE}/me/todos`))).toEqual([]);
  });

  it('validates input', async () => {
    const { agent: owner } = await signupAgency();
    expect((await owner.post(`${BASE}/me/todos`).send({ title: '' })).status).toBe(422);
    expect((await owner.post(`${BASE}/me/todos`).send({ title: 'x', dueDay: '1/12/2026' })).status).toBe(422);
  });
});

describe('employees add tasks to any project they can see', () => {
  it('works without being a project member', async () => {
    const { agent: owner } = await signupAgency();
    const clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Park Gate Hotel' })).id as string;
    const project = await owner.post(`${BASE}/projects`).send({ name: 'Anniversary campaign', clientId });
    expect(project.status).toBe(201);
    const projectId = data(project).id as string;

    const emp = await createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')], fullName: 'Aprajita' });
    const task = await emp.agent.post(`${BASE}/projects/${projectId}/tasks`).send({ title: 'Draft captions' });
    expect(task.status).toBe(201);
    expect(data(task).title).toBe('Draft captions');
  });
});
