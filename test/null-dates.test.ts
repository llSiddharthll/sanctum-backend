import { describe, it, expect } from 'vitest';
import { BASE, signupAgency, data } from './helpers';

/** A date sent as null means "no date" — never 1 Jan 1970. */
describe('null dates', () => {
  it('creates a task and a milestone with no due date when dueDate is null', async () => {
    const { agent: owner } = await signupAgency();
    const clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Park Gate Hotel' })).id as string;
    const projectId = data(await owner.post(`${BASE}/projects`).send({ name: 'Launch', clientId })).id as string;

    // What the web task form sends when the due date is left empty.
    const task = await owner
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Draft captions', priority: 'medium', status: 'todo', dueDate: null });
    expect(task.status).toBe(201);
    expect(data(task).dueDate ?? null).toBeNull();

    const blank = await owner.post(`${BASE}/projects/${projectId}/tasks`).send({ title: 'Shoot reel', dueDate: '' });
    expect(blank.status).toBe(201);
    expect(data(blank).dueDate ?? null).toBeNull();

    const dated = await owner
      .post(`${BASE}/projects/${projectId}/tasks`)
      .send({ title: 'Publish', dueDate: '2026-12-01T00:00:00.000Z' });
    expect(data(dated).dueDate).toBe('2026-12-01T00:00:00.000Z');

    const ms = await owner.post(`${BASE}/projects/${projectId}/milestones`).send({ title: 'Phase 1', dueDate: null });
    expect(ms.status).toBe(201);
    expect(data(ms).dueDate ?? null).toBeNull();
  });
});
