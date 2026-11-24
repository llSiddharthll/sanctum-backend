import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Model fallback + time limits for every Gemini call (src/services/gemini-client.ts). */
vi.mock('../src/env.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...mod,
    env: {
      ...mod.env,
      GEMINI_API_KEY: 'test-key',
      AI_PROVIDER: 'gemini',
      GEMINI_MODEL: 'gemini-flash-latest',
      GEMINI_FALLBACK_MODELS: 'gemini-2.5-flash,gemini-2.5-flash-lite',
    },
    aiEnabled: true,
  };
});

const { geminiGenerate, resetGeminiCooldowns } = await import('../src/services/gemini-client.js');

type Behaviour = 'ok' | 503 | 400 | 'hang';
let plan: Record<string, Behaviour> = {};
let calls: Array<{ model: string; body: Record<string, unknown> }> = [];

function modelOf(url: string): string {
  return decodeURIComponent(url.split('/models/')[1].split(':')[0]);
}

beforeEach(() => {
  resetGeminiCooldowns();
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const model = modelOf(String(input));
    calls.push({ model, body: JSON.parse(String(init?.body)) });
    const how = plan[model] ?? 'ok';
    if (how === 'hang') {
      // Never answers; only the abort signal ends it.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
      });
    }
    if (how === 'ok') {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: `hi from ${model}` }] } }] }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: { code: how } }), { status: how });
  });
});

afterEach(() => vi.unstubAllGlobals());

const body = { contents: [{ role: 'user', parts: [{ text: 'Plan my day' }] }] };

describe('geminiGenerate', () => {
  it('uses the primary model when it answers', async () => {
    plan = {};
    const res = await geminiGenerate(body);
    expect(res.ok && res.model).toBe('gemini-flash-latest');
    expect(calls.map((c) => c.model)).toEqual(['gemini-flash-latest']);
  });

  it('falls back when the primary is overloaded (503), and skips it for a while', async () => {
    plan = { 'gemini-flash-latest': 503 };
    const res = await geminiGenerate(body);
    expect(res.ok && res.model).toBe('gemini-2.5-flash');
    // 2.5-flash is asked to answer without "thinking" (faster).
    expect(calls[1].body.generationConfig).toMatchObject({ thinkingConfig: { thinkingBudget: 0 } });
    calls = [];
    const again = await geminiGenerate(body);
    expect(again.ok && again.model).toBe('gemini-2.5-flash');
    expect(calls.map((c) => c.model)).toEqual(['gemini-2.5-flash']); // parked primary skipped
  });

  it('moves on when a model hangs past the per-call timeout', async () => {
    plan = { 'gemini-flash-latest': 'hang' };
    const started = Date.now();
    const res = await geminiGenerate(body, { timeoutMs: 200 });
    expect(res.ok && res.model).toBe('gemini-2.5-flash');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('returns a non-capacity error (400) without trying other models', async () => {
    plan = { 'gemini-flash-latest': 400 };
    const res = await geminiGenerate(body);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('gives up cleanly when every model is down', async () => {
    plan = { 'gemini-flash-latest': 503, 'gemini-2.5-flash': 503, 'gemini-2.5-flash-lite': 503 };
    const res = await geminiGenerate(body);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('stops at the deadline', async () => {
    plan = { 'gemini-flash-latest': 'hang', 'gemini-2.5-flash': 'hang', 'gemini-2.5-flash-lite': 'hang' };
    const started = Date.now();
    const res = await geminiGenerate(body, { timeoutMs: 1_000, deadline: Date.now() + 2_000 });
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_500);
  });
});
