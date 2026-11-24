/**
 * One place that talks to Gemini (generateContent), shared by the AI agent
 * and the content tools.
 *
 * Why: a single model (`GEMINI_MODEL`, e.g. gemini-flash-latest) is sometimes
 * overloaded — it answers 503 "high demand" or just hangs — and every caller
 * used to wait on it with no timeout and no alternative. Here each request:
 *  - tries `GEMINI_MODEL`, then each of `GEMINI_FALLBACK_MODELS` in order;
 *  - gives each attempt at most `timeoutMs` (and never past `deadline`);
 *  - moves on after a capacity error (408/429/5xx), a timeout or a network
 *    error, and parks that model for a minute so later calls skip it fast;
 *  - turns "thinking" off on gemini-2.5-flash (it otherwise spends seconds
 *    reasoning before simple answers).
 * A 4xx that isn't about capacity (e.g. 400 for a bad request body) is
 * returned to the caller unchanged — retrying another model wouldn't help.
 */
import { env } from '../env.js';

export type GeminiCallResult =
  | { ok: true; json: unknown; model: string }
  | { ok: false; status: number; text: string; model: string | null };

const COOLDOWN_MS = 60_000;
const cooldownUntil = new Map<string, number>();

/** Models to try, primary first, without duplicates. */
export function geminiModels(): string[] {
  const list = [env.GEMINI_MODEL, ...(env.GEMINI_FALLBACK_MODELS ?? '').split(',')]
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

function isCapacityStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** gemini-2.5-flash thinks by default; a zero budget makes it answer directly. */
function withModelTweaks(model: string, body: Record<string, unknown>): Record<string, unknown> {
  if (!/^gemini-2\.5-flash(?!-lite)/.test(model)) return body;
  const gen = (body.generationConfig as Record<string, unknown> | undefined) ?? {};
  if (gen.thinkingConfig) return body;
  return { ...body, generationConfig: { ...gen, thinkingConfig: { thinkingBudget: 0 } } };
}

/** For tests. */
export function resetGeminiCooldowns(): void {
  cooldownUntil.clear();
}

export async function geminiGenerate(
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; deadline?: number } = {},
): Promise<GeminiCallResult> {
  const key = env.GEMINI_API_KEY;
  if (!key) return { ok: false, status: 0, text: 'GEMINI_API_KEY is not set', model: null };

  const timeoutMs = opts.timeoutMs ?? 25_000;
  const models = geminiModels();
  const now = Date.now();
  // Skip parked models, unless every model is parked (then try them anyway).
  const ready = models.filter((m) => (cooldownUntil.get(m) ?? 0) <= now);
  const order = ready.length ? ready : models;

  let last: GeminiCallResult = { ok: false, status: 0, text: 'No Gemini model available', model: null };
  for (const model of order) {
    // Time left before the caller's deadline (no deadline: only the per-call timeout applies).
    const left = opts.deadline ? opts.deadline - Date.now() : Number.POSITIVE_INFINITY;
    if (left < 1_500) break;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'X-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(withModelTweaks(model, body)),
        signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
      });
      if (resp.ok) {
        cooldownUntil.delete(model);
        return { ok: true, json: await resp.json(), model };
      }
      const text = await resp.text().catch(() => '');
      last = { ok: false, status: resp.status, text, model };
      if (!isCapacityStatus(resp.status)) return last;
      cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
      console.warn(`[gemini] ${model} answered ${resp.status}; trying the next model`);
    } catch (err) {
      // Timeout (AbortSignal) or network error.
      cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
      last = { ok: false, status: 0, text: String((err as Error)?.name ?? err), model };
      console.warn(`[gemini] ${model} failed (${(err as Error)?.name ?? 'error'}); trying the next model`);
    }
  }
  return last;
}
