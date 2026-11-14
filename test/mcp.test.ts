import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE, signupAgency, createMemberSession, data, type Agent } from './helpers';
import {
  REDIRECT,
  MCP_ACCEPT,
  request,
  pkce,
  registerClient,
  connect,
  rpc,
  toolNames,
  callTool,
  startLoopback,
} from './mcp-helpers';

/**
 * MCP server end to end, the way Claude / ChatGPT use it:
 * discovery → dynamic registration → /authorize → consent (signed-in user) →
 * /token (PKCE) → POST /mcp with the bearer token. Tools run as the user, so a
 * member without finance access neither sees nor can use invoice tools.
 */

describe('MCP server (OAuth + role-based tools)', () => {
  let owner: Agent;
  let member: Agent;
  let clientId: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    stop = startLoopback();

    owner = (await signupAgency()).agent;
    // Plain team member: no finance / business access.
    member = (await createMemberSession(owner, { permissions: {} })).agent;
    await owner.post(`${BASE}/clients`).send({ name: 'Bloom Digital' });
    clientId = await registerClient();
  });

  afterAll(() => stop());

  it('publishes OAuth discovery metadata', async () => {
    const meta = await request().get('/.well-known/oauth-authorization-server');
    expect(meta.status).toBe(200);
    expect(meta.body.registration_endpoint).toMatch(/\/register$/);
    expect(meta.body.code_challenge_methods_supported).toContain('S256');
    const prm = await request().get('/.well-known/oauth-protected-resource/mcp');
    expect(prm.status).toBe(200);
    expect(prm.body.resource).toMatch(/\/mcp$/);
  });

  it('rejects MCP calls without a token (with a discovery hint)', async () => {
    const res = await request().post('/mcp').set('Accept', MCP_ACCEPT).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/resource_metadata=/);
  });

  it('needs a signed-in user to approve, and codes are single-use', async () => {
    const auth = await request().get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    const sealed = new URL(auth.headers.location!).searchParams.get('request')!;
    const anon = await request().post(`${BASE}/mcp-connect/approve`).send({ request: sealed });
    expect(anon.status).toBe(401);

    const { code, verifier } = await connect(owner, clientId);
    const again = await request().post('/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(again.status).toBe(400);
  });

  it('rejects a tampered connection request', async () => {
    const res = await owner.get(`${BASE}/mcp-connect/request`).query({ request: 'not-a-real-request' });
    expect(res.status).toBe(400);
  });

  it('shows each user only the tools their role allows, and runs tools as that user', async () => {
    const ownerTokens = await connect(owner, clientId);
    const memberTokens = await connect(member, clientId);

    const ownerTools = await toolNames(ownerTokens.access);
    const memberTools = await toolNames(memberTokens.access);
    expect(ownerTools).toContain('whoami');
    expect(ownerTools).toContain('invoices_create');
    expect(memberTools).toContain('whoami');
    expect(memberTools).not.toContain('invoices_create');
    expect(memberTools).not.toContain('invoices_list');

    // Hidden tools cannot be called either.
    const denied = await callTool(memberTokens.access, 'invoices_list');
    expect(denied.error ?? denied.result?.isError).toBeTruthy();

    // Owner tool calls go through the API as the owner.
    const who = await callTool(ownerTokens.access, 'whoami');
    expect(who.result?.isError).toBeFalsy();
    expect(JSON.parse(who.result!.content[0]!.text).canChange).toContain('invoices');

    const list = await callTool(ownerTokens.access, 'invoices_list');
    expect(list.result?.isError).toBeFalsy();
  });

  it('refreshes tokens with rotation and stops working once disconnected', async () => {
    const t = await connect(member, clientId);

    const refreshed = await request().post('/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: t.refresh,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const access2 = refreshed.body.access_token as string;
    expect((await rpc(access2, 'tools/list')).status).toBe(200);

    // The AI connection is listed in the user's sessions and can be disconnected.
    const sessions = data(await member.get(`${BASE}/auth/sessions`)) as Array<{ id: string; userAgent: string | null }>;
    const ai = sessions.filter((s) => s.userAgent === 'AI connector · Test AI');
    expect(ai.length).toBeGreaterThan(0);
    for (const s of ai) expect((await member.delete(`${BASE}/auth/sessions/${s.id}`)).status).toBe(200);

    expect((await rpc(access2, 'tools/list')).status).toBe(401);
    const dead = await request().post('/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: refreshed.body.refresh_token,
      client_id: clientId,
    });
    expect(dead.status).toBe(400);
  });
});
