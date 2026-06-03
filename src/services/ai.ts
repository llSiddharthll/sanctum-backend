import { z } from 'zod';
import { env, aiEnabled } from '../env.js';

/**
 * AI content generation for monthly content calendars.
 *
 * Primary provider: Google Gemini (Generative Language REST API), called
 * server-side via the global `fetch` available in Node 24.
 *
 * Fallback: a deterministic local template generator. If no GEMINI_API_KEY
 * is configured, or the Gemini call throws / returns a non-200, or the
 * response cannot be parsed into valid posts, we synthesize a sensible month
 * of draft posts locally. `generateMonth` NEVER throws — it always returns
 * drafts so the request can complete. The returned `source` flag tells the
 * caller (and UI) which path produced the posts.
 */

const POST_TYPES = ['reel', 'story', 'carousel', 'post'] as const;
type PostType = (typeof POST_TYPES)[number];
const POST_TYPE_SET = new Set<string>(POST_TYPES);

export interface GenerateMonthInput {
  month: string; // 'YYYY-MM'
  postsCount: number;
  postTypes: PostType[];
  platforms: string[];
  clientName: string;
  sector?: string;
  tone?: string;
  audience?: string;
  pillars?: string[];
  dos?: string;
  donts?: string;
  extraNotes?: string;
}

export interface GeneratedPost {
  postType: PostType;
  caption: string;
  platforms: string[];
  dayOfMonth: number; // 1..28 (kept <=28 so every month is valid)
  pillar?: string;
}

