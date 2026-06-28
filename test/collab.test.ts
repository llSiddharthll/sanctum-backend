import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  signupAgency,
  createMemberSession,
  data,
  type Agent,
} from './helpers';

/** Create a client under the given agent and return its id. */
async function makeClient(agent: Agent, name = 'Acme Co'): Promise<string> {
  const res = await agent.post(`${BASE}/clients`).send({ name });
  if (res.status !== 201) {
    throw new Error(`client create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return data(res).id;
}

/** Create a project under an existing client and return its id. */
async function makeProject(
  agent: Agent,
  clientId: string,
  name = 'Website Revamp',
): Promise<string> {
  const res = await agent.post(`${BASE}/projects`).send({ name, clientId });
  if (res.status !== 201) {
    throw new Error(`project create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return data(res).id;
}

// Collaboration suite: Documents, Sheets, and Messages workflows.
// Each describe block gets its own fresh tenant via signupAgency().

// ============================================================
//  DOCUMENTS
// ============================================================
describe('documents workflow', () => {
  let owner: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  it('owner creates, lists, reads, renames and deletes a document', async () => {
    const create = await owner.post(`${BASE}/documents`).send({
      name: 'Statement of Work',
      category: 'contract',
      fileUrl: 'https://res.cloudinary.com/test-cloud/raw/upload/sow.pdf',
      publicId: 'sanctum/docs/sow',
      resourceType: 'raw',
    });
    expect(create.status).toBe(201);
    const id = data(create).id;
    expect(id).toMatch(/^doc_/);
    expect(data(create).name).toBe('Statement of Work');
    expect(data(create).category).toBe('contract');
    expect(data(create).fileUrl).toBe(
      'https://res.cloudinary.com/test-cloud/raw/upload/sow.pdf',
    );

    const list = await owner.get(`${BASE}/documents`);
    expect(list.status).toBe(200);
    expect(data(list).some((d: any) => d.id === id)).toBe(true);

    // No GET /documents/:id route exists; verify via the list payload.
    const detail = data(list).find((d: any) => d.id === id);
    expect(detail?.name).toBe('Statement of Work');

    const patch = await owner
      .patch(`${BASE}/documents/${id}`)
      .send({ name: 'SOW (signed)' });
    expect(patch.status).toBe(200);
    expect(data(patch).name).toBe('SOW (signed)');

    const del = await owner.delete(`${BASE}/documents/${id}`);
    expect(del.status).toBe(200);
    expect(data(del).deleted).toBe(true);

    const after = await owner.get(`${BASE}/documents`);
    expect(data(after).some((d: any) => d.id === id)).toBe(false);
  });

  it('POST /documents/sign returns tenant-scoped signed Cloudinary params', async () => {
    const res = await owner.post(`${BASE}/documents/sign`).send({});
    expect(res.status).toBe(200);
    const signed = data(res);
    expect(typeof signed.cloudName).toBe('string');
    expect(typeof signed.apiKey).toBe('string');
    expect(typeof signed.timestamp).toBe('number');
    expect(typeof signed.signature).toBe('string');
    // Folder is forced server-side into the tenant path; body.folder is ignored.
    expect(signed.folder).toMatch(/^sanctum\/.+\/documents$/);
  });

  it('rejects an invalid create body (missing/invalid fileUrl) with 422', async () => {
    const noUrl = await owner.post(`${BASE}/documents`).send({ name: 'X' });
    expect(noUrl.status).toBe(422);

    const badUrl = await owner
      .post(`${BASE}/documents`)
      .send({ name: 'X', fileUrl: 'not-a-url' });
    expect(badUrl.status).toBe(422);
  });

  it('returns 404 when patching a non-existent document', async () => {
    const res = await owner
      .patch(`${BASE}/documents/doc_does_not_exist`)
      .send({ name: 'ghost' });
    expect(res.status).toBe(404);
  });

  it('denies a member with documents:none any access (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { documents: 'none' },
    });
    const list = await agent.get(`${BASE}/documents`);
    expect(list.status).toBe(403);

    const create = await agent.post(`${BASE}/documents`).send({
      name: 'Nope',
      fileUrl: 'https://example.test/x.pdf',
    });
    expect(create.status).toBe(403);
  });

  it('lets a documents:view member read but not create/patch (write needs manage)', async () => {
    // Owner seeds a document the view-only member can read.
    const seed = await owner.post(`${BASE}/documents`).send({
      name: 'Brand Guidelines',
      fileUrl: 'https://example.test/brand.pdf',
    });
    const seedId = data(seed).id;

    const { agent } = await createMemberSession(owner, {
      permissions: { documents: 'view' },
    });

    const list = await agent.get(`${BASE}/documents`);
    expect(list.status).toBe(200);

    expect(data(list).some((d: any) => d.id === seedId)).toBe(true);

    const create = await agent.post(`${BASE}/documents`).send({
      name: 'View cannot write',
      fileUrl: 'https://example.test/x.pdf',
    });
    expect(create.status).toBe(403);

    const patch = await agent
      .patch(`${BASE}/documents/${seedId}`)
      .send({ name: 'renamed by viewer' });
    expect(patch.status).toBe(403);
  });

  it("isolates tenants — agency B cannot read agency A's document", async () => {
    const a = (await signupAgency()).agent;
    const created = await a.post(`${BASE}/documents`).send({
      name: 'Secret A',
      fileUrl: 'https://example.test/secret-a.pdf',
    });
    const aId = data(created).id;

    const b = (await signupAgency()).agent;
    const view = await b.get(`${BASE}/documents/${aId}`);
    expect([403, 404]).toContain(view.status);

    const patch = await b
      .patch(`${BASE}/documents/${aId}`)
      .send({ name: 'hijack' });
    expect([403, 404]).toContain(patch.status);
  });
});

