import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  signupAgency,
  createMemberSession,
  data,
  type Agent,
} from '../helpers';
import { closeOverRequires, type Grant } from '../../src/authz/catalog';

/**
 * Authorization scenarios for messages/threads, documents/folders and sheets
 * (docs/authorization/audit/04-attendance-messages-docs.md §1D-1F).
 */
const g = (permission: string, scope: Grant['scope']): Grant => ({ permission, scope });
const grants = (...gs: Grant[]) => closeOverRequires(gs, 'staff');

async function member(owner: Agent, gs: Grant[]) {
  return createMemberSession(owner, { grants: grants(...gs) });
}

async function makeClient(agent: Agent, name = 'Collab Co'): Promise<string> {
  const res = await agent.post(`${BASE}/clients`).send({ name });
  if (res.status !== 201) throw new Error(`client create failed ${res.status}`);
  return data(res).id;
}

/** Plain participant: read/send/edit own/delete own, start threads. */
const PARTICIPANT: Grant[] = [
  g('messages.view', 'assigned'),
  g('messages.send', 'assigned'),
  g('messages.update', 'own'),
  g('messages.delete', 'own'),
  g('threads.create', 'organization'),
];

// ============================================================
//  Messages & threads
// ============================================================
describe('authz: messages & threads', () => {
  let owner: Agent;
  let ownerId: string;
  let a: Awaited<ReturnType<typeof member>>;
  let b: Awaited<ReturnType<typeof member>>;
  let outsider: Awaited<ReturnType<typeof member>>;
  let threadId: string;

  beforeAll(async () => {
    const s = await signupAgency();
    owner = s.agent;
    ownerId = s.user.id;
    a = await member(owner, PARTICIPANT);
    b = await member(owner, PARTICIPANT);
    outsider = await member(owner, PARTICIPANT);
    const t = await owner
      .post(`${BASE}/messages/threads`)
      .send({ subject: 'Team', participantIds: [a.user.id, b.user.id] });
    expect(t.status).toBe(201);
    threadId = data(t).id;
    expect(data(t).capabilities['threads.delete']).toBe(true);
  });

  it('non-participant gets 404 on the thread and its messages', async () => {
    expect((await outsider.agent.get(`${BASE}/messages/threads/${threadId}`)).status).toBe(404);
    expect((await outsider.agent.get(`${BASE}/messages/threads/${threadId}/messages`)).status).toBe(404);
    expect(
      (await outsider.agent.post(`${BASE}/messages/threads/${threadId}/messages`).send({ body: 'hi' })).status,
    ).toBe(404);
    const list = data(await outsider.agent.get(`${BASE}/messages/threads`));
    expect(list.some((t: any) => t.id === threadId)).toBe(false);
  });

  it('organization-scope messages.view can moderate-read without participating (but not send)', async () => {
    const mod = await member(owner, [g('messages.view', 'organization'), g('messages.send', 'assigned')]);
    expect((await mod.agent.get(`${BASE}/messages/threads/${threadId}`)).status).toBe(200);
    const all = data(await mod.agent.get(`${BASE}/messages/threads?scope=all`));
    expect(all.some((t: any) => t.id === threadId)).toBe(true);
    const send = await mod.agent.post(`${BASE}/messages/threads/${threadId}/messages`).send({ body: 'x' });
    expect(send.status).toBe(403);
  });

  it("participant can't add or remove others without manage_participants, but can leave", async () => {
    const t = data(
      await owner.post(`${BASE}/messages/threads`).send({ subject: 'Leave', participantIds: [a.user.id, b.user.id] }),
    );
    const removeOther = await a.agent
      .patch(`${BASE}/messages/threads/${t.id}`)
      .send({ removeParticipantIds: [b.user.id] });
    expect(removeOther.status).toBe(403);
    const add = await a.agent
      .patch(`${BASE}/messages/threads/${t.id}`)
      .send({ addParticipantIds: [outsider.user.id] });
    expect(add.status).toBe(403);
    const rename = await a.agent.patch(`${BASE}/messages/threads/${t.id}`).send({ subject: 'Mine now' });
    expect(rename.status).toBe(403); // threads.update: not granted
    const leave = await a.agent
      .patch(`${BASE}/messages/threads/${t.id}`)
      .send({ removeParticipantIds: [a.user.id] });
    expect(leave.status).toBe(200);
    expect((await a.agent.get(`${BASE}/messages/threads/${t.id}`)).status).toBe(404);
  });

  it('a thread can never be left with zero participants', async () => {
    const t = data(await owner.post(`${BASE}/messages/threads`).send({ subject: 'Solo', participantIds: [] }));
    const res = await owner.patch(`${BASE}/messages/threads/${t.id}`).send({ removeParticipantIds: [ownerId] });
    expect(res.status).toBe(400);
  });

  it('participants must be active staff', async () => {
    const res = await owner
      .post(`${BASE}/messages/threads`)
      .send({ subject: 'Bad', participantIds: ['usr_not_real'] });
    expect(res.status).toBe(400);
  });

  it('message edit is own only', async () => {
    const m = data(await a.agent.post(`${BASE}/messages/threads/${threadId}/messages`).send({ body: 'from a' }));
    expect(m.capabilities['messages.update']).toBe(true);
    const other = await b.agent.patch(`${BASE}/messages/threads/${threadId}/messages/${m.id}`).send({ body: 'x' });
    expect(other.status).toBe(403);
    const self = await a.agent.patch(`${BASE}/messages/threads/${threadId}/messages/${m.id}`).send({ body: 'y' });
    expect(self.status).toBe(200);
  });

  it('delete: own vs assigned vs organization', async () => {
    const send = async () =>
      data(await a.agent.post(`${BASE}/messages/threads/${threadId}/messages`).send({ body: 'del' })).id;

    // own-only participant can't delete someone else's message
    const m1 = await send();
    expect((await b.agent.delete(`${BASE}/messages/threads/${threadId}/messages/${m1}`)).status).toBe(403);
    // sender deletes own
    expect((await a.agent.delete(`${BASE}/messages/threads/${threadId}/messages/${m1}`)).status).toBe(200);

    // assigned scope: any message in a thread you participate in
    const assigned = await member(owner, [...PARTICIPANT, g('messages.delete', 'assigned')]);
    await owner.patch(`${BASE}/messages/threads/${threadId}`).send({ addParticipantIds: [assigned.user.id] });
    const m2 = await send();
    expect((await assigned.agent.delete(`${BASE}/messages/threads/${threadId}/messages/${m2}`)).status).toBe(200);

    // assigned scope does NOT reach threads you're not in
    const other = data(
      await owner.post(`${BASE}/messages/threads`).send({ subject: 'Other', participantIds: [a.user.id] }),
    );
    const m3 = data(await a.agent.post(`${BASE}/messages/threads/${other.id}/messages`).send({ body: 'x' })).id;
    expect((await assigned.agent.delete(`${BASE}/messages/threads/${other.id}/messages/${m3}`)).status).toBe(404);

    // organization scope moderates any thread, even as a non-participant
    const org = await member(owner, [g('messages.view', 'organization'), g('messages.delete', 'organization')]);
    expect((await org.agent.delete(`${BASE}/messages/threads/${other.id}/messages/${m3}`)).status).toBe(200);
  });

  it('thread delete: creator (own) or organization only', async () => {
    const t = data(await a.agent.post(`${BASE}/messages/threads`).send({ subject: 'A owns', participantIds: [b.user.id] }));
    const deleter = await member(owner, [...PARTICIPANT, g('threads.delete', 'own')]);
    await a.agent.patch(`${BASE}/messages/threads/${t.id}`).send({}); // no-op
    expect((await b.agent.delete(`${BASE}/messages/threads/${t.id}`)).status).toBe(403); // no threads.delete
    const own = data(
      await deleter.agent.post(`${BASE}/messages/threads`).send({ subject: 'D owns', participantIds: [b.user.id] }),
    );
    expect((await deleter.agent.delete(`${BASE}/messages/threads/${own.id}`)).status).toBe(200);
  });

  it('cross-tenant thread is 404', async () => {
    const other = (await signupAgency()).agent;
    expect((await other.get(`${BASE}/messages/threads/${threadId}`)).status).toBe(404);
    expect((await other.delete(`${BASE}/messages/threads/${threadId}`)).status).toBe(404);
  });
});