export interface GenerateMonthResult {
  posts: GeneratedPost[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Which path produced the posts. */
  source: 'gemini' | 'fallback';
}

/** Zod shape used to validate model output before coercion. */
const geminiPostSchema = z.object({
  postType: z.string().optional(),
  type: z.string().optional(),
  caption: z.string().optional(),
  platforms: z.array(z.string()).optional(),
  dayOfMonth: z.number().optional(),
  day: z.number().optional(),
  scheduledAt: z.string().optional(),
  title: z.string().optional(),
  pillar: z.string().optional(),
});
const geminiArraySchema = z.array(geminiPostSchema);

// ---------------------------------------------------------------------------
//  Prompt
// ---------------------------------------------------------------------------

function buildPrompt(input: GenerateMonthInput): string {
  const lines = [
    `You are a senior social media strategist creating a content calendar for the brand "${input.clientName}".`,
    input.sector ? `Brand sector / industry: ${input.sector}.` : '',
    `Create exactly ${input.postsCount} social media posts for the month ${input.month}.`,
    `Allowed post types (use ONLY these exact values): ${input.postTypes.join(', ')}.`,
    `Target platforms: ${input.platforms.join(', ')}.`,
    input.tone ? `Brand tone: ${input.tone}.` : '',
    input.audience ? `Target audience: ${input.audience}.` : '',
    input.pillars?.length
      ? `Content pillars to rotate through: ${input.pillars.join(', ')}.`
      : '',
    input.dos ? `Do: ${input.dos}.` : '',
    input.donts ? `Avoid: ${input.donts}.` : '',
    input.extraNotes ? `Additional context: ${input.extraNotes}.` : '',
    '',
    'Spread the posts evenly across the month (use day-of-month values 1 through 28).',
    'Write engaging, on-brand captions that reference the brand and its sector.',
    '',
    'Respond with ONLY a raw JSON array — no markdown fences, no prose, no comments.',
    `The array must contain exactly ${input.postsCount} objects, each with this exact shape:`,
    '{',
    `  "postType": one of [${input.postTypes.join(', ')}],`,
    '  "caption": string,',
    '  "platforms": string[] (subset of the target platforms),',
    '  "dayOfMonth": integer between 1 and 28,',
    '  "pillar": string (the content pillar this post belongs to)',
    '}',
  ];
  return lines.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
//  Robust parsing of model output
// ---------------------------------------------------------------------------

/** Strip markdown code fences and surrounding prose, then isolate the JSON array. */
function extractJsonArray(text: string): string | null {
  let s = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences.
  s = s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  // If there is still surrounding prose, grab the outermost [ ... ].
  const first = s.indexOf('[');
  const last = s.lastIndexOf(']');
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

function clampDay(n: number): number {
  if (!Number.isFinite(n)) return 1;
  const d = Math.floor(n);
  if (d < 1) return 1;
  if (d > 28) return 28;
  return d;
}

/** Coerce loosely-validated model output into strict GeneratedPost[]. */
function coercePosts(
  raw: z.infer<typeof geminiArraySchema>,
  input: GenerateMonthInput,
): GeneratedPost[] {
  const out: GeneratedPost[] = [];
  for (const item of raw) {
    const rawType = item.postType ?? item.type;
    const postType: PostType =
      typeof rawType === 'string' && POST_TYPE_SET.has(rawType)
        ? (rawType as PostType)
        : input.postTypes[0]!;

    const caption =
      typeof item.caption === 'string' && item.caption.trim()
        ? item.caption.trim()
        : typeof item.title === 'string'
          ? item.title.trim()
          : '';
    if (!caption) continue;

    const platforms =
      Array.isArray(item.platforms) && item.platforms.length
        ? item.platforms.filter((p) => typeof p === 'string')
        : input.platforms;

    // Accept dayOfMonth, day, or derive from an ISO scheduledAt string.
    let day = 1;
    if (typeof item.dayOfMonth === 'number') day = clampDay(item.dayOfMonth);
    else if (typeof item.day === 'number') day = clampDay(item.day);
    else if (typeof item.scheduledAt === 'string') {
      const parsed = new Date(item.scheduledAt);
      if (!Number.isNaN(parsed.getTime())) day = clampDay(parsed.getUTCDate());
    }

    out.push({
      postType,
      caption,
      platforms: platforms.length ? platforms : input.platforms,
      dayOfMonth: day,
      pillar: typeof item.pillar === 'string' ? item.pillar : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Gemini call
// ---------------------------------------------------------------------------

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * Call Gemini and return validated posts, or `null` to trigger the fallback.
 * This function never throws.
 */
async function tryGemini(
  input: GenerateMonthInput,
): Promise<GenerateMonthResult | null> {
  if (!aiEnabled || !env.GEMINI_API_KEY || env.AI_PROVIDER !== 'gemini') {
    return null;
  }

  const model = env.GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;
  const prompt = buildPrompt(input);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-goog-api-key': env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!resp.ok) return null;

    const json = (await resp.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string' || !text.trim()) return null;

    const arrayText = extractJsonArray(text);
    if (!arrayText) return null;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(arrayText);
    } catch {
      return null;
    }

    const validated = geminiArraySchema.safeParse(parsedJson);
    if (!validated.success) return null;

    const posts = coercePosts(validated.data, input).slice(0, input.postsCount);
    if (posts.length === 0) return null;

    return {
      posts,
      model,
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      source: 'gemini',
    };
  } catch {
    // Network error, abort, JSON error, etc. -> fall back.
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Deterministic local fallback ("backend calculation")
// ---------------------------------------------------------------------------

/** Small deterministic hash so output is stable for a given brand/sector. */
function seedFrom(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const CAPTION_TEMPLATES = [
  (brand: string, pillar: string, sector: string) =>
    `Behind the scenes at ${brand}: how we approach ${pillar} in ${sector}. What would you like to see more of?`,
  (brand: string, pillar: string, sector: string) =>
    `${pillar} matters. Here's how ${brand} is raising the bar in ${sector} this week. Save this for later!`,
  (brand: string, pillar: string, _sector: string) =>
    `A quick tip from the ${brand} team on ${pillar}. Tag someone who needs to see this.`,
  (brand: string, pillar: string, sector: string) =>
    `From idea to impact — ${brand} on ${pillar}. Why it's a game changer for ${sector}.`,
  (brand: string, pillar: string, _sector: string) =>
    `Your weekly dose of ${pillar}, brought to you by ${brand}. Drop a comment with your thoughts!`,
  (brand: string, pillar: string, sector: string) =>
    `Spotlight: ${pillar}. See how ${brand} makes ${sector} simpler, one post at a time.`,
  (brand: string, pillar: string, _sector: string) =>
    `Let's talk ${pillar}. ${brand} breaks it down so you don't have to. Follow for more.`,
];

const DEFAULT_PILLARS = [
  'education',
  'behind the scenes',
  'community',
  'product spotlight',
  'tips & tricks',
];

/**
 * Generate a full month of draft posts locally with a template generator.
 * Rotates post types across weeks, rotates platforms, seeds captions from the
 * brand name/sector, and spreads dates evenly across days 1..28.
 */
function fallbackMonth(input: GenerateMonthInput): GenerateMonthResult {
  const sector = input.sector?.trim() || 'your industry';
  const pillars =
    input.pillars && input.pillars.length ? input.pillars : DEFAULT_PILLARS;
  const types = input.postTypes.length ? input.postTypes : (['post'] as PostType[]);
  const platforms = input.platforms.length ? input.platforms : ['instagram'];
  const seed = seedFrom(`${input.clientName}|${sector}|${input.month}`);

  const count = Math.max(1, input.postsCount);
  // Spread evenly across days 1..28.
  const span = 28;
  const step = count > 1 ? (span - 1) / (count - 1) : 0;

  const posts: GeneratedPost[] = [];
  for (let i = 0; i < count; i++) {
    const dayOfMonth = count > 1 ? clampDay(1 + Math.round(i * step)) : 1;
    const week = Math.floor((dayOfMonth - 1) / 7); // 0..3
    // Rotate post types by week, with per-index offset so a week isn't uniform.
    const postType = types[(week + i) % types.length]!;
    // Rotate platforms; some posts target a single platform, others all.
    const platform = platforms[i % platforms.length]!;
    const usePlatforms =
      i % 3 === 0 ? platforms.slice() : [platform];
    const pillar = pillars[(seed + i) % pillars.length]!;
    const template =
      CAPTION_TEMPLATES[(seed + i) % CAPTION_TEMPLATES.length]!;
    const caption = template(input.clientName, pillar, sector);

    posts.push({
      postType,
      caption,
      platforms: usePlatforms,
      dayOfMonth,
      pillar,
    });
  }

  return {
    posts,
    model: 'fallback-template',
    inputTokens: 0,
    outputTokens: 0,
    source: 'fallback',
  };
}

// ---------------------------------------------------------------------------
//  Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Generate a month of draft posts. Tries Gemini first; on any failure (no key,
 * non-200, unparseable, empty) falls back to the deterministic generator.
 * Always resolves — never throws — so the calling route always returns drafts.
 */
export async function generateMonth(
  input: GenerateMonthInput,
): Promise<GenerateMonthResult> {
  const gemini = await tryGemini(input);
  if (gemini) return gemini;
  return fallbackMonth(input);
}