// ============================================================
//  SHEETS
// ============================================================
describe('sheets workflow', () => {
  let owner: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  it('owner creates, lists, reads, updates cells, renames and deletes a sheet', async () => {
    const create = await owner
      .post(`${BASE}/sheets`)
      .send({ title: 'Q3 Budget' });
    expect(create.status).toBe(201);
    const id = data(create).id;
    expect(id).toMatch(/^sht_/);
    expect(data(create).title).toBe('Q3 Budget');
    // Default grid model is returned parsed.
    expect(data(create).data).toMatchObject({ cells: {}, rows: 50, cols: 26 });

    const list = await owner.get(`${BASE}/sheets`);
    expect(list.status).toBe(200);
    expect(data(list).some((s: any) => s.id === id)).toBe(true);

    const get = await owner.get(`${BASE}/sheets/${id}`);
    expect(get.status).toBe(200);
    expect(data(get).title).toBe('Q3 Budget');

    // Update grid data (cells) — autosave style PATCH.
    const grid = { cells: { A1: 'Revenue', B1: '1000' }, rows: 60, cols: 30 };
    const updateData = await owner
      .patch(`${BASE}/sheets/${id}`)
      .send({ data: grid });
    expect(updateData.status).toBe(200);
    expect(data(updateData).data).toMatchObject(grid);

    // Rename.
    const rename = await owner
      .patch(`${BASE}/sheets/${id}`)
      .send({ title: 'Q3 Budget (final)' });
    expect(rename.status).toBe(200);
    expect(data(rename).title).toBe('Q3 Budget (final)');
    // Renaming must not wipe the previously-saved grid.
    expect(data(rename).data).toMatchObject(grid);

    const del = await owner.delete(`${BASE}/sheets/${id}`);
    expect(del.status).toBe(200);
    expect(data(del).deleted).toBe(true);

    const gone = await owner.get(`${BASE}/sheets/${id}`);
    expect(gone.status).toBe(404);
  });

  it('returns 404 for a non-existent sheet', async () => {
    const res = await owner.get(`${BASE}/sheets/sht_nope`);
    expect(res.status).toBe(404);
  });

  it('rejects an invalid sheet patch body (non-object data) with 422', async () => {
    const seed = await owner.post(`${BASE}/sheets`).send({ title: 'Validate' });
    const id = data(seed).id;
    // `data` must be a record/object; a string is invalid.
    const res = await owner
      .patch(`${BASE}/sheets/${id}`)
      .send({ data: 'not-an-object' });
    expect(res.status).toBe(422);
  });

  it('denies a member with sheets:none any access (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { sheets: 'none' },
    });
    const list = await agent.get(`${BASE}/sheets`);
    expect(list.status).toBe(403);

    const create = await agent.post(`${BASE}/sheets`).send({ title: 'Nope' });
    expect(create.status).toBe(403);
  });

  it('lets a sheets:view member read but not create/patch (write needs manage)', async () => {
    const seed = await owner.post(`${BASE}/sheets`).send({ title: 'Shared' });
    const seedId = data(seed).id;

    const { agent } = await createMemberSession(owner, {
      permissions: { sheets: 'view' },
    });

    const list = await agent.get(`${BASE}/sheets`);
    expect(list.status).toBe(200);

    const get = await agent.get(`${BASE}/sheets/${seedId}`);
    expect(get.status).toBe(200);

    const create = await agent.post(`${BASE}/sheets`).send({ title: 'Blocked' });
    expect(create.status).toBe(403);

    const patch = await agent
      .patch(`${BASE}/sheets/${seedId}`)
      .send({ title: 'viewer rename' });
    expect(patch.status).toBe(403);
  });

  it("isolates tenants — agency B cannot read or patch agency A's sheet", async () => {
    const a = (await signupAgency()).agent;
    const created = await a.post(`${BASE}/sheets`).send({ title: 'Secret A' });
    const aId = data(created).id;

    const b = (await signupAgency()).agent;
    const view = await b.get(`${BASE}/sheets/${aId}`);
    expect([403, 404]).toContain(view.status);

    const patch = await b.patch(`${BASE}/sheets/${aId}`).send({ title: 'hijack' });
    expect([403, 404]).toContain(patch.status);
  });
});

