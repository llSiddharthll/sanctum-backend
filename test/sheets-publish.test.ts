import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  signupAgency,
  createMemberSession,
  data,
  type Agent,
} from './helpers';

/**
 * The content-calendar pipeline: publishing a "calendar" sheet creates content
 * posts + assigned tasks (linked by task.postId), notifies the assignee, is
 * idempotent, skips reserved days, and flips the post to 'posted' when the task
 * is completed.
 */

async function makeClient(agent: Agent, name = 'Cal Client'): Promise<string> {
  return data(await agent.post(`${BASE}/clients`).send({ name })).id;
}
async function makeProject(
  agent: Agent,
  clientId: string,
  name = 'Cal Project',
): Promise<string> {
  return data(await agent.post(`${BASE}/projects`).send({ name, clientId })).id;
}

const COLUMNS = [
  { index: 0, label: 'Date', type: 'date' },
  { index: 1, label: 'Type', type: 'select', options: ['reel', 'story', 'carousel', 'post'] },
  { index: 2, label: 'Title / Caption', type: 'text' },
  { index: 3, label: 'Platform', type: 'select', options: ['Instagram'] },
  { index: 4, label: 'Assignee', type: 'assignee' },
  { index: 5, label: 'Status', type: 'status', options: ['Planned', 'Done'] },
];
function calData(cells: Record<string, unknown>) {
  return {
    cells: {
      A1: { v: 'Date', s: { b: true } },
      B1: { v: 'Type', s: { b: true } },
      C1: { v: 'Title / Caption', s: { b: true } },
      D1: { v: 'Platform', s: { b: true } },
      E1: { v: 'Assignee', s: { b: true } },
      F1: { v: 'Status', s: { b: true } },
      ...cells,
    },
    rows: 60,
    cols: 26,
    kind: 'calendar',
    columns: COLUMNS,
  };
}

describe('sheets → calendar publish pipeline', () => {
  let owner: Agent;
  let clientId: string;
  let projectId: string;
  let memberId: string;
  let memberAgent: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = await makeClient(owner);
    projectId = await makeProject(owner, clientId);
    const m = await createMemberSession(owner, {
      permissions: { projects: 'edit', clients: 'view' },
    });
    memberId = m.user.id;
    memberAgent = m.agent;
  });

  it('publishes calendar rows into posts + assigned tasks, notifies the assignee, idempotently', async () => {
    const sheet = data(await owner.post(`${BASE}/sheets`).send({ title: 'Cal' }));
    await owner.patch(`${BASE}/sheets/${sheet.id}`).send({
      clientId,
      projectId,
      data: calData({
        A2: { v: '2026-09-01' }, B2: { v: 'reel' }, C2: { v: 'Launch reel' }, D2: { v: 'Instagram' }, E2: { v: memberId },
        A3: { v: '2026-09-05' }, B3: { v: 'post' }, C3: { v: 'Product post' }, E3: { v: memberId },
      }),
    });

    const pub = data(await owner.post(`${BASE}/sheets/${sheet.id}/publish`));
    expect(pub.postsCreated).toBe(2);
    expect(pub.tasksCreated).toBe(2);

    const posts = data(await owner.get(`${BASE}/clients/${clientId}/posts?month=2026-09`));
    const calPosts = posts.filter((p: any) => ['Launch reel', 'Product post'].includes(p.caption));
    expect(calPosts.length).toBe(2);
    expect(calPosts.every((p: any) => p.status === 'scheduled')).toBe(true);

    const tasks = data(await owner.get(`${BASE}/projects/${projectId}/tasks`));
    const calTasks = tasks.filter((t: any) => ['Launch reel', 'Product post'].includes(t.title));
    expect(calTasks.length).toBe(2);
    expect(calTasks.every((t: any) => t.assigneeId === memberId)).toBe(true);

    const notifs = data(await memberAgent.get(`${BASE}/notifications`));
    const list = Array.isArray(notifs) ? notifs : notifs.items ?? notifs.notifications ?? [];
    expect(list.some((n: any) => n.type === 'task.assigned')).toBe(true);

    // Re-publishing does not duplicate.
    const pub2 = data(await owner.post(`${BASE}/sheets/${sheet.id}/publish`));
    expect(pub2.postsCreated).toBe(0);
  });

  it('publishes with only a client linked — auto-creates a project for the tasks', async () => {
    // A brand-new client with no projects (the common case the picker showed
    // "No projects" for). Publishing should still work: a project is created.
    const soloClient = await makeClient(owner, 'No-Project Co');
    const sheet = data(await owner.post(`${BASE}/sheets`).send({ title: 'Solo Cal' }));
    await owner.patch(`${BASE}/sheets/${sheet.id}`).send({
      clientId: soloClient, // note: NO projectId
      data: calData({
        A2: { v: '2026-11-02' }, B2: { v: 'reel' }, C2: { v: 'Solo reel' }, E2: { v: memberId },
      }),
    });

    const pub = data(await owner.post(`${BASE}/sheets/${sheet.id}/publish`));
    expect(pub.postsCreated).toBe(1);
    expect(pub.tasksCreated).toBe(1);

    // The sheet is now linked to an auto-created project.
    const reloaded = data(await owner.get(`${BASE}/sheets/${sheet.id}`));
    expect(reloaded.projectId).toBeTruthy();

    // That project belongs to the client and carries the task.
    const proj = data(await owner.get(`${BASE}/projects/${reloaded.projectId}`));
    expect(proj.clientId).toBe(soloClient);
    const tasks = data(await owner.get(`${BASE}/projects/${reloaded.projectId}/tasks`));
    expect(tasks.some((t: any) => t.title === 'Solo reel')).toBe(true);
  });

  it('skips reserved days, and completing a linked task publishes its post', async () => {
    await owner.post(`${BASE}/clients/${clientId}/reservations`).send({ date: '2026-10-10', label: 'Shoot' });
    const sheet = data(await owner.post(`${BASE}/sheets`).send({ title: 'Cal2' }));
    await owner.patch(`${BASE}/sheets/${sheet.id}`).send({
      clientId,
      projectId,
      data: calData({
        A2: { v: '2026-10-01' }, B2: { v: 'reel' }, C2: { v: 'Oct reel' }, E2: { v: memberId },
        A3: { v: '2026-10-10' }, B3: { v: 'post' }, C3: { v: 'Shoot post' }, E3: { v: memberId },
      }),
    });

    const pub = data(await owner.post(`${BASE}/sheets/${sheet.id}/publish`));
    expect(pub.postsCreated).toBe(1); // the 2026-10-10 row is reserved → skipped
    expect(pub.skipped).toBe(1);

    const tasks = data(await owner.get(`${BASE}/projects/${projectId}/tasks`));
    const reelTask = tasks.find((t: any) => t.title === 'Oct reel');
    await owner.patch(`${BASE}/projects/${projectId}/tasks/${reelTask.id}`).send({ status: 'done' });

    const posts = data(await owner.get(`${BASE}/clients/${clientId}/posts?month=2026-10`));
    const reelPost = posts.find((p: any) => p.caption === 'Oct reel');
    expect(reelPost.status).toBe('posted');
  });
});
