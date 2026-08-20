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

// ===========================================================================
//  Agency-level AI assistant (documents, chat, task breakdown)
//
//  These reuse the same Gemini REST endpoint + model as generateMonth and the
//  same "never throw" philosophy: every public function below resolves to a
//  sensible result even when GEMINI_API_KEY is missing or the call fails,
//  using local templates / canned replies as the fallback.
// ===========================================================================

/**
 * Low-level single-turn Gemini text call. Returns the model's plain-text
 * output, or `null` to signal the caller should use its fallback. Never throws.
 *
 * `system` is sent via systemInstruction; `contents` is the multi-turn history
 * (user/model parts). For a single prompt, pass one user turn.
 */
async function callGeminiText(opts: {
  system?: string;
  contents: Array<{ role: 'user' | 'model'; text: string }>;
}): Promise<string | null> {
  if (!aiEnabled || !env.GEMINI_API_KEY || env.AI_PROVIDER !== 'gemini') {
    return null;
  }

  const model = env.GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-goog-api-key': env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...(opts.system
          ? { systemInstruction: { parts: [{ text: opts.system }] } }
          : {}),
        contents: opts.contents.map((c) => ({
          role: c.role,
          parts: [{ text: c.text }],
        })),
      }),
    });

    if (!resp.ok) return null;

    const json = (await resp.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string' || !text.trim()) return null;
    return text;
  } catch {
    return null;
  }
}