// ============================================================
//  MESSAGES
// ============================================================
describe('messages workflow', () => {
  let owner: Agent;
  let ownerUserId: string;

  beforeAll(async () => {
    const signup = await signupAgency();
    owner = signup.agent;
    ownerUserId = signup.user.id;
  });

  it('owner opens a thread with a member; member can list and read it', async () => {
    const member = await createMemberSession(owner);

    const create = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'Kickoff',
      participantIds: [member.user.id],
    });
    expect(create.status).toBe(201);
    const threadId = data(create).id;
    expect(threadId).toMatch(/^thr_/);
    // Creator is auto-included alongside the requested participant.
    const partIds = data(create).participants.map((p: any) => p.userId);
    expect(partIds).toContain(ownerUserId);
    expect(partIds).toContain(member.user.id);

    // The member participant can list and fetch the thread.
    const list = await member.agent.get(`${BASE}/messages/threads`);
    expect(list.status).toBe(200);
    expect(data(list).some((t: any) => t.id === threadId)).toBe(true);

    const get = await member.agent.get(`${BASE}/messages/threads/${threadId}`);
    expect(get.status).toBe(200);
    expect(data(get).subject).toBe('Kickoff');
  });

  it('owner sends a message; it appears in the thread and bumps recipient unread; mark-read zeroes it', async () => {
    const member = await createMemberSession(owner);

    const create = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'Status update',
      participantIds: [member.user.id],
    });
    const threadId = data(create).id;

    // Recipient starts with no unread for this fresh thread.
    const before = await member.agent.get(`${BASE}/messages/unread-count`);
    expect(before.status).toBe(200);
    const baselineUnread = data(before).count;

    const send = await owner
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({ body: 'Hello team, here is the latest.' });
    expect(send.status).toBe(201);
    expect(data(send).id).toMatch(/^msg_/);
    expect(data(send).senderId).toBe(ownerUserId);
    expect(data(send).body).toBe('Hello team, here is the latest.');

    // The message appears when listing the thread's messages.
    const msgs = await member.agent.get(
      `${BASE}/messages/threads/${threadId}/messages`,
    );
    expect(msgs.status).toBe(200);
    expect(
      data(msgs).some((m: any) => m.body === 'Hello team, here is the latest.'),
    ).toBe(true);

    // The recipient's unread count increments.
    const after = await member.agent.get(`${BASE}/messages/unread-count`);
    expect(after.status).toBe(200);
    expect(data(after).count).toBe(baselineUnread + 1);

    // The thread-level unread for the recipient is non-zero too.
    const threadView = await member.agent.get(
      `${BASE}/messages/threads/${threadId}`,
    );
    expect(data(threadView).unreadCount).toBeGreaterThanOrEqual(1);

    // Marking read zeroes the recipient's unread.
    const read = await member.agent.post(
      `${BASE}/messages/threads/${threadId}/read`,
    );
    expect(read.status).toBe(200);

    const afterRead = await member.agent.get(`${BASE}/messages/unread-count`);
    expect(data(afterRead).count).toBe(baselineUnread);

    const threadAfterRead = await member.agent.get(
      `${BASE}/messages/threads/${threadId}`,
    );
    expect(data(threadAfterRead).unreadCount).toBe(0);
  });

  it('creates a thread with an inline first message (body)', async () => {
    const member = await createMemberSession(owner);
    const create = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'With opener',
      participantIds: [member.user.id],
      body: 'Opening message',
    });
    expect(create.status).toBe(201);
    const threadId = data(create).id;
    expect(data(create).lastMessagePreview).toBe('Opening message');

    const msgs = await owner.get(
      `${BASE}/messages/threads/${threadId}/messages`,
    );
    expect(msgs.status).toBe(200);
    expect(data(msgs).some((m: any) => m.body === 'Opening message')).toBe(true);
  });

  it('rejects a thread create with an unknown participant (400)', async () => {
    const res = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'Bad participant',
      participantIds: ['usr_not_real'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty message body (422) and missing subject (422)', async () => {
    const member = await createMemberSession(owner);
    const create = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'Validation',
      participantIds: [member.user.id],
    });
    const threadId = data(create).id;

    const emptyBody = await owner
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({ body: '' });
    expect(emptyBody.status).toBe(422);

    const noSubject = await owner
      .post(`${BASE}/messages/threads`)
      .send({ participantIds: [member.user.id] });
    expect(noSubject.status).toBe(422);
  });

  it('denies a member with messages:none any access (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { messages: 'none' },
    });
    const list = await agent.get(`${BASE}/messages/threads`);
    expect(list.status).toBe(403);

    const create = await agent.post(`${BASE}/messages/threads`).send({
      subject: 'Nope',
      participantIds: [],
    });
    expect(create.status).toBe(403);
  });

  it('blocks a non-participant agency member from reading a thread (403)', async () => {
    // Owner creates a thread with memberA only.
    const memberA = await createMemberSession(owner);
    const create = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'Private',
      participantIds: [memberA.user.id],
    });
    const threadId = data(create).id;

    // memberB is in the same agency but NOT a participant.
    const memberB = await createMemberSession(owner);
    const get = await memberB.agent.get(
      `${BASE}/messages/threads/${threadId}`,
    );
    expect([403, 404]).toContain(get.status);
    // Service rule: thread exists in agency -> 403 (not a participant).
    expect(get.status).toBe(403);

    const send = await memberB.agent
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({ body: 'sneaking in' });
    expect([403, 404]).toContain(send.status);
  });

  it("isolates tenants — agency B cannot read agency A's thread (404)", async () => {
    const a = (await signupAgency()).agent;
    const created = await a.post(`${BASE}/messages/threads`).send({
      subject: 'Tenant A only',
      participantIds: [],
    });
    const aThreadId = data(created).id;

    const b = (await signupAgency()).agent;
    const get = await b.get(`${BASE}/messages/threads/${aThreadId}`);
    // Cross-agency thread is invisible -> not found.
    expect([403, 404]).toContain(get.status);
    expect(get.status).toBe(404);
  });

  it('returns 404 for a non-existent thread', async () => {
    const res = await owner.get(`${BASE}/messages/threads/thr_missing`);
    expect([403, 404]).toContain(res.status);
    expect(res.status).toBe(404);
  });
});

