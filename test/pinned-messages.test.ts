import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, signupAgency, createMemberSession, data, type Agent } from './helpers';
import type { Grant } from '../src/authz/catalog.js';

const g = (permission: string, scope: Grant['scope'] = 'organization'): Grant => ({ permission, scope });

/**
 * Pinned messages: the handful of messages that explain a client account,
 * surfaced on the client overview. Only pins from threads the caller
 * participates in are returned (clients.view + messages.view; the AI summary
 * also needs ai.use_assistant). Also covers the client activity feed
 * (clients.view_activity).
 */
describe('pinned messages + client activity visibility', () => {
  let owner: Agent;
  let clientId: string;
  let threadId: string;
  const msgIds: string[] = [];

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Pin Co' })).id;
    threadId = data(
      await owner.post(`${BASE}/messages/threads`).send({
        subject: 'Kickoff',
        clientId,
        participantIds: [],
      }),
    ).id;
    for (const body of ['Budget confirmed at 8L', 'Decision: no influencers', 'Chit chat']) {
      msgIds.push(
        data(await owner.post(`${BASE}/messages/threads/${threadId}/messages`).send({ body })).id,
      );
    }
  });

  const pin = (id: string, pinned: boolean) =>
    owner.patch(`${BASE}/messages/threads/${threadId}/messages/${id}/pin`).send({ pinned });

  it('pins a message and surfaces it on the client feed', async () => {
    const res = await pin(msgIds[0]!, true);
    expect(res.status).toBe(200);
    expect(data(res).pinnedAt).toBeTruthy();

    const feed = data(await owner.get(`${BASE}/clients/${clientId}/pinned`));
    expect(feed).toHaveLength(1);
    expect(feed[0].body).toBe('Budget confirmed at 8L');
    // Carries thread context so the overview can show where it came from.
    expect(feed[0].threadSubject).toBe('Kickoff');
  });

  it('only pinned messages appear — ordinary chatter does not', async () => {
    await pin(msgIds[1]!, true);
    const feed = data(await owner.get(`${BASE}/clients/${clientId}/pinned`));
    expect(feed).toHaveLength(2);
    expect(feed.map((m: any) => m.body)).not.toContain('Chit chat');
  });

  it('unpins', async () => {
    const res = await pin(msgIds[0]!, false);
    expect(data(res).pinnedAt).toBeNull();
    expect(data(await owner.get(`${BASE}/clients/${clientId}/pinned`))).toHaveLength(1);
  });

  it('the pinned flag round-trips on the thread message list', async () => {
    const msgs = data(await owner.get(`${BASE}/messages/threads/${threadId}/messages`));
    const pinned = msgs.filter((m: any) => m.pinnedAt);
    expect(pinned).toHaveLength(1);
    expect(pinned[0].body).toBe('Decision: no influencers');
  });

  it('404s pinning a message that is not in the thread', async () => {
    const res = await owner
      .patch(`${BASE}/messages/threads/${threadId}/messages/msg_nope/pin`)
      .send({ pinned: true });
    expect(res.status).toBe(404);
  });

  it('summary endpoint degrades gracefully when AI is off', async () => {
    const res = await owner.post(`${BASE}/clients/${clientId}/pinned/summary`).send({});
    expect(res.status).toBe(200);
    const out = data(res);
    expect(out.pinnedCount).toBeGreaterThan(0);
    // With AI disabled the summary is null and a reason is given, so the UI can
    // still render the pins themselves.
    if (!out.summary) expect(out.message).toBeTruthy();
  });

  it("never leaks another agency's pins", async () => {
    const other = (await signupAgency()).agent;
    const res = await other.get(`${BASE}/clients/${clientId}/pinned`);
    expect(res.status).toBe(404);
  });

  it('a teammate who is not in the thread sees none of its pins', async () => {
    const outsider = await createMemberSession(owner, {
      grants: [g('clients.view'), g('messages.view', 'assigned'), g('ai.use_assistant')],
    });
    const res = await outsider.agent.get(`${BASE}/clients/${clientId}/pinned`);
    expect(res.status).toBe(200);
    expect(data(res)).toHaveLength(0);
    const summary = await outsider.agent.post(`${BASE}/clients/${clientId}/pinned/summary`).send({});
    expect(summary.status).toBe(200);
    expect(data(summary).pinnedCount).toBe(0);
  });

  it('summary requires ai.use_assistant; pins require messages.view', async () => {
    const noAi = await createMemberSession(owner, { grants: [g('clients.view'), g('messages.view', 'assigned')] });
    expect((await noAi.agent.post(`${BASE}/clients/${clientId}/pinned/summary`).send({})).status).toBe(403);
    const noMessages = await createMemberSession(owner, { grants: [g('clients.view')] });
    expect((await noMessages.agent.get(`${BASE}/clients/${clientId}/pinned`)).status).toBe(403);
  });

  it('client activity requires clients.view_activity', async () => {
    const manager = await createMemberSession(owner, {
      grants: [g('clients.view'), g('clients.view_activity')],
    });
    expect((await manager.agent.get(`${BASE}/clients/${clientId}/activity`)).status).toBe(200);

    const employee = await createMemberSession(owner, { grants: [g('clients.view')] });
    expect((await employee.agent.get(`${BASE}/clients/${clientId}/activity`)).status).toBe(403);
  });
});
