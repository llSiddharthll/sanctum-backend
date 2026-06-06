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
