import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { BASE, signupAgency, createMemberSession, data, type Agent } from './helpers';
import { startLoopback } from './mcp-helpers';

/**
 * Sanctum AI agent (POST /ai/chat) with a scripted Gemini: reads run
 * automatically, changes come back as pendingAction and only run on confirm,
 * and confirmation is re-checked against the person's permissions.
 */
vi.mock('../src/env.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/env.js')>();
  return { ...mod, env: { ...mod.env, GEMINI_API_KEY: 'test-key', AI_PROVIDER: 'gemini' }, aiEnabled: true };
});

type Part = Record<string, unknown>;
const script: Part[][] = [];
const geminiBodies: Array<{ contents: Array<{ role: string; parts: Part[] }>; tools?: unknown }> = [];
const realFetch = globalThis.fetch;

function say(text: string): Part[] {
  return [{ text }];
}
function call(name: string, args: Record<string, unknown>, text?: string): Part[] {
  return [...(text ? [{ text }] : []), { functionCall: { name, args } }];
}

describe('Sanctum AI agent', () => {
  let stop: () => Promise<void>;
  let owner: Agent;
  let member: Agent;

  beforeAll(async () => {
    stop = startLoopback();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
      geminiBodies.push(JSON.parse(String(init?.body)));
      const parts = script.shift() ?? say('(no script)');
      return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    owner = (await signupAgency()).agent;
    // Can use the assistant and see clients, but not create them.
    member = (
      await createMemberSession(owner, {
        grants: [
          { permission: 'ai.use_assistant', scope: 'organization' },
          { permission: 'clients.view', scope: 'organization' },
        ],
      })
    ).agent;
    await owner.post(`${BASE}/clients`).send({ name: 'Bloom Digital' });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await stop();
  });

  const chat = (agent: Agent, body: Record<string, unknown>) => agent.post(`${BASE}/ai/chat`).send(body);

  it('looks things up with tools and answers from the results', async () => {
    script.push(call('clients_list', {}), say('You have one client: **Bloom Digital**.'));
    const res = await chat(owner, { messages: [{ role: 'user', content: 'Which clients do we have?' }], page: '/clients' });
    expect(res.status).toBe(200);
    const out = data(res);
    expect(out.source).toBe('gemini');
    expect(out.reply).toContain('Bloom Digital');
    expect(out.pendingAction).toBeNull();
    expect(out.steps).toEqual([expect.objectContaining({ tool: 'clients_list', kind: 'read', ok: true, link: '/clients' })]);
    // The tool result went back to the model.
    const second = geminiBodies.at(-1)!;
    expect(JSON.stringify(second.contents.at(-1))).toContain('Bloom Digital');
    // The model was only offered relevant tools, all of which the owner may use.
    const names = (second.tools as Array<{ functionDeclarations: Array<{ name: string }> }>)[0]!.functionDeclarations.map((d) => d.name);
    expect(names).toContain('clients_create');
    expect(names.length).toBeLessThanOrEqual(64);
  });

  it('never runs a change without confirmation', async () => {
    script.push(call('clients_create', { name: 'Nova Fitness', industry: 'Fitness' }, "I'll add Nova Fitness as a client."));
    const res = await chat(owner, { messages: [{ role: 'user', content: 'Add a client called Nova Fitness (fitness industry)' }] });
    const out = data(res);
    expect(out.pendingAction).toMatchObject({ tool: 'clients_create', kind: 'write', args: { name: 'Nova Fitness' } });
    expect(out.pendingAction.details).toEqual(expect.arrayContaining([{ label: 'Name', value: 'Nova Fitness' }]));
    const clients = data(await owner.get(`${BASE}/clients`)) as Array<{ name: string }>;
    expect(clients.map((c) => c.name)).not.toContain('Nova Fitness');
  });

  it('runs the action once confirmed and reports the outcome', async () => {
    script.push(say('Done — **Nova Fitness** is now a client.'));
    const res = await chat(owner, {
      messages: [{ role: 'user', content: 'Add a client called Nova Fitness (fitness industry)' }],
      confirm: { tool: 'clients_create', args: { name: 'Nova Fitness', industry: 'Fitness' } },
    });
    const out = data(res);
    expect(out.reply).toContain('Nova Fitness');
    expect(out.steps[0]).toMatchObject({ tool: 'clients_create', kind: 'write', ok: true });
    expect(out.steps[0].link).toMatch(/^\/clients\/.+/);
    const clients = data(await owner.get(`${BASE}/clients`)) as Array<{ name: string }>;
    expect(clients.map((c) => c.name)).toContain('Nova Fitness');
  });

  it('refuses to confirm an action the person is not allowed to do', async () => {
    const before = geminiBodies.length;
    const res = await chat(member, {
      messages: [{ role: 'user', content: 'Add a client called Sneaky Co' }],
      confirm: { tool: 'clients_create', args: { name: 'Sneaky Co' } },
    });
    expect(res.status).toBe(200);
    const out = data(res);
    expect(out.reply).toMatch(/isn't available/);
    expect(geminiBodies.length).toBe(before); // nothing sent to the model
    const clients = data(await owner.get(`${BASE}/clients`)) as Array<{ name: string }>;
    expect(clients.map((c) => c.name)).not.toContain('Sneaky Co');
  });

  it('reports invalid tool arguments back to the model instead of failing', async () => {
    script.push(call('clients_get', {}), say('Which client do you mean?'));
    const out = data(await chat(owner, { messages: [{ role: 'user', content: 'Show me the client' }] }));
    expect(out.steps[0]).toMatchObject({ tool: 'clients_get', ok: false });
    expect(out.reply).toBe('Which client do you mean?');
  });
});