// ============================================================
//  MESSAGES — new surfaces (client filter, attachments, edit,
//  delete, re-link, @mentions, tenant isolation)
// ============================================================
describe('messages: new endpoints', () => {
  let owner: Agent;
  let ownerUserId: string;

  beforeAll(async () => {
    const signup = await signupAgency();
    owner = signup.agent;
    ownerUserId = signup.user.id;
  });

  // ----- module gate -----
  it('a member with messages:none is blocked from every messages route (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { messages: 'none' },
    });
    const threads = await agent.get(`${BASE}/messages/threads`);
    expect(threads.status).toBe(403);

    const create = await agent
      .post(`${BASE}/messages/threads`)
      .send({ subject: 'x', participantIds: [] });
    expect(create.status).toBe(403);

    const unread = await agent.get(`${BASE}/messages/unread-count`);
    expect(unread.status).toBe(403);
  });

  // ----- GET /messages/threads?clientId= filter -----
  it('GET /messages/threads?clientId= returns only threads linked to that client', async () => {
    const clientId = await makeClient(owner, 'Filter Client');

    const linked = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'Linked thread',
      participantIds: [],
      clientId,
    });
    expect(linked.status).toBe(201);
    const linkedId = data(linked).id;
    expect(data(linked).clientId).toBe(clientId);

    const unlinked = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'Unlinked thread',
      participantIds: [],
    });
    const unlinkedId = data(unlinked).id;

    const res = await owner.get(
      `${BASE}/messages/threads?clientId=${clientId}`,
    );
    expect(res.status).toBe(200);
    const ids = data(res).map((t: any) => t.id);
    expect(ids).toContain(linkedId);
    expect(ids).not.toContain(unlinkedId);
    // Every returned row is genuinely linked to the client.
    expect(data(res).every((t: any) => t.clientId === clientId)).toBe(true);
  });

  // ----- POST messages: attachments & validation -----
  it('POST a message with a body → 201', async () => {
    const create = await owner
      .post(`${BASE}/messages/threads`)
      .send({ subject: 'Body only', participantIds: [] });
    const threadId = data(create).id;

    const send = await owner
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({ body: 'plain text message' });
    expect(send.status).toBe(201);
    expect(data(send).body).toBe('plain text message');
    expect(data(send).attachments).toEqual([]);
  });

  it('POST a message with attachments and NO body → 201 with one attachment', async () => {
    const create = await owner
      .post(`${BASE}/messages/threads`)
      .send({ subject: 'Attachment only', participantIds: [] });
    const threadId = data(create).id;

    const send = await owner
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({
        attachments: [
          { url: 'https://x.test/a.png', type: 'image', name: 'a.png' },
        ],
      });
    expect(send.status).toBe(201);
    expect(data(send).body).toBe('');
    expect(data(send).attachments.length).toBe(1);
    expect(data(send).attachments[0].url).toBe('https://x.test/a.png');
    expect(data(send).attachments[0].type).toBe('image');

    // The thread preview shows a paperclip hint for attachment-only messages.
    const thread = await owner.get(`${BASE}/messages/threads/${threadId}`);
    expect(data(thread).lastMessagePreview).toContain('attachment');
  });

  it('POST a message with neither body nor attachments → 422', async () => {
    const create = await owner
      .post(`${BASE}/messages/threads`)
      .send({ subject: 'Empty post', participantIds: [] });
    const threadId = data(create).id;

    const send = await owner
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({});
    expect(send.status).toBe(422);
  });

  // ----- PATCH a message (edit) -----
  it('PATCH a message edits the body, sets editedAt; another participant cannot edit it (403)', async () => {
    const member = await createMemberSession(owner);
    const create = await owner
      .post(`${BASE}/messages/threads`)
      .send({ subject: 'Edit me', participantIds: [member.user.id] });
    const threadId = data(create).id;

    const send = await owner
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({ body: 'original' });
    const msgId = data(send).id;
    expect(data(send).editedAt).toBeNull();

    const edit = await owner
      .patch(`${BASE}/messages/threads/${threadId}/messages/${msgId}`)
      .send({ body: 'edited text' });
    expect(edit.status).toBe(200);
    expect(data(edit).body).toBe('edited text');
    expect(data(edit).editedAt).not.toBeNull();

    // A different participant (the member) cannot edit the owner's message.
    const otherEdit = await member.agent
      .patch(`${BASE}/messages/threads/${threadId}/messages/${msgId}`)
      .send({ body: 'hijacked' });
    expect(otherEdit.status).toBe(403);
  });

  // ----- DELETE a message: sender, non-sender member, privileged -----
  it('DELETE a message: sender deletes own (200); non-sender member denied (403); owner can delete a member message (200)', async () => {
    const member = await createMemberSession(owner);
    const memberB = await createMemberSession(owner);

    // Thread has owner + both members as participants.
    const create = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'Deletion rules',
      participantIds: [member.user.id, memberB.user.id],
    });
    const threadId = data(create).id;

    // member sends a message.
    const m1 = await member.agent
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({ body: 'member message one' });
    const m1Id = data(m1).id;

    // A non-sender plain member (memberB) cannot delete it.
    const denied = await memberB.agent.delete(
      `${BASE}/messages/threads/${threadId}/messages/${m1Id}`,
    );
    expect(denied.status).toBe(403);

    // The sender can delete their own message.
    const ownDel = await member.agent.delete(
      `${BASE}/messages/threads/${threadId}/messages/${m1Id}`,
    );
    expect(ownDel.status).toBe(200);
    expect(data(ownDel).deleted).toBe(true);

    // member sends a second message; the OWNER (privileged) can delete it.
    const m2 = await member.agent
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({ body: 'member message two' });
    const m2Id = data(m2).id;
    const adminDel = await owner.delete(
      `${BASE}/messages/threads/${threadId}/messages/${m2Id}`,
    );
    expect(adminDel.status).toBe(200);
    expect(data(adminDel).deleted).toBe(true);

    // Both are gone from the thread.
    const msgs = await owner.get(
      `${BASE}/messages/threads/${threadId}/messages`,
    );
    const remaining = data(msgs).map((m: any) => m.id);
    expect(remaining).not.toContain(m1Id);
    expect(remaining).not.toContain(m2Id);
  });

  // ----- PATCH /threads/:id re-link -----
  it('PATCH /threads/:id sets clientId; clearing client (null) also clears projectId', async () => {
    const clientId = await makeClient(owner, 'Relink Client');
    const projectId = await makeProject(owner, clientId, 'Relink Project');

    const create = await owner
      .post(`${BASE}/messages/threads`)
      .send({ subject: 'Relink me', participantIds: [] });
    const threadId = data(create).id;

    // Link a client.
    const linkClient = await owner
      .patch(`${BASE}/messages/threads/${threadId}`)
      .send({ clientId });
    expect(linkClient.status).toBe(200);
    expect(data(linkClient).clientId).toBe(clientId);

    // Link a project (belongs to the agency).
    const linkProject = await owner
      .patch(`${BASE}/messages/threads/${threadId}`)
      .send({ projectId });
    expect(linkProject.status).toBe(200);
    expect(data(linkProject).projectId).toBe(projectId);

    // Verify via GET.
    const afterLink = await owner.get(`${BASE}/messages/threads/${threadId}`);
    expect(data(afterLink).clientId).toBe(clientId);
    expect(data(afterLink).projectId).toBe(projectId);

    // Clearing the client (null) clears the orphaned project too.
    const clear = await owner
      .patch(`${BASE}/messages/threads/${threadId}`)
      .send({ clientId: null });
    expect(clear.status).toBe(200);
    expect(data(clear).clientId).toBeNull();
    expect(data(clear).projectId).toBeNull();

    const afterClear = await owner.get(`${BASE}/messages/threads/${threadId}`);
    expect(data(afterClear).clientId).toBeNull();
    expect(data(afterClear).projectId).toBeNull();
  });

  it('PATCH /threads/:id rejects a project from another agency (400)', async () => {
    const create = await owner
      .post(`${BASE}/messages/threads`)
      .send({ subject: 'Bad project link', participantIds: [] });
    const threadId = data(create).id;

    // A project belonging to a DIFFERENT agency.
    const other = await signupAgency();
    const otherClient = await makeClient(other.agent, 'Other Client');
    const otherProject = await makeProject(other.agent, otherClient, 'Other Project');

    const res = await owner
      .patch(`${BASE}/messages/threads/${threadId}`)
      .send({ projectId: otherProject });
    expect(res.status).toBe(400);
  });

  // ----- @mentions -----
  it('mentioning a participant by @FirstName creates a message.mention notification', async () => {
    // Give the member a distinctive first name to mention.
    const member = await createMemberSession(owner, {
      fullName: 'Zelda Fitzgerald',
    });
    const create = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'Mention thread',
      participantIds: [member.user.id],
    });
    const threadId = data(create).id;

    // Baseline: the member has no mention notification yet.
    const before = await member.agent.get(`${BASE}/notifications`);
    expect(before.status).toBe(200);
    const beforeCount = data(before).filter(
      (n: any) => n.type === 'message.mention',
    ).length;

    // Owner mentions @Zelda (case-insensitive first-name token).
    const send = await owner
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({ body: 'hey @zelda please review this' });
    expect(send.status).toBe(201);

    const after = await member.agent.get(`${BASE}/notifications`);
    const mentionNotifs = data(after).filter(
      (n: any) => n.type === 'message.mention',
    );
    expect(mentionNotifs.length).toBe(beforeCount + 1);
    expect(mentionNotifs[0].entityType).toBe('thread');
    expect(mentionNotifs[0].entityId).toBe(threadId);
  });

  it('does not notify a non-mentioned participant', async () => {
    const alice = await createMemberSession(owner, { fullName: 'Alice Anders' });
    const bob = await createMemberSession(owner, { fullName: 'Bob Baker' });
    const create = await owner.post(`${BASE}/messages/threads`).send({
      subject: 'Selective mention',
      participantIds: [alice.user.id, bob.user.id],
    });
    const threadId = data(create).id;

    const bobBefore = await bob.agent.get(`${BASE}/notifications`);
    const bobBaseline = data(bobBefore).filter(
      (n: any) => n.type === 'message.mention',
    ).length;

    // Mention only Alice.
    await owner
      .post(`${BASE}/messages/threads/${threadId}/messages`)
      .send({ body: '@Alice can you take this?' });

    const aliceAfter = await alice.agent.get(`${BASE}/notifications`);
    expect(
      data(aliceAfter).filter((n: any) => n.type === 'message.mention').length,
    ).toBeGreaterThanOrEqual(1);

    const bobAfter = await bob.agent.get(`${BASE}/notifications`);
    expect(
      data(bobAfter).filter((n: any) => n.type === 'message.mention').length,
    ).toBe(bobBaseline);
  });

  // ----- Tenant isolation across all the new surfaces -----
  it('isolates tenants — agency B cannot read/patch/delete agency A thread or messages', async () => {
    const a = await signupAgency();
    const aThread = await a.agent.post(`${BASE}/messages/threads`).send({
      subject: 'Agency A thread',
      participantIds: [],
    });
    const aThreadId = data(aThread).id;
    const aMsg = await a.agent
      .post(`${BASE}/messages/threads/${aThreadId}/messages`)
      .send({ body: 'secret' });
    const aMsgId = data(aMsg).id;

    const b = (await signupAgency()).agent;

    // Read.
    const read = await b.get(`${BASE}/messages/threads/${aThreadId}`);
    expect(read.status).toBe(404);

    // Patch (re-link).
    const patch = await b
      .patch(`${BASE}/messages/threads/${aThreadId}`)
      .send({ subject: 'hijack' });
    expect([403, 404]).toContain(patch.status);

    // Edit a message.
    const editMsg = await b
      .patch(`${BASE}/messages/threads/${aThreadId}/messages/${aMsgId}`)
      .send({ body: 'tampered' });
    expect([403, 404]).toContain(editMsg.status);

    // Delete a message.
    const delMsg = await b.delete(
      `${BASE}/messages/threads/${aThreadId}/messages/${aMsgId}`,
    );
    expect([403, 404]).toContain(delMsg.status);

    // Delete the thread.
    const delThread = await b.delete(`${BASE}/messages/threads/${aThreadId}`);
    expect([403, 404]).toContain(delThread.status);

    // Agency A's data is intact.
    const stillThere = await a.agent.get(
      `${BASE}/messages/threads/${aThreadId}/messages`,
    );
    expect(data(stillThere).some((m: any) => m.id === aMsgId)).toBe(true);
  });
});