// ============================================================
//  Documents & folders
// ============================================================
describe('authz: documents', () => {
  let owner: Agent;
  let agencyId: string;
  const doc = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    fileUrl: `https://files.example.com/${name}.pdf`,
    ...extra,
  });

  beforeAll(async () => {
    const s = await signupAgency();
    owner = s.agent;
    agencyId = s.agency.id;
  });

  const UPLOADER: Grant[] = [
    g('documents.view', 'organization'),
    g('documents.upload', 'organization'),
    g('documents.update', 'own'),
    g('documents.delete', 'own'),
  ];

  it('update/delete: own vs organization', async () => {
    const m1 = await member(owner, UPLOADER);
    const m2 = await member(owner, UPLOADER);
    const mine = data(await m1.agent.post(`${BASE}/documents`).send(doc('m1-doc')));
    expect(mine.capabilities['documents.update']).toBe(true);
    expect((await m2.agent.patch(`${BASE}/documents/${mine.id}`).send({ name: 'x' })).status).toBe(403);
    expect((await m2.agent.delete(`${BASE}/documents/${mine.id}`)).status).toBe(403);
    expect((await m1.agent.patch(`${BASE}/documents/${mine.id}`).send({ name: 'renamed' })).status).toBe(200);

    const org = await member(owner, [...UPLOADER, g('documents.update', 'organization'), g('documents.delete', 'organization')]);
    expect((await org.agent.patch(`${BASE}/documents/${mine.id}`).send({ name: 'org' })).status).toBe(200);
    expect((await org.agent.delete(`${BASE}/documents/${mine.id}`)).status).toBe(200);
  });

  it('hidden documents are invisible without documents.view_hidden', async () => {
    const hidden = data(await owner.post(`${BASE}/documents`).send(doc('secret', { hideFromTeam: true })));
    expect(hidden.hideFromTeam).toBe(true);
    const m = await member(owner, [...UPLOADER, g('documents.update', 'organization')]);
    const list = data(await m.agent.get(`${BASE}/documents`));
    expect(list.some((d: any) => d.id === hidden.id)).toBe(false);
    expect((await m.agent.patch(`${BASE}/documents/${hidden.id}`).send({ name: 'x' })).status).toBe(404);

    const viewer = await member(owner, [...UPLOADER, g('documents.view_hidden', 'organization')]);
    const list2 = data(await viewer.agent.get(`${BASE}/documents`));
    expect(list2.some((d: any) => d.id === hidden.id)).toBe(true);
  });

  it('hiding (or moving into a hidden category) requires documents.hide_from_team', async () => {
    const m = await member(owner, UPLOADER);
    expect((await m.agent.post(`${BASE}/documents`).send(doc('h', { hideFromTeam: true }))).status).toBe(403);
    const d = data(await m.agent.post(`${BASE}/documents`).send(doc('recat')));
    expect((await m.agent.patch(`${BASE}/documents/${d.id}`).send({ category: 'nda' })).status).toBe(403);
    const moved = await owner.patch(`${BASE}/documents/${d.id}`).send({ category: 'nda' });
    expect(moved.status).toBe(200);
    expect(data(moved).hideFromTeam).toBe(true);
  });

  it('clientVisible requires documents.share_with_client (documents and folders)', async () => {
    const m = await member(owner, [...UPLOADER, g('folders.create', 'organization')]);
    expect((await m.agent.post(`${BASE}/documents`).send(doc('share', { clientVisible: true }))).status).toBe(403);
    expect((await m.agent.post(`${BASE}/documents/folders`).send({ name: 'F', clientVisible: true })).status).toBe(403);
    const d = data(await m.agent.post(`${BASE}/documents`).send(doc('share2')));
    expect((await m.agent.patch(`${BASE}/documents/${d.id}`).send({ clientVisible: true })).status).toBe(403);

    const sharer = await member(owner, [...UPLOADER, g('documents.share_with_client', 'organization')]);
    expect((await sharer.agent.post(`${BASE}/documents`).send(doc('share3', { clientVisible: true }))).status).toBe(201);
  });

  it('business-category upload requires the business create permission (rejected, not stored)', async () => {
    const clientId = await makeClient(owner);
    const m = await member(owner, [...UPLOADER, g('documents.hide_from_team', 'organization'), g('documents.view_hidden', 'organization')]);
    const res = await m.agent.post(`${BASE}/documents`).send(doc('inv', { category: 'invoice', clientId }));
    expect(res.status).toBe(403);
    const list = data(await owner.get(`${BASE}/documents`));
    expect(list.some((d: any) => d.name === 'inv')).toBe(false);

    const biller = await member(owner, [
      ...UPLOADER,
      g('documents.hide_from_team', 'organization'),
      g('documents.view_hidden', 'organization'),
      g('invoices.create', 'organization'),
    ]);
    const ok = await biller.agent.post(`${BASE}/documents`).send(doc('inv2', { category: 'invoice', clientId }));
    expect(ok.status).toBe(201);
    expect(data(ok).converted?.type).toBe('invoice');
  });

  it('foreign storage keys are rejected', async () => {
    const foreign = await owner.post(`${BASE}/documents`).send(
      doc('foreign', {
        fileUrl: 'https://res.cloudinary.com/x/raw/upload/sanctum/agc_other/documents/a.pdf',
        publicId: 'sanctum/agc_other/documents/a',
      }),
    );
    expect(foreign.status).toBe(400);
    const traversal = await owner.post(`${BASE}/documents`).send(
      doc('trav', {
        fileUrl: `https://cdn.example.com/sanctum/${agencyId}/../agc_other/a.pdf`,
        publicId: `sanctum/${agencyId}/../agc_other/a`,
      }),
    );
    expect(traversal.status).toBe(400);
    const good = await owner.post(`${BASE}/documents`).send(
      doc('good', {
        fileUrl: `https://res.cloudinary.com/x/raw/upload/sanctum/${agencyId}/documents/a.pdf`,
        publicId: `sanctum/${agencyId}/documents/a`,
      }),
    );
    expect(good.status).toBe(201);
  });

  it('cross-tenant documents and folders are 404', async () => {
    const d = data(await owner.post(`${BASE}/documents`).send(doc('tenant-a')));
    const f = data(await owner.post(`${BASE}/documents/folders`).send({ name: 'A folder' }));
    const other = (await signupAgency()).agent;
    expect((await other.patch(`${BASE}/documents/${d.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await other.delete(`${BASE}/documents/${d.id}`)).status).toBe(404);
    expect((await other.delete(`${BASE}/documents/folders/${f.id}`)).status).toBe(404);
    const list = data(await other.get(`${BASE}/documents`));
    expect(list.some((x: any) => x.id === d.id)).toBe(false);
  });
});

// ============================================================
//  Sheets
// ============================================================
describe('authz: sheets', () => {
  let owner: Agent;
  let clientId: string;

  const calData = {
    cells: { A1: { v: 'Date' }, B1: { v: 'Idea' }, A2: { v: '2026-12-01' }, B2: { v: 'Post one' } },
    rows: 10,
    cols: 5,
    kind: 'calendar',
    columns: [
      { index: 0, label: 'Date', type: 'date' },
      { index: 1, label: 'Idea', type: 'text' },
    ],
  };

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = await makeClient(owner, 'Sheet Client');
  });

  const SHEETS: Grant[] = [
    g('sheets.view', 'organization'),
    g('sheets.create', 'organization'),
    g('sheets.update', 'own'),
    g('sheets.delete', 'own'),
    g('sheets.publish', 'organization'),
  ];

  it('update/delete are own-scoped', async () => {
    const m1 = await member(owner, SHEETS);
    const m2 = await member(owner, SHEETS);
    const s = data(await m1.agent.post(`${BASE}/sheets`).send({ title: 'Mine' }));
    expect(s.capabilities['sheets.update']).toBe(true);
    expect((await m2.agent.patch(`${BASE}/sheets/${s.id}`).send({ title: 'x' })).status).toBe(403);
    expect((await m2.agent.delete(`${BASE}/sheets/${s.id}`)).status).toBe(403);
    expect((await m1.agent.delete(`${BASE}/sheets/${s.id}`)).status).toBe(200);
  });

  it('publish requires the target create permissions', async () => {
    const m = await member(owner, SHEETS);
    const s = data(await m.agent.post(`${BASE}/sheets`).send({ title: 'Cal', clientId }));
    await m.agent.patch(`${BASE}/sheets/${s.id}`).send({ data: calData });
    // sheets.publish alone: no posts.create / projects.create / tasks.create
    expect((await m.agent.post(`${BASE}/sheets/${s.id}/publish`)).status).toBe(403);
    const posts = data(await owner.get(`${BASE}/clients/${clientId}/posts?month=2026-12`));
    expect(posts.length).toBe(0);

    const publisher = await member(owner, [
      ...SHEETS,
      g('sheets.update', 'organization'),
      g('posts.create', 'organization'),
      g('projects.create', 'organization'),
      g('tasks.create', 'organization'),
    ]);
    const pub = await publisher.agent.post(`${BASE}/sheets/${s.id}/publish`);
    expect(pub.status).toBe(200);
    expect(data(pub).postsCreated).toBe(1);

    // Re-publishing overwrites existing posts/tasks → needs posts.update/tasks.update.
    expect((await publisher.agent.post(`${BASE}/sheets/${s.id}/publish`)).status).toBe(403);
    const updater = await member(owner, [
      ...SHEETS,
      g('posts.update', 'organization'),
      g('tasks.update', 'organization'),
    ]);
    const re = await updater.agent.post(`${BASE}/sheets/${s.id}/publish`);
    expect(re.status).toBe(200);
    expect(data(re).updated).toBe(1);
  });

  it('cross-tenant sheet is 404', async () => {
    const s = data(await owner.post(`${BASE}/sheets`).send({ title: 'A' }));
    const other = (await signupAgency()).agent;
    expect((await other.get(`${BASE}/sheets/${s.id}`)).status).toBe(404);
    expect((await other.post(`${BASE}/sheets/${s.id}/publish`)).status).toBe(404);
  });
});

// ============================================================
//  Self-service + health
// ============================================================
describe('authz: notifications / push / health', () => {
  it('notifications require authentication', async () => {
    const owner = (await signupAgency()).agent;
    expect((await owner.get(`${BASE}/notifications`)).status).toBe(200);
    const supertest = (await import('supertest')).default;
    const { app } = await import('../helpers');
    expect((await supertest(app).get(`${BASE}/notifications`)).status).toBe(401);
  });

  it('health no longer runs the SMTP test', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = await import('../helpers');
    const res = await supertest(app).get(`/health?test_smtp=1`);
    expect(res.status).toBe(200);
    expect(res.body.smtp).toBeUndefined();
  });
});