/** Strip a leading/trailing markdown code fence (```lang ... ```) if present. */
function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json|markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
//  Document generation
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPES = [
  'sop',
  'proposal',
  'report',
  'handover',
  'process_guide',
  'brief',
  'email',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface GenerateDocumentInput {
  type: DocumentType;
  title?: string;
  context: string;
}

export interface GenerateDocumentResult {
  title: string;
  /** Markdown body. */
  content: string;
  source: 'gemini' | 'fallback';
}

const DOCUMENT_LABELS: Record<DocumentType, string> = {
  sop: 'Standard Operating Procedure',
  proposal: 'Client Proposal',
  report: 'Report',
  handover: 'Handover Document',
  process_guide: 'Process Guide',
  brief: 'Creative / Project Brief',
  email: 'Email',
};

function defaultDocTitle(input: GenerateDocumentInput): string {
  if (input.title && input.title.trim()) return input.title.trim();
  return DOCUMENT_LABELS[input.type];
}

/** Section headings appropriate to each document type, used for the prompt + fallback. */
const DOCUMENT_SECTIONS: Record<DocumentType, string[]> = {
  sop: ['Purpose', 'Scope', 'Roles & Responsibilities', 'Procedure', 'Tools & Resources', 'Review & Revision'],
  proposal: ['Overview', 'Objectives', 'Scope of Work', 'Deliverables', 'Timeline', 'Investment', 'Next Steps'],
  report: ['Summary', 'Key Metrics', 'Highlights', 'Challenges', 'Recommendations', 'Next Steps'],
  handover: ['Overview', 'Current Status', 'Key Contacts', 'Accounts & Access', 'Open Items', 'Notes'],
  process_guide: ['Overview', 'Prerequisites', 'Step-by-Step', 'Best Practices', 'Troubleshooting'],
  brief: ['Background', 'Objectives', 'Target Audience', 'Key Message', 'Deliverables', 'Timeline', 'Success Metrics'],
  email: ['Subject', 'Body', 'Call to Action'],
};

function buildDocumentPrompt(input: GenerateDocumentInput): string {
  const label = DOCUMENT_LABELS[input.type];
  const sections = DOCUMENT_SECTIONS[input.type];
  return [
    `You are a senior marketing-agency operator. Write a clear, professional ${label} in GitHub-flavored Markdown.`,
    input.title ? `Document title: ${input.title}.` : '',
    `Context / brief from the user:\n${input.context}`,
    '',
    `Structure the document with a top-level "# " heading and these sections (use "## " for each, adapt as needed): ${sections.join(', ')}.`,
    'Be specific and actionable. Use bullet lists and tables where helpful.',
    'Respond with ONLY the Markdown document — no code fences, no preamble, no explanation.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Deterministic markdown template used when no AI is available. */
function fallbackDocument(input: GenerateDocumentInput): GenerateDocumentResult {
  const title = defaultDocTitle(input);
  const label = DOCUMENT_LABELS[input.type];
  const sections = DOCUMENT_SECTIONS[input.type];
  const ctx = input.context.trim();

  const lines: string[] = [`# ${title}`, '', `_${label}_`, ''];
  for (const section of sections) {
    lines.push(`## ${section}`, '');
    if (section === 'Subject') {
      lines.push(title, '');
    } else if (
      section === 'Overview' ||
      section === 'Summary' ||
      section === 'Background' ||
      section === 'Purpose' ||
      section === 'Body'
    ) {
      lines.push(ctx || '_Add details here._', '');
    } else {
      lines.push('- _Add details here._', '');
    }
  }
  return { title, content: lines.join('\n').trim() + '\n', source: 'fallback' };
}

/**
 * Generate a markdown document of the given type. Tries Gemini, falls back to a
 * structured template. NEVER throws.
 */
export async function generateDocument(
  input: GenerateDocumentInput,
): Promise<GenerateDocumentResult> {
  const text = await callGeminiText({
    contents: [{ role: 'user', text: buildDocumentPrompt(input) }],
  });
  if (text && text.trim()) {
    return {
      title: defaultDocTitle(input),
      content: stripCodeFences(text),
      source: 'gemini',
    };
  }
  return fallbackDocument(input);
}

// ---------------------------------------------------------------------------
//  Chat
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatInput {
  /** Pre-built grounding context (agency / projects / clients summary). */
  systemContext: string;
  messages: ChatMessage[];
}

export interface ChatResult {
  reply: string;
  source: 'gemini' | 'fallback';
}

/**
 * Single request/response chat (no streaming). Grounds the model with the
 * provided system context, then replays the message history. Falls back to a
 * helpful canned reply when no AI is available. NEVER throws.
 */
export async function generateChatReply(
  input: ChatInput,
): Promise<ChatResult> {
  const history = input.messages.map((m) => ({
    role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
    text: m.content,
  }));

  const text = await callGeminiText({
    system: [
      'You are Sanctum AI, an assistant embedded in a marketing-agency management tool.',
      'Answer concisely and helpfully using the agency context below. If the context lacks the answer, say so and suggest next steps.',
      '',
      input.systemContext,
    ].join('\n'),
    contents: history.length
      ? history
      : [{ role: 'user', text: 'Hello' }],
  });

  if (text && text.trim()) {
    return { reply: text.trim(), source: 'gemini' };
  }

  // Fallback: acknowledge the last user message with a useful canned reply.
  const lastUser = [...input.messages]
    .reverse()
    .find((m) => m.role === 'user');
  const reply = lastUser
    ? `AI is not configured on this server, so I can't generate a live answer right now. You asked: "${lastUser.content.slice(0, 280)}". Once a GEMINI_API_KEY is set I can answer using your agency, project, and client context.`
    : 'AI is not configured on this server. Set a GEMINI_API_KEY to enable the assistant.';
  return { reply, source: 'fallback' };
}

// ---------------------------------------------------------------------------
//  Task breakdown
// ---------------------------------------------------------------------------

export interface BreakdownTaskSuggestion {
  title: string;
  status?: string;
}
export interface BreakdownMilestoneSuggestion {
  title: string;
  tasks: BreakdownTaskSuggestion[];
}
export interface TaskBreakdownResult {
  milestones: BreakdownMilestoneSuggestion[];
  source: 'gemini' | 'fallback';
}

export interface TaskBreakdownInput {
  projectName: string;
  projectDescription?: string | null;
  prompt?: string;
}

const breakdownTaskSchema = z.object({
  title: z.string(),
  status: z.string().optional(),
});
const breakdownMilestoneSchema = z.object({
  title: z.string(),
  tasks: z.array(breakdownTaskSchema).optional(),
});
const breakdownSchema = z.object({
  milestones: z.array(breakdownMilestoneSchema),
});

function buildBreakdownPrompt(input: TaskBreakdownInput): string {
  return [
    'You are a senior project manager at a marketing agency. Break the project below into a sensible set of milestones, each with a few concrete tasks.',
    `Project name: ${input.projectName}.`,
    input.projectDescription
      ? `Project description: ${input.projectDescription}.`
      : '',
    input.prompt ? `Additional guidance: ${input.prompt}.` : '',
    '',
    'Allowed task status values: backlog, todo, in_progress, in_review, done. Default new tasks to "todo".',
    'Respond with ONLY a raw JSON object — no markdown fences, no prose — of this exact shape:',
    '{',
    '  "milestones": [',
    '    { "title": string, "tasks": [ { "title": string, "status": one of the allowed values } ] }',
    '  ]',
    '}',
    'Produce 3-5 milestones with 2-5 tasks each.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A sensible generic agency project breakdown used when AI is unavailable. */
function fallbackBreakdown(): TaskBreakdownResult {
  return {
    source: 'fallback',
    milestones: [
      {
        title: 'Discovery',
        tasks: [
          { title: 'Kickoff call & requirements gathering', status: 'todo' },
          { title: 'Audit current assets & accounts', status: 'todo' },
          { title: 'Define goals & success metrics', status: 'todo' },
        ],
      },
      {
        title: 'Production',
        tasks: [
          { title: 'Draft strategy & content plan', status: 'todo' },
          { title: 'Create deliverables', status: 'todo' },
          { title: 'Internal QA pass', status: 'todo' },
        ],
      },
      {
        title: 'Review',
        tasks: [
          { title: 'Share with client for feedback', status: 'todo' },
          { title: 'Incorporate revisions', status: 'todo' },
        ],
      },
      {
        title: 'Launch',
        tasks: [
          { title: 'Publish / hand off deliverables', status: 'todo' },
          { title: 'Post-launch report', status: 'todo' },
        ],
      },
    ],
  };
}

/**
 * Propose a milestone/task breakdown for a project. Tries Gemini (robust JSON
 * parse), falls back to a default breakdown. NEVER throws. Does NOT persist —
 * the route is responsible for creating rows.
 */
export async function generateTaskBreakdown(
  input: TaskBreakdownInput,
): Promise<TaskBreakdownResult> {
  const text = await callGeminiText({
    contents: [{ role: 'user', text: buildBreakdownPrompt(input) }],
  });
  if (text && text.trim()) {
    const cleaned = stripCodeFences(text);
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        const parsed = JSON.parse(cleaned.slice(first, last + 1));
        const validated = breakdownSchema.safeParse(parsed);
        if (validated.success && validated.data.milestones.length) {
          const milestones = validated.data.milestones
            .filter((m) => m.title.trim())
            .map((m) => ({
              title: m.title.trim(),
              tasks: (m.tasks ?? [])
                .filter((tk) => tk.title.trim())
                .map((tk) => ({
                  title: tk.title.trim(),
                  status: tk.status,
                })),
            }));
          if (milestones.length) {
            return { milestones, source: 'gemini' };
          }
        }
      } catch {
        // fall through to fallback
      }
    }
  }
  return fallbackBreakdown();
}

// ===========================================================================
//  Social-content AI helpers (captions, hashtags, ideas, repurpose)
//
//  Every function here follows the same contract as the rest of this module:
//  it tries Gemini and silently falls back to a deterministic local generator,
//  so a missing GEMINI_API_KEY NEVER throws. The `source` flag tells the caller
//  (and UI) which path produced the output.
// ===========================================================================

/** Tone presets shared by caption + repurpose helpers. */
export const CONTENT_TONES = [
  'professional',
  'casual',
  'playful',
  'inspirational',
  'bold',
  'witty',
  'educational',
  'luxury',
] as const;
export type ContentTone = (typeof CONTENT_TONES)[number];

/** Tidy a single line of model output: drop list markers, quotes, fences. */
function cleanLine(s: string): string {
  return s
    .replace(/^\s*[-*•\d.)\]]+\s*/, '')
    .replace(/^["“'']+|["”'']+$/g, '')
    .trim();
}

/** Split model text into non-empty, de-duplicated, trimmed lines. */
function toLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of stripCodeFences(text).split('\n')) {
    const line = cleanLine(raw);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * Parse a JSON array out of model text, validating each element against the
 * provided zod schema. Returns `null` (caller falls back) on any failure.
 */
function parseJsonArray<T>(
  text: string,
  schema: z.ZodType<T>,
): T[] | null {
  const cleaned = stripCodeFences(text);
  const first = cleaned.indexOf('[');
  const last = cleaned.lastIndexOf(']');
  if (first === -1 || last <= first) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(first, last + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: T[] = [];
  for (const item of parsed) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
//  Caption writer / rewriter
// ---------------------------------------------------------------------------

export interface CaptionInput {
  /** A brief/topic, OR an existing caption to rewrite. */
  brief: string;
  platform: string;
  tone?: string;
  /** When true, treat `brief` as an existing caption to improve/rewrite. */
  rewrite?: boolean;
  /** Optional brand/client name for grounding. */
  brandName?: string;
  variations?: number;
}

export interface CaptionResult {
  variations: string[];
  source: 'gemini' | 'fallback';
}

function buildCaptionPrompt(input: CaptionInput, count: number): string {
  return [
    `You are an expert social media copywriter for a content agency.`,
    input.rewrite
      ? `Rewrite and improve the following ${input.platform} caption.`
      : `Write ${input.platform} captions from the following brief.`,
    input.brandName ? `Brand: ${input.brandName}.` : '',
    input.tone ? `Tone: ${input.tone}.` : '',
    input.rewrite ? `Existing caption:\n${input.brief}` : `Brief:\n${input.brief}`,
    '',
    `Produce exactly ${count} distinct caption options. Each should be platform-appropriate for ${input.platform}, scroll-stopping, and include a light call-to-action. Use 0-3 tasteful emojis where natural. Do NOT include hashtags.`,
    'Respond with ONLY a raw JSON array of strings — no markdown fences, no numbering, no commentary.',
  ]
    .filter(Boolean)
    .join('\n');
}

const CAPTION_HOOKS = [
  (t: string, b: string) => `Stop scrolling 👀 ${t} is changing how ${b} shows up. Here's the why ⬇️`,
  (t: string, b: string) => `The truth about ${t} nobody at ${b} tells you. Save this one.`,
  (t: string, b: string) => `${b} POV: ${t} done right. Which take is yours? 💬`,
  (t: string, b: string) => `3 things ${b} learned about ${t} this week. #2 surprised us. ✨`,
  (t: string, b: string) => `Behind the scenes at ${b}: how we approach ${t}. Comment "more" for part 2.`,
  (t: string, b: string) => `If ${t} feels overwhelming, read this. ${b} breaks it down. Follow for more.`,
];

function fallbackCaptions(input: CaptionInput, count: number): CaptionResult {
  const brand = input.brandName?.trim() || 'your brand';
  const topic = input.brief.trim().split('\n')[0]?.slice(0, 80) || 'this';
  const seed = seedFrom(`${brand}|${topic}|${input.platform}`);
  const variations: string[] = [];
  for (let i = 0; i < count; i++) {
    const hook = CAPTION_HOOKS[(seed + i) % CAPTION_HOOKS.length]!;
    variations.push(hook(topic, brand));
  }
  return { variations, source: 'fallback' };
}

export async function generateCaptions(
  input: CaptionInput,
): Promise<CaptionResult> {
  const count = Math.min(Math.max(input.variations ?? 3, 1), 5);
  const text = await callGeminiText({
    contents: [{ role: 'user', text: buildCaptionPrompt(input, count) }],
  });
  if (text && text.trim()) {
    const arr = parseJsonArray(text, z.string().min(1));
    if (arr && arr.length) {
      return {
        variations: arr.map((s) => s.trim()).slice(0, count),
        source: 'gemini',
      };
    }
    // The model answered but not as JSON — salvage line-by-line.
    const lines = toLines(text).filter((l) => l.length > 10);
    if (lines.length) {
      return { variations: lines.slice(0, count), source: 'gemini' };
    }
  }
  return fallbackCaptions(input, count);
}

// ---------------------------------------------------------------------------
//  Hashtag suggestions (grouped: broad / niche / branded)
// ---------------------------------------------------------------------------

export interface HashtagInput {
  /** A caption or topic to derive hashtags from. */
  topic: string;
  platform: string;
  brandName?: string;
}

export interface HashtagGroups {
  broad: string[];
  niche: string[];
  branded: string[];
}

export interface HashtagResult {
  groups: HashtagGroups;
  source: 'gemini' | 'fallback';
}

/** Normalize a token into a single #hashtag (alnum only, no leading #). */
function toHashtag(raw: string): string | null {
  const cleaned = raw
    .replace(/^#+/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .trim();
  if (!cleaned) return null;
  return `#${cleaned}`;
}

const hashtagGroupsSchema = z.object({
  broad: z.array(z.string()).optional(),
  niche: z.array(z.string()).optional(),
  branded: z.array(z.string()).optional(),
});

function buildHashtagPrompt(input: HashtagInput): string {
  return [
    `You are a social media growth specialist. Suggest hashtags for a ${input.platform} post.`,
    input.brandName ? `Brand: ${input.brandName}.` : '',
    `Caption / topic:\n${input.topic}`,
    '',
    'Group them into:',
    '- "broad": 6-8 high-reach popular hashtags.',
    '- "niche": 6-8 specific, lower-competition hashtags closely tied to the topic.',
    '- "branded": 2-4 brand/campaign-style hashtags (use the brand name where given).',
    'Each value is a single hashtag string starting with "#", no spaces.',
    'Respond with ONLY a raw JSON object: {"broad":[...],"niche":[...],"branded":[...]} — no fences, no commentary.',
  ]
    .filter(Boolean)
    .join('\n');
}

const FALLBACK_BROAD = [
  '#socialmedia', '#contentcreator', '#marketing', '#branding',
  '#digitalmarketing', '#smallbusiness', '#instagood', '#trending',
];
function camelCase(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function fallbackHashtags(input: HashtagInput): HashtagResult {
  const words = input.topic
    .toLowerCase()
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length > 3)
    .slice(0, 8);
  const niche = Array.from(
    new Set(words.map((w) => toHashtag(w)).filter((x): x is string => !!x)),
  ).slice(0, 8);
  const platformTag = toHashtag(input.platform);
  const broad = Array.from(
    new Set([...FALLBACK_BROAD, ...(platformTag ? [platformTag] : [])]),
  ).slice(0, 8);
  const brand = input.brandName?.trim();
  const branded = brand
    ? [`#${camelCase(brand)}`, `#${camelCase(brand)}Official`]
    : ['#OurBrand'];
  return { groups: { broad, niche, branded }, source: 'fallback' };
}

function normalizeGroup(arr: string[] | undefined, max: number): string[] {
  if (!arr) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const tag = toHashtag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

export async function generateHashtags(
  input: HashtagInput,
): Promise<HashtagResult> {
  const text = await callGeminiText({
    contents: [{ role: 'user', text: buildHashtagPrompt(input) }],
  });
  if (text && text.trim()) {
    const cleaned = stripCodeFences(text);
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        const parsed = JSON.parse(cleaned.slice(first, last + 1));
        const validated = hashtagGroupsSchema.safeParse(parsed);
        if (validated.success) {
          const groups: HashtagGroups = {
            broad: normalizeGroup(validated.data.broad, 8),
            niche: normalizeGroup(validated.data.niche, 8),
            branded: normalizeGroup(validated.data.branded, 4),
          };
          if (
            groups.broad.length ||
            groups.niche.length ||
            groups.branded.length
          ) {
            return { groups, source: 'gemini' };
          }
        }
      } catch {
        // fall through
      }
    }
  }
  return fallbackHashtags(input);
}

// ---------------------------------------------------------------------------
//  Content ideas / brainstorm
// ---------------------------------------------------------------------------

export const IDEA_FORMATS = ['reel', 'carousel', 'story', 'post', 'live'] as const;

export interface ContentIdeaInput {
  /** Client / brand / niche to brainstorm for. */
  niche: string;
  count?: number;
  platform?: string;
  audience?: string;
}

export interface ContentIdea {
  hook: string;
  format: string;
  rationale: string;
}

export interface ContentIdeaResult {
  ideas: ContentIdea[];
  source: 'gemini' | 'fallback';
}

const contentIdeaSchema = z.object({
  hook: z.string(),
  format: z.string().optional(),
  rationale: z.string().optional(),
});

function buildIdeasPrompt(input: ContentIdeaInput, count: number): string {
  return [
    'You are a senior content strategist at a social media agency. Brainstorm fresh, specific post ideas.',
    `Client / niche: ${input.niche}.`,
    input.platform ? `Primary platform: ${input.platform}.` : '',
    input.audience ? `Target audience: ${input.audience}.` : '',
    '',
    `Produce exactly ${count} ideas. For each idea provide:`,
    '- "hook": a scroll-stopping hook / headline for the post.',
    `- "format": one of ${IDEA_FORMATS.join(', ')}.`,
    '- "rationale": one short sentence on why it works.',
    'Respond with ONLY a raw JSON array of objects {"hook","format","rationale"} — no fences, no commentary.',
  ]
    .filter(Boolean)
    .join('\n');
}

const IDEA_TEMPLATES: Array<(n: string) => ContentIdea> = [
  (n) => ({
    hook: `5 myths about ${n} — busted`,
    format: 'carousel',
    rationale: 'Myth-busting drives saves and positions the brand as an authority.',
  }),
  (n) => ({
    hook: `A day in the life working in ${n}`,
    format: 'reel',
    rationale: 'BTS day-in-the-life content humanizes the brand and boosts reach.',
  }),
  (n) => ({
    hook: `The biggest mistake people make with ${n}`,
    format: 'reel',
    rationale: 'Problem-led hooks earn comments from people who relate.',
  }),
  (n) => ({
    hook: `Before vs. after: ${n} edition`,
    format: 'post',
    rationale: 'Transformation content is highly shareable and proof-driven.',
  }),
  (n) => ({
    hook: `Quick tip: get more from ${n} in 30 seconds`,
    format: 'story',
    rationale: 'Bite-sized value keeps story completion rates high.',
  }),
  (n) => ({
    hook: `We asked our audience about ${n} — here's what they said`,
    format: 'carousel',
    rationale: 'Community-sourced content increases relevance and engagement.',
  }),
  (n) => ({
    hook: `${n}: what's actually worth your time in 2026`,
    format: 'post',
    rationale: 'Timely round-ups capture search and save intent.',
  }),
  (n) => ({
    hook: `Ask me anything about ${n}`,
    format: 'live',
    rationale: 'Live Q&As deepen trust and surface future content topics.',
  }),
];

function fallbackIdeas(input: ContentIdeaInput, count: number): ContentIdeaResult {
  const niche = input.niche.trim() || 'your niche';
  const seed = seedFrom(niche);
  const ideas: ContentIdea[] = [];
  for (let i = 0; i < count; i++) {
    const tmpl = IDEA_TEMPLATES[(seed + i) % IDEA_TEMPLATES.length]!;
    ideas.push(tmpl(niche));
  }
  return { ideas, source: 'fallback' };
}

export async function generateContentIdeas(
  input: ContentIdeaInput,
): Promise<ContentIdeaResult> {
  const count = Math.min(Math.max(input.count ?? 6, 1), 12);
  const text = await callGeminiText({
    contents: [{ role: 'user', text: buildIdeasPrompt(input, count) }],
  });
  if (text && text.trim()) {
    const arr = parseJsonArray(text, contentIdeaSchema);
    if (arr && arr.length) {
      const ideas = arr
        .filter((i) => i.hook.trim())
        .map((i) => ({
          hook: i.hook.trim(),
          format: (i.format ?? 'post').trim().toLowerCase(),
          rationale: (i.rationale ?? '').trim(),
        }));
      if (ideas.length) return { ideas: ideas.slice(0, count), source: 'gemini' };
    }
  }
  return fallbackIdeas(input, count);
}

// ---------------------------------------------------------------------------
//  Repurpose content across platforms
// ---------------------------------------------------------------------------

export const REPURPOSE_TARGETS = [
  'instagram',
  'linkedin',
  'x_thread',
  'facebook',
  'tiktok',
  'youtube',
  'newsletter',
] as const;
export type RepurposeTarget = (typeof REPURPOSE_TARGETS)[number];

const REPURPOSE_LABELS: Record<RepurposeTarget, string> = {
  instagram: 'Instagram caption',
  linkedin: 'LinkedIn post',
  x_thread: 'X (Twitter) thread',
  facebook: 'Facebook post',
  tiktok: 'TikTok script / caption',
  youtube: 'YouTube description',
  newsletter: 'email newsletter blurb',
};

export interface RepurposeInput {
  /** The source content to adapt. */
  content: string;
  target: RepurposeTarget;
  tone?: string;
  brandName?: string;
}

export interface RepurposeResult {
  /** Markdown-formatted adapted content. */
  content: string;
  targetLabel: string;
  source: 'gemini' | 'fallback';
}

function buildRepurposePrompt(input: RepurposeInput): string {
  const label = REPURPOSE_LABELS[input.target];
  const guidance: Record<RepurposeTarget, string> = {
    instagram: 'Keep it punchy with line breaks and a few emojis; end with a CTA. Suggest 3-5 hashtags on a new line.',
    linkedin: 'Professional, value-first, first-person. Short paragraphs, a strong opening line, and a reflective closing question.',
    x_thread: 'Write a numbered thread of 4-7 tweets, each under 280 characters. Lead with a hook tweet.',
    facebook: 'Conversational and community-oriented; a clear CTA to comment or share.',
    tiktok: 'A short spoken-style script with an on-screen hook in the first 2 seconds, then 3-4 beats, then a CTA.',
    youtube: 'An SEO-friendly description: 2-3 sentence summary, key timestamps placeholder, and a subscribe CTA.',
    newsletter: 'A warm, skimmable blurb with a subject-line suggestion and a single clear CTA.',
  };
  return [
    `You are a multi-platform content strategist. Repurpose the source content below into a ${label}.`,
    input.brandName ? `Brand: ${input.brandName}.` : '',
    input.tone ? `Tone: ${input.tone}.` : '',
    `Platform guidance: ${guidance[input.target]}`,
    '',
    `Source content:\n${input.content}`,
    '',
    'Keep the core message but adapt structure, length, and style to the target platform.',
    'Respond with ONLY the adapted content in Markdown — no preamble, no explanation, no code fences.',
  ]
    .filter(Boolean)
    .join('\n');
}

function fallbackRepurpose(input: RepurposeInput): RepurposeResult {
  const label = REPURPOSE_LABELS[input.target];
  const brand = input.brandName?.trim() || 'We';
  const src = input.content.trim();
  let body: string;
  switch (input.target) {
    case 'x_thread':
      body = [
        `1/ ${src.slice(0, 240)}`,
        `2/ Here's why it matters for you 👇`,
        `3/ The key takeaway: keep it simple and consistent.`,
        `4/ Follow for more. What would you add? 💬`,
      ].join('\n\n');
      break;
    case 'linkedin':
      body = `${src}\n\nAt ${brand}, we believe this is worth sharing.\n\nWhat's your take?`;
      break;
    case 'newsletter':
      body = `**Subject:** A quick note from ${brand}\n\n${src}\n\n_Reply and let us know your thoughts._`;
      break;
    default:
      body = `${src}\n\n— ${brand} ✨`;
  }
  return {
    content: body,
    targetLabel: label,
    source: 'fallback',
  };
}

export async function repurposeContent(
  input: RepurposeInput,
): Promise<RepurposeResult> {
  const label = REPURPOSE_LABELS[input.target];
  const text = await callGeminiText({
    contents: [{ role: 'user', text: buildRepurposePrompt(input) }],
  });
  if (text && text.trim()) {
    return {
      content: stripCodeFences(text),
      targetLabel: label,
      source: 'gemini',
    };
  }
  return fallbackRepurpose(input);
}

// ---------------------------------------------------------------------------
//  AI Proposal Generation & Enhancement
// ---------------------------------------------------------------------------

export interface AiProposalInput {
  prompt: string;
  clientName?: string;
  budgetRupees?: number;
  deliverablesCount?: number;
}

export interface AiProposalResult {
  title: string;
  overview: string;
  deliverables: Array<{
    title: string;
    description: string;
    priceRupees?: number;
  }>;
  terms: string[];
  estimatedDurationWeeks?: number;
  source: 'gemini' | 'fallback';
}

function buildProposalPrompt(input: AiProposalInput): string {
  const count = input.deliverablesCount ?? 4;
  return [
    'You are an executive creative director and agency strategist at a top-tier digital agency.',
    'Create a comprehensive, compelling client proposal based on the prompt below.',
    input.clientName ? `Client Name: ${input.clientName}` : '',
    input.budgetRupees ? `Target Budget: ₹${input.budgetRupees.toLocaleString('en-IN')}` : '',
    `User Brief / Requirements:\n${input.prompt}`,
    '',
    `Generate exactly ${count} distinct, high-value deliverables with clear milestone descriptions.`,
    'Include 4 professional commercial terms (IP assignment, revisions, payment schedules, warranties).',
    '',
    'Respond with ONLY a raw JSON object with this exact shape:',
    '{',
    '  "title": string (e.g. "Brand Identity & Omnichannel Growth Strategy"),',
    '  "overview": string (2-3 paragraphs executive summary highlighting client goals, approach, and strategic impact),',
    '  "deliverables": [',
    '    {',
    '      "title": string,',
    '      "description": string (detailed scope of work and key milestone outputs),',
    '      "priceRupees": number (optional estimated price)',
    '    }',
    '  ],',
    '  "terms": [string, string, string, string],',
    '  "estimatedDurationWeeks": number',
    '}',
    'No code fences, no markdown formatting outside JSON, no prose before or after.',
  ]
    .filter(Boolean)
    .join('\n');
}

function fallbackProposal(input: AiProposalInput): AiProposalResult {
  const client = input.clientName?.trim() || 'Valued Client';
  const brief = input.prompt.trim() || 'Comprehensive agency engagement and deliverables';
  const totalBudget = input.budgetRupees || 120000;
  const count = input.deliverablesCount || 4;
  const itemBudget = Math.round(totalBudget / count);

  return {
    title: `${brief.length > 50 ? brief.slice(0, 47) + '...' : brief} Scope & Strategy`,
    overview: `This proposal outlines our strategic engagement for ${client}. Our agency will lead end-to-end execution, combining high-impact creative direction, measurable deliverables, and structured milestone reviews to ensure rapid delivery and exceptional ROI.\n\nOur team coordinates cross-functional design, engineering, and growth workflows with dedicated weekly standups and transparent stakeholder communication throughout the engagement.`,
    deliverables: [
      {
        title: 'Phase 1: Discovery, Audit & Brand Positioning',
        description: 'Comprehensive competitive landscape analysis, stakeholder interviews, core audience profiling, and creative benchmark architecture.',
        priceRupees: itemBudget,
      },
      {
        title: 'Phase 2: Core Creative & Asset Production',
        description: 'Production of primary deliverables, interactive prototypes, design system components, and multimedia visual collateral.',
        priceRupees: itemBudget,
      },
      {
        title: 'Phase 3: Integration, Quality Assurance & Staging',
        description: 'Cross-platform testing, client feedback integration, performance optimization, and staging deployment verification.',
        priceRupees: itemBudget,
      },
      {
        title: 'Phase 4: Launch Execution & Handover',
        description: 'Production deployment, stakeholder training, comprehensive documentation, and 30-day post-launch optimization support.',
        priceRupees: totalBudget - itemBudget * 3,
      },
    ],
    terms: [
      'Intellectual Property: Full ownership of final deliverables transfers to the client upon receipt of final milestone settlement.',
      'Revisions: Scope includes up to 2 rounds of structured stakeholder revisions per deliverable milestone.',
      'Payment Schedule: 40% initial mobilization advance, 30% upon Phase 2 completion, and 30% upon final sign-off.',
      'Timeline & Dependencies: Timelines are contingent upon prompt client feedback within 3 business days of milestone submissions.',
    ],
    estimatedDurationWeeks: 6,
    source: 'fallback',
  };
}

export async function generateAiProposalDraft(
  input: AiProposalInput,
): Promise<AiProposalResult> {
  const text = await callGeminiText({
    contents: [{ role: 'user', text: buildProposalPrompt(input) }],
  });

  if (text && text.trim()) {
    const cleaned = stripCodeFences(text);
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        const parsed = JSON.parse(cleaned.slice(first, last + 1)) as any;
        if (parsed.title && Array.isArray(parsed.deliverables) && parsed.deliverables.length) {
          return {
            title: String(parsed.title),
            overview: String(parsed.overview || ''),
            deliverables: parsed.deliverables.map((d: any) => ({
              title: String(d.title || 'Deliverable'),
              description: String(d.description || ''),
              priceRupees: typeof d.priceRupees === 'number' ? d.priceRupees : undefined,
            })),
            terms: Array.isArray(parsed.terms) ? parsed.terms.map(String) : [],
            estimatedDurationWeeks: typeof parsed.estimatedDurationWeeks === 'number' ? parsed.estimatedDurationWeeks : 6,
            source: 'gemini',
          };
        }
      } catch {
        // Fall through to fallback
      }
    }
  }

  return fallbackProposal(input);
}

// ---------------------------------------------------------------------------
//  Full marketing proposal (10-section, per the agency proposal template)
// ---------------------------------------------------------------------------

export interface MarketingProposalBrief {
  clientName?: string | null;
  agencyName?: string | null;
  preparedBy?: string | null;
  industry?: string | null;
  services?: string[] | null;
  painPoints?: string | null;
  knownNumbers?: string | null;
  budget?: string | null;
  timeline?: string | null;
  notes?: string | null;
}

export interface MarketingTier {
  name: string;
  recommended: boolean;
  pricePerMonth: number | null; // rupees; null = to-be-filled
  bestFor: string;
  channels: string;
  adSpend: string;
  reporting: string;
  strategist: string;
  term: string;
}

export interface MarketingProposalContent {
  kind: 'marketing';
  title: string;
  preparedBy: string;
  situation: string;
  whereYouShouldBe: string;
  plan: { phase: string; outcome: string; bullets: string[] }[];
  scope: { included: { service: string; detail: string }[]; excluded: string[] };
  tiers: MarketingTier[];
  pricingNote: string;
  roi: { scenario: string; assumption: string; result: string; payback: string }[];
  roiNote: string;
  why: string;
  faq: { q: string; a: string }[];
  nextStep: string;
}

export interface MarketingProposalResult extends MarketingProposalContent {
  source: 'gemini' | 'fallback';
}

const MARKETING_SYSTEM = `You are a senior proposal strategist at a full-service digital marketing agency. Write a decision document for ONE buyer that earns a signature. Rules:
- Mirror the client's own situation; the "situation" section must be specific to THEM, not reusable.
- Ban jargon (synergy, full-funnel, best-in-class, leverage(verb), holistic, unlock, circle back). One idea per short paragraph. Headings/claims state outcomes.
- Never invent specific client numbers; use qualitative framing or clearly-labelled benchmark ranges. Never fabricate case studies.
- Pricing: three tiers, the MIDDLE one recommended, steps ~1.6–2x apart. If you don't know real prices use null for pricePerMonth.
- ROI: conservative / expected / strong scenarios with visible arithmetic in "assumption". Anchor the fee to the conservative case if the math supports it.
- Exactly ONE next step. No fake urgency. No "About Us" padding.
Return ONLY minified JSON, no prose, no code fences, matching exactly this TypeScript type:
{"title":string,"situation":string,"whereYouShouldBe":string,"plan":[{"phase":string,"outcome":string,"bullets":string[]}],"scope":{"included":[{"service":string,"detail":string}],"excluded":string[]},"tiers":[{"name":string,"recommended":boolean,"pricePerMonth":number|null,"bestFor":string,"channels":string,"adSpend":string,"reporting":string,"strategist":string,"term":string}],"pricingNote":string,"roi":[{"scenario":string,"assumption":string,"result":string,"payback":string}],"roiNote":string,"why":string,"faq":[{"q":string,"a":string}],"nextStep":string}
Currency is Indian Rupees (₹). plan = exactly 3 phases (Days 0–30 / 31–60 / 61–90). tiers = exactly 3 (STARTER, RECOMMENDED, SCALE). roi = exactly 3 rows. faq = 3 items.`;

function briefLines(b: MarketingProposalBrief): string {
  const svc = (b.services ?? []).filter(Boolean).join(', ');
  return [
    `Client / company: ${b.clientName || 'the client'}`,
    b.industry ? `Industry: ${b.industry}` : '',
    svc ? `Services being pitched: ${svc}` : 'Services: a tailored digital marketing engagement',
    b.painPoints ? `Stated pain points / goals: ${b.painPoints}` : '',
    b.knownNumbers ? `Known numbers: ${b.knownNumbers}` : '',
    b.budget ? `Budget signal: ${b.budget}` : '',
    b.timeline ? `Timeline / urgency: ${b.timeline}` : '',
    b.notes ? `Extra notes: ${b.notes}` : '',
    `Agency: ${b.agencyName || 'our agency'}${b.preparedBy ? `, prepared by ${b.preparedBy}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Deterministic, personalised fallback used when AI is off/unparseable. */
function fallbackMarketing(b: MarketingProposalBrief): MarketingProposalContent {
  const client = b.clientName || 'your business';
  const services =
    (b.services ?? []).filter(Boolean).length > 0
      ? (b.services as string[])
      : ['Paid Media', 'SEO & Content', 'Analytics & CRO'];
  const svcList = services.join(', ');
  const preparedBy = b.preparedBy || b.agencyName || 'Your account team';
  return {
    kind: 'marketing',
    title: `A 90-Day Growth Plan for ${client}`,
    preparedBy,
    situation: `${client}${b.industry ? ` operates in ${b.industry}, where` : ', where'} attention is expensive and buyers compare options in minutes. ${b.painPoints ? `You told us the priority is to ${b.painPoints}.` : `Based on what's public, we'd expect the main pressure is inconsistent lead flow and marketing spend that isn't clearly tied to revenue.`}\n\nRight now the effort is likely spread across channels without a single system connecting spend to outcomes — which makes it hard to know what to double down on.`,
    whereYouShouldBe: `Within 90 days, ${client} should have a measurable, compounding pipeline: a clear picture of which channels drive revenue, a repeatable content and campaign engine, and reporting you can trust. The cost of staying put isn't zero — every month without a system is budget spent that can't be attributed, and ground ceded to competitors who can.`,
    plan: [
      {
        phase: 'Phase 1 — Days 0–30 · Foundation',
        outcome: 'A clean measurement base and quick wins live.',
        bullets: [
          'Audit current channels, tracking, and funnel; fix analytics gaps.',
          `Stand up ${services[0] ?? 'paid media'} with tight targeting and a test budget.`,
          'Agree the KPIs and the single dashboard we report against.',
        ],
      },
      {
        phase: 'Phase 2 — Days 31–60 · Momentum',
        outcome: 'Winning channels scaled, weak ones cut.',
        bullets: [
          'Double down on the best-performing campaigns; pause the rest.',
          `Ship the first ${services[1] ?? 'content'} assets and landing-page improvements.`,
          'First full performance review against the KPIs.',
        ],
      },
      {
        phase: 'Phase 3 — Days 61–90 · Compounding',
        outcome: 'A repeatable growth engine you can see working.',
        bullets: [
          'Optimise conversion paths and creative from real data.',
          'Lock in the monthly operating rhythm and reporting cadence.',
          '90-day results readout with the plan for the next quarter.',
        ],
      },
    ],
    scope: {
      included: services.map((s) => ({
        service: s,
        detail: `[FILL: what's delivered for ${s} each month]`,
      })),
      excluded: [
        'Ad spend / media budget (billed at actuals, separate from the fee)',
        'Third-party tool licences and paid stock/creative assets',
        'Work outside the services listed above (scoped separately)',
      ],
    },
    tiers: [
      {
        name: 'STARTER',
        recommended: false,
        pricePerMonth: null,
        bestFor: 'Getting started with one core channel',
        channels: services.slice(0, 1).join(', ') || 'One channel',
        adSpend: '[FILL: up to ₹X/mo managed]',
        reporting: 'Monthly report',
        strategist: 'Shared strategist',
        term: 'Month-to-month',
      },
      {
        name: 'RECOMMENDED',
        recommended: true,
        pricePerMonth: null,
        bestFor: 'The full plan described above',
        channels: svcList,
        adSpend: '[FILL: up to ₹X/mo managed]',
        reporting: 'Bi-weekly report + monthly review call',
        strategist: 'Dedicated strategist',
        term: '3-month minimum, then monthly',
      },
      {
        name: 'SCALE',
        recommended: false,
        pricePerMonth: null,
        bestFor: 'Moving faster across more channels',
        channels: `${svcList} + additional channels`,
        adSpend: '[FILL: higher spend managed]',
        reporting: 'Weekly report + bi-weekly calls',
        strategist: 'Dedicated strategist + specialist team',
        term: '6-month minimum',
      },
    ],
    pricingNote:
      'Fees are monthly and cover the work above. Ad spend is passed through at actuals and billed separately. Nothing is introduced for the first time in fine print.',
    roi: [
      {
        scenario: 'Conservative',
        assumption: '[FILL: baseline metric] × [FILL: conservative % lift]',
        result: '[FILL: result / ₹ impact]',
        payback: '[FILL: months]',
      },
      {
        scenario: 'Expected',
        assumption: '[FILL: baseline metric] × [FILL: expected % lift]',
        result: '[FILL: result / ₹ impact]',
        payback: '[FILL: months]',
      },
      {
        scenario: 'Strong',
        assumption: '[FILL: baseline metric] × [FILL: strong % lift]',
        result: '[FILL: result / ₹ impact]',
        payback: '[FILL: months]',
      },
    ],
    roiNote:
      '[FILL: “Even in the conservative scenario, this pays for itself by month X” — only if the numbers above support it.]',
    why: `[FILL: 1–2 case studies matching ${client}'s industry or problem — starting metric → ending metric → timeframe → what changed. If none matches, replace with a stated guarantee or a pilot structure.]`,
    faq: [
      {
        q: 'How soon will we see results?',
        a: 'Foundational fixes and quick wins land inside the first 30 days; compounding results build across the 90-day plan. We report against agreed KPIs from week one so you always know where you stand.',
      },
      {
        q: 'What if it isn’t working?',
        a: 'We review against the KPIs at every checkpoint. If a channel underperforms, we reallocate — you’re never locked into spend that isn’t returning. The recommended tier starts with a 3-month window so we can prove the model.',
      },
      {
        q: 'Who actually does the work?',
        a: 'A dedicated strategist owns your account and coordinates the specialists (media, content, analytics). You get one point of contact, not a rotating cast.',
      },
    ],
    nextStep: `To get started, reply to this proposal or accept it online, and we’ll book a 30-minute kickoff to lock the plan${b.timeline ? ` ahead of ${b.timeline}` : ' and hit the ground running'}.`,
  };
}

const marketingCoerceSchema = z.object({
  title: z.string(),
  situation: z.string(),
  whereYouShouldBe: z.string(),
  plan: z
    .array(
      z.object({
        phase: z.string(),
        outcome: z.string(),
        bullets: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  scope: z
    .object({
      included: z
        .array(z.object({ service: z.string(), detail: z.string() }))
        .default([]),
      excluded: z.array(z.string()).default([]),
    })
    .default({ included: [], excluded: [] }),
  tiers: z
    .array(
      z.object({
        name: z.string(),
        recommended: z.boolean().default(false),
        pricePerMonth: z.number().nullable().default(null),
        bestFor: z.string().default(''),
        channels: z.string().default(''),
        adSpend: z.string().default(''),
        reporting: z.string().default(''),
        strategist: z.string().default(''),
        term: z.string().default(''),
      }),
    )
    .default([]),
  pricingNote: z.string().default(''),
  roi: z
    .array(
      z.object({
        scenario: z.string(),
        assumption: z.string().default(''),
        result: z.string().default(''),
        payback: z.string().default(''),
      }),
    )
    .default([]),
  roiNote: z.string().default(''),
  why: z.string().default(''),
  faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
  nextStep: z.string().default(''),
});

export async function generateMarketingProposal(
  brief: MarketingProposalBrief,
): Promise<MarketingProposalResult> {
  const text = await callGeminiText({
    system: MARKETING_SYSTEM,
    contents: [
      {
        role: 'user',
        text: `Write the proposal for this brief. Output only the JSON.\n\n${briefLines(brief)}`,
      },
    ],
  });

  if (text && text.trim()) {
    const cleaned = stripCodeFences(text);
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      const parsed = marketingCoerceSchema.safeParse(
        (() => {
          try {
            return JSON.parse(cleaned.slice(first, last + 1));
          } catch {
            return null;
          }
        })(),
      );
      if (parsed.success && parsed.data.plan.length && parsed.data.tiers.length) {
        return {
          kind: 'marketing',
          preparedBy: brief.preparedBy || brief.agencyName || 'Your account team',
          ...parsed.data,
          source: 'gemini',
        };
      }
    }
  }

  return { ...fallbackMarketing(brief), source: 'fallback' };
}

// ---------------------------------------------------------------------------
//  AI Agreement & Contract Generation
// ---------------------------------------------------------------------------

export interface AiAgreementInput {
  prompt: string;
  clientName?: string;
  agreementType?: string;
  retainerRupees?: number;
}

export interface AiAgreementResult {
  title: string;
  scope: string;
  clauses: string[];
  retainerRupees?: number;
  source: 'gemini' | 'fallback';
}

function buildAgreementPrompt(input: AiAgreementInput): string {
  return [
    'You are a legal counsel and contract specialist for professional creative and technology agencies.',
    'Draft a clear, legally sound, enforceable commercial agreement / statement of work based on the prompt below.',
    input.clientName ? `Client / Counterparty: ${input.clientName}` : '',
    input.agreementType ? `Agreement Type: ${input.agreementType}` : 'Master Services Agreement (MSA)',
    input.retainerRupees ? `Monthly Retainer: ₹${input.retainerRupees.toLocaleString('en-IN')}` : '',
    `Specific Terms / Context:\n${input.prompt}`,
    '',
    'Generate:',
    '1. Professional contract title',
    '2. Executive scope of services summary',
    '3. 5-7 robust clauses covering Intellectual Property, Confidentiality & NDA, Payment Terms & Invoicing, Term & Termination, Limitation of Liability, and Warranties.',
    '',
    'Respond with ONLY a raw JSON object with this exact shape:',
    '{',
    '  "title": string,',
    '  "scope": string,',
    '  "clauses": [string, string, string, string, string]',
    '}',
    'No code fences, no markdown formatting outside JSON.',
  ]
    .filter(Boolean)
    .join('\n');
}

function fallbackAgreement(input: AiAgreementInput): AiAgreementResult {
  const client = input.clientName?.trim() || 'Client';
  const type = input.agreementType || 'Master Services Agreement (MSA)';
  const brief = input.prompt.trim() || 'Professional digital agency services and deliverables';

  return {
    title: `${type} — ${client}`,
    scope: `The Agency agrees to provide comprehensive professional services to ${client} covering: ${brief}. All deliverables shall conform to industry-standard quality specifications and be executed in accordance with agreed project milestones.`,
    clauses: [
      '1. Scope of Services & Standard of Performance: The Agency shall perform all agreed services with professional diligence and standard industry care.',
      '2. Intellectual Property Rights: All custom artwork, software code, and creative assets produced specifically for the Client shall be assigned to the Client upon receipt of full final payment.',
      '3. Confidentiality & Non-Disclosure: Both parties agree to maintain strict confidentiality regarding proprietary business data, trade secrets, and internal operations.',
      '4. Payment Terms & Invoicing: Invoices shall be issued in accordance with milestone schedules and settled within 15 business days of receipt.',
      '5. Term & Termination: Either party may terminate this Agreement by providing 30 days written notice to the other party.',
      '6. Limitation of Liability: Neither party shall be liable for indirect, incidental, or consequential damages arising under this Agreement.',
    ],
    retainerRupees: input.retainerRupees,
    source: 'fallback',
  };
}

export async function generateAiAgreementDraft(
  input: AiAgreementInput,
): Promise<AiAgreementResult> {
  const text = await callGeminiText({
    contents: [{ role: 'user', text: buildAgreementPrompt(input) }],
  });

  if (text && text.trim()) {
    const cleaned = stripCodeFences(text);
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        const parsed = JSON.parse(cleaned.slice(first, last + 1)) as any;
        if (parsed.title && parsed.scope && Array.isArray(parsed.clauses)) {
          return {
            title: String(parsed.title),
            scope: String(parsed.scope),
            clauses: parsed.clauses.map(String),
            retainerRupees: input.retainerRupees,
            source: 'gemini',
          };
        }
      } catch {
        // Fall through
      }
    }
  }

  return fallbackAgreement(input);
}

// ---------------------------------------------------------------------------
//  AI Text Polish & Enhancement
// ---------------------------------------------------------------------------

export interface EnhanceTextInput {
  text: string;
  context?: string;
  instruction?: string;
}

export interface EnhanceTextResult {
  enhancedText: string;
  source: 'gemini' | 'fallback';
}

export async function enhanceTextWithAi(
  input: EnhanceTextInput,
): Promise<EnhanceTextResult> {
  const prompt = [
    'You are an expert agency copywriter and business strategist.',
    'Enhance, polish, and elevate the following text into professional, persuasive agency copy.',
    input.context ? `Context: ${input.context}` : '',
    input.instruction ? `Instruction: ${input.instruction}` : 'Make it clearer, more compelling, and professionally structured.',
    '',
    `Original Text:\n${input.text}`,
    '',
    'Respond with ONLY the enhanced text — no preamble, no commentary, no markdown code fences.',
  ]
    .filter(Boolean)
    .join('\n');

  const text = await callGeminiText({
    contents: [{ role: 'user', text: prompt }],
  });

  if (text && text.trim()) {
    return {
      enhancedText: stripCodeFences(text),
      source: 'gemini',
    };
  }

  return {
    enhancedText: input.text.trim(),
    source: 'fallback',
  };
}

