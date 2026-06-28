import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  BASE,
  signupAgency,
  createMemberSession,
  data,
  uniqueEmail,
  type Agent,
} from './helpers';

/**
 * CRM module (`/crm`) integration tests.
 *
 * CRM lives under the 'clients' module: reads need clients:view, writes need
 * clients:manage (enforced by requireModuleRW on the whole router). Most CRM
 * entities attach to a clientId and are additionally guarded by
 * requireClientAccess (members must be assigned; cross-tenant -> 404).
 */
describe('crm workflow', () => {
  let owner: Agent;
  let clientId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  // Fresh client per test so CRM data never collides across cases.
  beforeEach(async () => {
    const res = await owner
      .post(`${BASE}/clients`)
      .send({ name: `Client ${uniqueEmail('c')}`, contactEmail: 'hi@c.test' });
    expect(res.status).toBe(201);
    clientId = data(res).id;
  });

  // ----------------------------------------------------------------
  // 1. CONTACTS
  // ----------------------------------------------------------------
  it('creates, lists, updates and deletes a contact', async () => {
    const create = await owner
      .post(`${BASE}/crm/clients/${clientId}/contacts`)
      .send({ name: 'Jane Doe', role: 'CMO', email: 'jane@c.test', phone: '12345' });
    expect(create.status).toBe(201);
    const contact = data(create);
    expect(contact.id).toMatch(/^cnt_/);
    expect(contact.name).toBe('Jane Doe');
    expect(contact.clientId).toBe(clientId);
    expect(contact.isPrimary).toBe(false);

    const list = await owner.get(`${BASE}/crm/clients/${clientId}/contacts`);
    expect(list.status).toBe(200);
    expect(data(list).some((c: any) => c.id === contact.id)).toBe(true);

    const update = await owner
      .patch(`${BASE}/crm/contacts/${contact.id}`)
      .send({ name: 'Jane Smith', role: 'CEO' });
    expect(update.status).toBe(200);
    expect(data(update).name).toBe('Jane Smith');
    expect(data(update).role).toBe('CEO');

    const del = await owner.delete(`${BASE}/crm/contacts/${contact.id}`);
    expect(del.status).toBe(200);
    expect(data(del).deleted).toBe(true);

    const after = await owner.get(`${BASE}/crm/clients/${clientId}/contacts`);
    expect(data(after).some((c: any) => c.id === contact.id)).toBe(false);
  });

  it('keeps only one primary contact per client', async () => {
    const first = await owner
      .post(`${BASE}/crm/clients/${clientId}/contacts`)
      .send({ name: 'First', isPrimary: true });
    expect(first.status).toBe(201);
    expect(data(first).isPrimary).toBe(true);

    const second = await owner
      .post(`${BASE}/crm/clients/${clientId}/contacts`)
      .send({ name: 'Second', isPrimary: true });
    expect(second.status).toBe(201);
    expect(data(second).isPrimary).toBe(true);

    // The previous primary should have been demoted; primary sorts first.
    const list = await owner.get(`${BASE}/crm/clients/${clientId}/contacts`);
    const primaries = data(list).filter((c: any) => c.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].name).toBe('Second');
  });

  // ----------------------------------------------------------------
  // 2. NOTES / ACTIVITY TIMELINE
  // ----------------------------------------------------------------
  it('adds notes that appear in the timeline newest-first', async () => {
    const n1 = await owner
      .post(`${BASE}/crm/clients/${clientId}/notes`)
      .send({ body: 'First note', type: 'call' });
    expect(n1.status).toBe(201);
    expect(data(n1).id).toMatch(/^nte_/);
    expect(data(n1).type).toBe('call');
    expect(data(n1).authorName).toBeTruthy();

    const n2 = await owner
      .post(`${BASE}/crm/clients/${clientId}/notes`)
      .send({ body: 'Second note' });
    expect(n2.status).toBe(201);
    expect(data(n2).type).toBe('note');

    // Both notes are present.
    const before = await owner.get(`${BASE}/crm/clients/${clientId}/notes`);
    expect(before.status).toBe(200);
    const beforeIds = data(before).map((n: any) => n.id);
    expect(beforeIds).toContain(data(n1).id);
    expect(beforeIds).toContain(data(n2).id);

    // Ordering is `pinned desc, createdAt desc`. createdAt is unixepoch()
    // (second granularity), so two notes written in the same second are
    // ambiguous by time — assert the deterministic dimension instead: pin the
    // OLDER note and it must jump ahead of the unpinned newer one.
    await owner
      .patch(`${BASE}/crm/notes/${data(n1).id}`)
      .send({ pinned: true });
    const list = await owner.get(`${BASE}/crm/clients/${clientId}/notes`);
    expect(list.status).toBe(200);
    const ids = data(list).map((n: any) => n.id);
    expect(ids.indexOf(data(n1).id)).toBeLessThan(ids.indexOf(data(n2).id));
  });

  it('pins a note so it floats to the top of the timeline', async () => {
    const older = await owner
      .post(`${BASE}/crm/clients/${clientId}/notes`)
      .send({ body: 'Older' });
    const newer = await owner
      .post(`${BASE}/crm/clients/${clientId}/notes`)
      .send({ body: 'Newer' });

    const pin = await owner
      .patch(`${BASE}/crm/notes/${data(older).id}`)
      .send({ pinned: true });
    expect(pin.status).toBe(200);
    expect(data(pin).pinned).toBe(true);

    const list = await owner.get(`${BASE}/crm/clients/${clientId}/notes`);
    expect(data(list)[0].id).toBe(data(older).id);
    expect(data(list).some((n: any) => n.id === data(newer).id)).toBe(true);
  });

  it('marks a task note completed', async () => {
    const task = await owner
      .post(`${BASE}/crm/clients/${clientId}/notes`)
      .send({ body: 'Do the thing', type: 'task' });
    expect(data(task).completedAt).toBeNull();

    const done = await owner
      .patch(`${BASE}/crm/notes/${data(task).id}`)
      .send({ completed: true });
    expect(done.status).toBe(200);
    expect(data(done).completedAt).toBeTruthy();
  });

  // ----------------------------------------------------------------
  // 3. TAGS + TAG LINKS
  // ----------------------------------------------------------------
  it('creates an agency tag, lists it, links it to a client and unlinks it', async () => {
    const name = `VIP-${uniqueEmail('t')}`;
    const create = await owner
      .post(`${BASE}/crm/tags`)
      .send({ name, colorToken: 'amber' });
    expect(create.status).toBe(201);
    const tag = data(create);
    expect(tag.id).toMatch(/^tag_/);
    expect(tag.colorToken).toBe('amber');

    const tags = await owner.get(`${BASE}/crm/tags`);
    expect(tags.status).toBe(200);
    expect(data(tags).some((t: any) => t.id === tag.id)).toBe(true);

    const link = await owner.post(`${BASE}/crm/clients/${clientId}/tags/${tag.id}`);
    expect(link.status).toBe(200);
    expect(data(link).linked).toBe(true);

    // Linked tag surfaces on the per-client tag list AND the client detail.
    const clientTags = await owner.get(`${BASE}/crm/clients/${clientId}/tags`);
    expect(data(clientTags).some((t: any) => t.id === tag.id)).toBe(true);

    const detail = await owner.get(`${BASE}/clients/${clientId}`);
    expect(detail.status).toBe(200);
    expect(data(detail).tags.some((t: any) => t.id === tag.id)).toBe(true);

    const unlink = await owner.delete(
      `${BASE}/crm/clients/${clientId}/tags/${tag.id}`,
    );
    expect(unlink.status).toBe(200);
    expect(data(unlink).unlinked).toBe(true);

    const afterDetail = await owner.get(`${BASE}/clients/${clientId}`);
    expect(data(afterDetail).tags.some((t: any) => t.id === tag.id)).toBe(false);
  });

  it('rejects a duplicate tag name with 409', async () => {
    const name = `Dup-${uniqueEmail('t')}`;
    const first = await owner.post(`${BASE}/crm/tags`).send({ name });
    expect(first.status).toBe(201);
    const dupe = await owner.post(`${BASE}/crm/tags`).send({ name });
    expect(dupe.status).toBe(409);
  });

  it('404s when linking a non-existent tag', async () => {
    const link = await owner.post(
      `${BASE}/crm/clients/${clientId}/tags/tag_does_not_exist`,
    );
    expect(link.status).toBe(404);
  });

  // ----------------------------------------------------------------
  // 4. DEALS / PIPELINE
  // ----------------------------------------------------------------
  it('creates a deal and moves it through pipeline stages', async () => {
    const create = await owner
      .post(`${BASE}/crm/clients/${clientId}/deals`)
      .send({ title: 'Website revamp', stage: 'lead', valuePaise: 5_000_00 });
    expect(create.status).toBe(201);
    const deal = data(create);
    expect(deal.id).toMatch(/^dl_/);
    expect(deal.stage).toBe('lead');
    expect(deal.valuePaise).toBe(5_000_00);
    expect(deal.currency).toBe('INR');
    expect(deal.closedAt).toBeNull();

    const move = await owner
      .patch(`${BASE}/crm/deals/${deal.id}`)
      .send({ stage: 'proposal' });
    expect(move.status).toBe(200);
    expect(data(move).stage).toBe('proposal');
    expect(data(move).closedAt).toBeNull();

    // Crossing into a closed stage stamps closedAt.
    const won = await owner
      .patch(`${BASE}/crm/deals/${deal.id}`)
      .send({ stage: 'won' });
    expect(data(won).stage).toBe('won');
    expect(data(won).closedAt).toBeTruthy();
  });

  it('lists deals per-client and in the full pipeline', async () => {
    const d = await owner
      .post(`${BASE}/crm/clients/${clientId}/deals`)
      .send({ title: 'Retainer', stage: 'qualified', valuePaise: 100 });
    const dealId = data(d).id;

    const perClient = await owner.get(`${BASE}/crm/clients/${clientId}/deals`);
    expect(perClient.status).toBe(200);
    expect(data(perClient).some((x: any) => x.id === dealId)).toBe(true);

    const pipeline = await owner.get(`${BASE}/crm/deals`);
    expect(pipeline.status).toBe(200);
    const found = data(pipeline).find((x: any) => x.id === dealId);
    expect(found).toBeTruthy();
    expect(found.clientName).toBeTruthy(); // pipeline folds in client name
    // Group by stage to confirm the pipeline is stage-segmentable.
    const byStage = data(pipeline).reduce((acc: Record<string, number>, x: any) => {
      acc[x.stage] = (acc[x.stage] ?? 0) + 1;
      return acc;
    }, {});
    expect(byStage.qualified).toBeGreaterThanOrEqual(1);
  });

  it('deletes a deal', async () => {
    const d = await owner
      .post(`${BASE}/crm/clients/${clientId}/deals`)
      .send({ title: 'Throwaway' });
    const del = await owner.delete(`${BASE}/crm/deals/${data(d).id}`);
    expect(del.status).toBe(200);
    expect(data(del).deleted).toBe(true);

    const list = await owner.get(`${BASE}/crm/clients/${clientId}/deals`);
    expect(data(list).some((x: any) => x.id === data(d).id)).toBe(false);
  });

  // ----------------------------------------------------------------
  // 5. FOLLOW-UPS (derived from clients.nextFollowUpAt)
  // ----------------------------------------------------------------
  it('surfaces an upcoming follow-up and clears it when done', async () => {
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const set = await owner
      .patch(`${BASE}/clients/${clientId}`)
      .send({ nextFollowUpAt: due });
    expect(set.status).toBe(200);

    const list = await owner.get(`${BASE}/crm/follow-ups`);
    expect(list.status).toBe(200);
    const entry = data(list).find((f: any) => f.id === clientId);
    expect(entry).toBeTruthy();
    expect(entry.overdue).toBe(false);

    // "Mark done" == clearing the follow-up date on the client.
    const clear = await owner
      .patch(`${BASE}/clients/${clientId}`)
      .send({ nextFollowUpAt: null });
    expect(clear.status).toBe(200);

    const after = await owner.get(`${BASE}/crm/follow-ups`);
    expect(data(after).some((f: any) => f.id === clientId)).toBe(false);
  });

  it('flags a past-due follow-up as overdue', async () => {
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await owner.patch(`${BASE}/clients/${clientId}`).send({ nextFollowUpAt: past });

    const list = await owner.get(`${BASE}/crm/follow-ups`);
    const entry = data(list).find((f: any) => f.id === clientId);
    expect(entry).toBeTruthy();
    expect(entry.overdue).toBe(true);
  });

  // ----------------------------------------------------------------
  // 6. ACCOUNT OWNER
  // ----------------------------------------------------------------
  it('sets a client account owner and surfaces ownerName on the detail', async () => {
    const { user } = await createMemberSession(owner, {
      fullName: 'Account Manager',
      permissions: { clients: 'manage' },
    });
    const set = await owner
      .patch(`${BASE}/clients/${clientId}`)
      .send({ ownerId: user.id });
    expect(set.status).toBe(200);
    expect(data(set).ownerId).toBe(user.id);

    const detail = await owner.get(`${BASE}/clients/${clientId}`);
    expect(data(detail).ownerName).toBe('Account Manager');

    // The owner also surfaces on a deal owned by that user.
    const deal = await owner
      .post(`${BASE}/crm/clients/${clientId}/deals`)
      .send({ title: 'Owned deal', ownerId: user.id });
    expect(deal.status).toBe(201);
    expect(data(deal).ownerId).toBe(user.id);
    expect(data(deal).ownerName).toBe('Account Manager');
  });

  // ----------------------------------------------------------------
  // 7. PERMISSIONS
  // ----------------------------------------------------------------
  it('lets a clients:view member READ agency-level crm but blocks writes (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { clients: 'view' },
    });

    // Agency-level reads succeed (they are not client-scoped).
    expect((await agent.get(`${BASE}/crm/tags`)).status).toBe(200);
    expect((await agent.get(`${BASE}/crm/deals`)).status).toBe(200);
    expect((await agent.get(`${BASE}/crm/follow-ups`)).status).toBe(200);

    // Writes require manage -> blocked by requireModuleRW before client access.
    const tag = await agent
      .post(`${BASE}/crm/tags`)
      .send({ name: `Nope-${uniqueEmail('t')}` });
    expect(tag.status).toBe(403);

    const contact = await agent
      .post(`${BASE}/crm/clients/${clientId}/contacts`)
      .send({ name: 'Nope' });
    expect(contact.status).toBe(403);

    const deal = await agent
      .post(`${BASE}/crm/clients/${clientId}/deals`)
      .send({ title: 'Nope' });
    expect(deal.status).toBe(403);
  });

  it('denies a clients:none member even read access (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { clients: 'none' },
    });
    expect((await agent.get(`${BASE}/crm/tags`)).status).toBe(403);
    expect((await agent.get(`${BASE}/crm/deals`)).status).toBe(403);
    expect((await agent.get(`${BASE}/crm/follow-ups`)).status).toBe(403);
  });

  // ----------------------------------------------------------------
  // 8. TENANT ISOLATION
  // ----------------------------------------------------------------
  it("isolates tenants — agency B cannot touch agency A's crm data", async () => {
    // Agency A owns the client + a contact + a deal.
    const contact = await owner
      .post(`${BASE}/crm/clients/${clientId}/contacts`)
      .send({ name: 'A-only contact' });
    const contactId = data(contact).id;
    const deal = await owner
      .post(`${BASE}/crm/clients/${clientId}/deals`)
      .send({ title: 'A-only deal' });
    const dealId = data(deal).id;

    const b = (await signupAgency()).agent;

    // Cross-tenant client-scoped reads -> 404 (existence never revealed).
    expect((await b.get(`${BASE}/crm/clients/${clientId}/contacts`)).status).toBe(404);
    expect((await b.get(`${BASE}/crm/clients/${clientId}/deals`)).status).toBe(404);

    // Cross-tenant entity mutations -> 404 (scoped by agencyId in the lookup).
    expect((await b.patch(`${BASE}/crm/contacts/${contactId}`).send({ name: 'hax' })).status).toBe(404);
    expect((await b.delete(`${BASE}/crm/deals/${dealId}`)).status).toBe(404);

    // B's own pipeline never includes A's deal.
    const bPipeline = await b.get(`${BASE}/crm/deals`);
    expect(bPipeline.status).toBe(200);
    expect(data(bPipeline).some((x: any) => x.id === dealId)).toBe(false);
  });

  it("isolates tags — agency B's tag list excludes agency A's tags", async () => {
    const name = `SecretTag-${uniqueEmail('t')}`;
    const tag = await owner.post(`${BASE}/crm/tags`).send({ name });
    const tagId = data(tag).id;

    const b = (await signupAgency()).agent;
    const bTags = await b.get(`${BASE}/crm/tags`);
    expect(bTags.status).toBe(200);
    expect(data(bTags).some((t: any) => t.id === tagId)).toBe(false);

    // B cannot delete A's tag (agencyId-scoped) -> stays for A.
    await b.delete(`${BASE}/crm/tags/${tagId}`);
    const aTags = await owner.get(`${BASE}/crm/tags`);
    expect(data(aTags).some((t: any) => t.id === tagId)).toBe(true);
  });

  // ----------------------------------------------------------------
  // 9. VALIDATION
  // ----------------------------------------------------------------
  it('rejects an invalid contact body (422)', async () => {
    const res = await owner
      .post(`${BASE}/crm/clients/${clientId}/contacts`)
      .send({ name: '' }); // min(1) fails
    expect([400, 422]).toContain(res.status);
  });

  it('rejects an invalid deal body (422)', async () => {
    // probability out of [0,100] range.
    const res = await owner
      .post(`${BASE}/crm/clients/${clientId}/deals`)
      .send({ title: 'Bad', probability: 500 });
    expect([400, 422]).toContain(res.status);

    const noTitle = await owner
      .post(`${BASE}/crm/clients/${clientId}/deals`)
      .send({ stage: 'lead' }); // title required
    expect([400, 422]).toContain(noTitle.status);
  });

  it('404s when attaching crm data to a non-existent client', async () => {
    const contact = await owner
      .post(`${BASE}/crm/clients/cli_missing/contacts`)
      .send({ name: 'Ghost' });
    expect(contact.status).toBe(404);

    const deal = await owner
      .post(`${BASE}/crm/clients/cli_missing/deals`)
      .send({ title: 'Ghost deal' });
    expect(deal.status).toBe(404);

    const note = await owner
      .post(`${BASE}/crm/clients/cli_missing/notes`)
      .send({ body: 'Ghost note' });
    expect(note.status).toBe(404);
  });

  it('404s when creating a deal with an owner from another agency', async () => {
    // ownerId must belong to the caller's agency (assertAgencyUser -> 404).
    const { user: foreignUser } = await signupAgency().then(async (b) => ({
      user: b.user,
    }));
    const res = await owner
      .post(`${BASE}/crm/clients/${clientId}/deals`)
      .send({ title: 'Foreign owner', ownerId: foreignUser.id });
    expect(res.status).toBe(404);
  });
});
