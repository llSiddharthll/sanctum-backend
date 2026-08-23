import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, signupAgency, data, type Agent } from './helpers';
import { sweepEndedMonths } from '../src/services/archive';

/**
 * When a month ends, incomplete tasks (and unposted content posts) are swept
 * into a month-wise archive: hidden from the active board/calendar, listed under
 * History by month, and restorable. Completed items stay active.
 */
describe('month-end archive sweep', () => {
  let owner: Agent;
  let clientId: string;
  let projectId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Arch Co' })).id;
    projectId = data(
      await owner.post(`${BASE}/projects`).send({ name: 'Arch Project', clientId }),
    ).id;
  });

  it('archives past-month incomplete tasks, keeps done + current, and lists/restores them', async () => {
    const mk = (title: string, dueDate: string, status = 'todo') =>
      owner.post(`${BASE}/projects/${projectId}/tasks`).send({
        title,
        priority: 'medium',
        assigneeId: undefined,
        dueDate,
        status,
      });

    // Two last-month tasks (one done), one this-month task, one no-due task.
    const past = data(await mk('Past incomplete', '2026-07-10'));
    const pastDone = data(await mk('Past done', '2026-07-12'));
    await owner
      .patch(`${BASE}/projects/${projectId}/tasks/${pastDone.id}`)
      .send({ status: 'done' });
    const current = data(await mk('This month', '2026-08-20'));
    const noDue = data(await mk('No due date', undefined as unknown as string));

    // Sweep as if "now" is Aug 2026 → only July's incomplete task archives.
    const swept = await sweepEndedMonths(new Date('2026-08-05T00:00:00Z'));
    expect(swept.tasks).toBeGreaterThanOrEqual(1);

    // Active board excludes the archived one.
    const active = data(await owner.get(`${BASE}/projects/all-tasks`));
    const activeIds = active.map((t: any) => t.id);
    expect(activeIds).not.toContain(past.id);
    expect(activeIds).toContain(current.id);
    expect(activeIds).toContain(noDue.id); // no due date → stays active

    // Done past task is NOT archived (it was completed).
    const doneActive = active.find((t: any) => t.id === pastDone.id);
    expect(doneActive).toBeTruthy();

    // History: archived tasks for July 2026.
    const archived = data(
      await owner.get(`${BASE}/projects/all-tasks?archived=true&month=2026-07`),
    );
    const arch = archived.find((t: any) => t.id === past.id);
    expect(arch).toBeTruthy();
    expect(arch.archivedMonth).toBe('2026-07');
    expect(arch.archivedAt).toBeTruthy();

    // The mobile app reads the caller's own archive via /me/tasks?archived=true.
    const mine = data(await owner.get(`${BASE}/me/tasks?archived=true`));
    const myArch = mine.find((t: any) => t.id === past.id);
    expect(myArch).toBeTruthy();
    expect(myArch.archivedMonth).toBe('2026-07');
    // And the active /me/tasks excludes it.
    const myActive = data(await owner.get(`${BASE}/me/tasks`));
    expect(myActive.map((t: any) => t.id)).not.toContain(past.id);

    // Restore it → back on the active board, out of the archive.
    const restore = await owner.post(`${BASE}/projects/tasks/${past.id}/unarchive`).send({});
    expect(restore.status).toBe(200);
    const active2 = data(await owner.get(`${BASE}/projects/all-tasks`));
    expect(active2.map((t: any) => t.id)).toContain(past.id);
    const archived2 = data(await owner.get(`${BASE}/projects/all-tasks?archived=true`));
    expect(archived2.map((t: any) => t.id)).not.toContain(past.id);
  });

  it('archives unposted past-month content posts and hides them from the calendar', async () => {
    // A past-month post (unposted) + a past-month posted one.
    const p1 = data(
      await owner.post(`${BASE}/clients/${clientId}/posts`).send({
        postType: 'reel',
        caption: 'Old draft reel',
        scheduledAt: '2026-06-10T09:00:00.000Z',
        status: 'scheduled',
      }),
    );
    const p2 = data(
      await owner.post(`${BASE}/clients/${clientId}/posts`).send({
        postType: 'post',
        caption: 'Old posted',
        scheduledAt: '2026-06-12T09:00:00.000Z',
        status: 'scheduled',
      }),
    );
    await owner
      .post(`${BASE}/clients/${clientId}/posts/${p2.id}/transition`)
      .send({ to: 'posted' });

    await sweepEndedMonths(new Date('2026-08-05T00:00:00Z'));

    // Active calendar (no archived filter) excludes the archived unposted one.
    const active = data(await owner.get(`${BASE}/clients/${clientId}/posts`));
    const activeIds = active.map((p: any) => p.id);
    expect(activeIds).not.toContain(p1.id);
    expect(activeIds).toContain(p2.id); // posted → stays

    // History for June 2026 has the archived post.
    const hist = data(
      await owner.get(`${BASE}/clients/${clientId}/posts?archived=true&month=2026-06`),
    );
    const h = hist.find((p: any) => p.id === p1.id);
    expect(h).toBeTruthy();
    expect(h.archivedMonth).toBe('2026-06');

    // Restore.
    const r = await owner.post(`${BASE}/clients/${clientId}/posts/${p1.id}/unarchive`).send({});
    expect(r.status).toBe(200);
    const active2 = data(await owner.get(`${BASE}/clients/${clientId}/posts`));
    expect(active2.map((p: any) => p.id)).toContain(p1.id);
  });
});
