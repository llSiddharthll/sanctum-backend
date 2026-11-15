/**
 * Sanctum AI (in-app assistant) as an agent.
 *
 * Gemini function-calling over the same tool catalogue as the MCP server
 * (src/mcp/tools). Tools call the REST API with the signed-in user's own
 * access token, so the assistant can never see or do more than the person.
 *
 * Safety: only read tools run automatically. Any create / update / delete is
 * returned to the UI as a `pendingAction`; it runs only when the person
 * confirms (POST /ai/chat with `confirm`), and the API re-checks permissions.
 */
import { z } from 'zod';
import { env, aiEnabled } from '../env.js';
import type { StaffActor } from '../authz/actor.js';
import { createApiClient, type ApiClient } from '../mcp/api-client.js';
import { explainError, visibleTools } from '../mcp/server.js';
import type { SanctumTool, ToolKind } from '../mcp/tool-kit.js';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentStep {
  tool: string;
  title: string;
  kind: ToolKind;
  ok: boolean;
  error?: string;
  link?: string;
}

export interface PendingAction {
  tool: string;
  title: string;
  kind: 'write' | 'delete';
  args: Record<string, unknown>;
  details: Array<{ label: string; value: string }>;
}

export interface AgentResult {
  reply: string;
  source: 'gemini' | 'fallback';
  steps: AgentStep[];
  pendingAction: PendingAction | null;
}

export interface AgentInput {
  actor: StaffActor;
  /** The caller's access token (bearer or cookie) — tools act with it. */
  token: string;
  clientIp?: string;
  messages: AgentMessage[];
  /** Grounding text (agency / project / client summary). */
  systemContext: string;
  /** Pathname the person is looking at, e.g. /projects/prj_1. */
  page?: string;
  userName?: string | null;
  confirm?: { tool: string; args: Record<string, unknown> };
}

const MAX_STEPS = 6;
const MAX_TOOLS = 64;
const MAX_RESULT_CHARS = 14_000;

// ------------------------------------------------------------ tool selection

/** Module prefix → words that suggest it. Keeps the tool list small and relevant. */
const MODULE_HINTS: Record<string, RegExp> = {
  clients: /client|brand|customer|contact|account/i,
  leads: /lead|pipeline|prospect|enquir|inquir|deal/i,
  proposals: /proposal|quote|quotation|pitch/i,
  agreements: /agreement|contract|sign/i,
  invoices: /invoice|bill|payment|paid|outstanding|overdue|receivable|gst/i,
  expenses: /expense|spend|spent|cost|purchase/i,
  finance: /financ|revenue|profit|money|cash|earning|income|margin/i,
  dashboard: /dashboard|overview|this month|content queue|approval/i,
  projects: /project|milestone|campaign|retainer|label/i,
  tasks: /task|todo|to-do|assign|deadline|due|overdue|comment|subtask/i,
  my: /\bmy\b|\bme\b|plate|today|i have|i need/i,
  timers: /timer|track|start|stop/i,
  timesheet: /timesheet|hours|time log|logged|log time|\blog\b/i,
  team: /team|member|colleague|employee|staff|\bwho\b|invite|people/i,
  attendance: /attendance|check.?in|check.?out|present|absent|who'?s in|office|holiday|late/i,
  leaves: /leave|vacation|\boff\b|sick|absence/i,
  regularizations: /regulari|missed punch|correction/i,
  messages: /message|chat|thread|conversation|ping|tell\b|reply/i,
  notifications: /notification|alert|unread/i,
  documents: /document|file|\bdocs?\b|folder|brief|guideline/i,
  posts: /post|caption|reel|story|carousel|content|calendar|schedul|instagram|linkedin/i,
};

const PAGE_MODULES: Array<[RegExp, string[]]> = [
  [/^\/projects\//, ['projects', 'tasks', 'timesheet']],
  [/^\/projects$/, ['projects']],
  [/^\/clients\/[^/]+\/calendar/, ['posts', 'clients']],
  [/^\/clients/, ['clients', 'projects', 'invoices']],
  [/^\/leads/, ['leads']],
  [/^\/proposals/, ['proposals']],
  [/^\/agreements/, ['agreements']],
  [/^\/finance\/invoices/, ['invoices']],
  [/^\/finance\/expenses/, ['expenses']],
  [/^\/finance/, ['finance', 'invoices', 'expenses']],
  [/^\/tasks/, ['tasks', 'my']],
  [/^\/timesheet/, ['timesheet', 'timers']],
  [/^\/attendance/, ['attendance', 'leaves', 'regularizations']],
  [/^\/team/, ['team']],
  [/^\/messages/, ['messages']],
  [/^\/documents/, ['documents']],
  [/^\/calendar/, ['posts']],
  [/^\/dashboard/, ['dashboard', 'my', 'tasks']],
];

const ALWAYS = new Set(['whoami', 'search']);
const DEFAULT_MODULES = ['my', 'tasks', 'projects', 'clients'];

const moduleOf = (t: SanctumTool) => t.name.split('_')[0]!;

export function selectTools(actor: StaffActor, messages: AgentMessage[], page?: string, mustInclude?: string): SanctumTool[] {
  const visible = visibleTools(actor);
  const recentUser = messages.filter((m) => m.role === 'user').slice(-3).map((m) => m.content).join('\n');
  const wanted = new Set<string>();
  for (const [mod, re] of Object.entries(MODULE_HINTS)) if (re.test(recentUser)) wanted.add(mod);
  if (page) for (const [re, mods] of PAGE_MODULES) if (re.test(page)) mods.forEach((m) => wanted.add(m));
  if (wanted.size === 0) DEFAULT_MODULES.forEach((m) => wanted.add(m));
  // Timers and timesheets travel together; "my" tasks need the task tools to act on them.
  if (wanted.has('timers') || wanted.has('timesheet')) ['timers', 'timesheet', 'my'].forEach((m) => wanted.add(m));
  if (wanted.has('my')) wanted.add('tasks');

  const picked = visible.filter((t) => ALWAYS.has(t.name) || wanted.has(moduleOf(t)) || t.name === mustInclude);
  if (picked.length <= MAX_TOOLS) return picked;
  // Too many: keep every read tool first (answers), then writes, in catalogue order.
  const reads = picked.filter((t) => t.kind === 'read');
  const writes = picked.filter((t) => t.kind !== 'read');
  return [...reads, ...writes].slice(0, MAX_TOOLS);
}

// ------------------------------------------------------------ Gemini plumbing

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  [k: string]: unknown;
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
interface GeminiReply {
  candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
}

function jsonSchemaFor(tool: SanctumTool): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(tool.input as z.ZodRawShape)) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Reduce a JSON Schema to the OpenAPI subset Gemini's legacy `parameters` field accepts. */
function toOpenApiSubset(s: unknown): Record<string, unknown> {
  if (!s || typeof s !== 'object') return { type: 'string' };
  const src = s as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let type = src.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((x) => x !== 'null');
    if (nonNull.length < type.length) out.nullable = true;
    type = nonNull[0] ?? 'string';
  }
  if (!type && Array.isArray(src.anyOf)) {
    const first = (src.anyOf as Array<Record<string, unknown>>).find((x) => x.type !== 'null');
    return { ...toOpenApiSubset(first), ...(src.description ? { description: src.description } : {}) };
  }
  if (type) out.type = type;
  for (const k of ['description', 'enum', 'format', 'minimum', 'maximum', 'minItems', 'maxItems', 'required']) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  if (out.format && !['date-time', 'enum'].includes(out.format as string)) delete out.format;
  if (src.properties && typeof src.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(src.properties as Record<string, unknown>).map(([k, v]) => [k, toOpenApiSubset(v)]),
    );
  }
  if (src.items) out.items = toOpenApiSubset(src.items);
  return out;
}

let useLegacyParameters = false;

function declarations(tools: SanctumTool[]) {
  return tools.map((t) => {
    const schema = jsonSchemaFor(t);
    return {
      name: t.name,
      description: `${t.title}. ${t.description}`.slice(0, 1000),
      ...(useLegacyParameters ? { parameters: toOpenApiSubset(schema) } : { parametersJsonSchema: schema }),
    };
  });
}

async function callGemini(system: string, contents: GeminiContent[], tools: SanctumTool[]): Promise<GeminiReply | null> {
  if (!aiEnabled || !env.GEMINI_API_KEY || env.AI_PROVIDER !== 'gemini') return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`;
  const send = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'X-goog-api-key': env.GEMINI_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: tools.length ? [{ functionDeclarations: declarations(tools) }] : undefined,
        toolConfig: tools.length ? { functionCallingConfig: { mode: 'AUTO' } } : undefined,
        generationConfig: { temperature: 0.3 },
      }),
    });
  try {
    let resp = await send();
    // Older model versions only accept the OpenAPI-subset `parameters` field.
    if (resp.status === 400 && !useLegacyParameters) {
      const text = await resp.text();
      if (/parametersJsonSchema|Unknown name|Invalid JSON payload/i.test(text)) {
        useLegacyParameters = true;
        resp = await send();
      } else {
        return null;
      }
    }
    if (!resp.ok) return null;
    return (await resp.json()) as GeminiReply;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ tool execution

function truncateResult(out: unknown): Record<string, unknown> {
  const text = JSON.stringify(out ?? null);
  if (text.length <= MAX_RESULT_CHARS) {
    return { result: out ?? null };
  }
  return { result_truncated: `${text.slice(0, MAX_RESULT_CHARS)}… (truncated; narrow with filters)` };
}

/** Where in the app the person can see what a tool touched. */
export function linkFor(tool: SanctumTool, args: Record<string, unknown>, out: unknown): string | undefined {
  const a = args as Record<string, string | undefined>;
  const createdId = (out as { id?: string } | null)?.id;
  switch (moduleOf(tool)) {
    case 'clients': {
      const id = a.clientId ?? (tool.name === 'clients_create' ? createdId : undefined);
      return id ? `/clients/${id}` : '/clients';
    }
    case 'projects': {
      const id = a.projectId ?? (tool.name === 'projects_create' ? createdId : undefined);
      return id ? `/projects/${id}` : '/projects';
    }
    case 'tasks':
      return a.projectId ? `/projects/${a.projectId}` : '/tasks';
    case 'my':
      return '/tasks';
    case 'team':
      return a.userId ? `/team/${a.userId}` : '/team';
    case 'leads':
      return '/leads';
    case 'proposals':
      return '/proposals';
    case 'agreements':
      return '/agreements';
    case 'invoices':
      return '/finance/invoices';
    case 'expenses':
      return '/finance/expenses';
    case 'finance':
      return '/finance';
    case 'dashboard':
      return '/dashboard';
    case 'timers':
    case 'timesheet':
      return '/timesheet';
    case 'attendance':
    case 'leaves':
    case 'regularizations':
      return '/attendance';
    case 'messages':
      return '/messages';
    case 'documents':
      return '/documents';
    case 'posts':
      return a.clientId ? `/clients/${a.clientId}/calendar` : '/calendar';
    default:
      return undefined;
  }
}

async function runTool(
  tool: SanctumTool,
  rawArgs: Record<string, unknown>,
  ctx: { api: ApiClient; actor: StaffActor },
): Promise<{ step: AgentStep; response: Record<string, unknown> }> {
  const parsed = z.object(tool.input as z.ZodRawShape).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return {
      step: { tool: tool.name, title: tool.title, kind: tool.kind, ok: false, error: `Invalid input — ${msg}` },
      response: { error: `Invalid arguments: ${msg}` },
    };
  }
  try {
    const out = await tool.run(parsed.data as Record<string, unknown>, ctx);
    return {
      step: { tool: tool.name, title: tool.title, kind: tool.kind, ok: true, link: linkFor(tool, parsed.data, out) },
      response: truncateResult(out),
    };
  } catch (err) {
    const message = explainError(err);
    return {
      step: { tool: tool.name, title: tool.title, kind: tool.kind, ok: false, error: message },
      response: { error: message },
    };
  }
}

// ------------------------------------------------------------ confirmation details

const humanKey = (k: string) =>
  k
    .replace(/Rupees$/, '')
    .replace(/Ids?$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function describeValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return /Rupees$/.test(key) ? inr(v) : String(v);
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          const label = String(o.title ?? o.description ?? o.name ?? o.heading ?? 'Item');
          const qty = o.quantity !== undefined ? ` × ${o.quantity}` : '';
          const rate = typeof o.rateRupees === 'number' ? ` @ ${inr(o.rateRupees)}` : '';
          return `${label}${qty}${rate}`;
        }
        return String(item);
      })
      .join(', ')
      .slice(0, 400);
  }
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 300);
  return String(v).slice(0, 400);
}

/** Turn ids into names so the confirmation card is readable. Best effort. */
async function resolveName(api: ApiClient, key: string, id: string): Promise<string | null> {
  try {
    const path =
      key === 'clientId' ? `/clients/${encodeURIComponent(id)}`
      : key === 'projectId' ? `/projects/${encodeURIComponent(id)}`
      : key === 'userId' ? `/team/${encodeURIComponent(id)}`
      : key === 'leadId' ? `/leads/${encodeURIComponent(id)}`
      : null;
    if (!path) return null;
    const r = (await api.get(path)) as Record<string, unknown> & { client?: Record<string, unknown>; project?: Record<string, unknown>; user?: Record<string, unknown> };
    const o = r.client ?? r.project ?? r.user ?? r;
    const name = o.name ?? o.fullName ?? o.title;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

async function pendingFor(tool: SanctumTool, args: Record<string, unknown>, api: ApiClient): Promise<PendingAction> {
  const details: PendingAction['details'] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === undefined) continue;
    if (/Ids?$/.test(k)) {
      if (typeof v === 'string') {
        const name = await resolveName(api, k, v);
        if (name) details.push({ label: humanKey(k), value: name });
      } else if (Array.isArray(v) && k === 'assigneeIds') {
        const names = await Promise.all(v.map((id) => (typeof id === 'string' ? resolveName(api, 'userId', id) : null)));
        const shown = names.filter(Boolean);
        if (shown.length) details.push({ label: 'Assignees', value: shown.join(', ') });
      }
      continue; // raw ids are noise for people
    }
    details.push({ label: humanKey(k), value: describeValue(k, v) });
  }
  return { tool: tool.name, title: tool.title, kind: tool.kind === 'delete' ? 'delete' : 'write', args, details };
}

// ------------------------------------------------------------ the agent

function systemPrompt(input: AgentInput): string {
  const today = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return [
    'You are Sanctum AI, the assistant built into Sanctum, an agency workspace (clients, leads, proposals, agreements, projects, tasks, time, invoices, expenses, attendance, leave, content calendar, team, messages, documents).',
    `Today is ${today} (India, IST). ISO date today: ${new Date().toISOString().slice(0, 10)}.`,
    input.userName ? `You are helping ${input.userName}. You act as them and can only see and do what their Sanctum role allows.` : '',
    input.page ? `They are currently looking at the page ${input.page} — "this project/client" refers to the one in that URL.` : '',
    '',
    'How to work:',
    '- For any question about the agency\'s data, call tools to get live data; never guess or invent numbers, names or ids.',
    '- Find ids with `search` or the list tools before acting on a named thing.',
    '- Money in tool results is in PAISE: divide by 100 and show rupees with Indian grouping (e.g. ₹1,18,000). Tool inputs ending in "Rupees" take rupees.',
    '- To create, update or delete something, call the tool directly with complete arguments. Sanctum shows the person a confirmation card before anything changes, so do not ask "shall I?" in text first. If required details are missing or ambiguous, ask one short question instead.',
    '- Never say something was created, changed or sent unless a tool result confirms it.',
    '- If a tool reports "Not allowed", explain that their role does not permit it; do not retry.',
    '- For writing help (captions, emails, plans) just write; no tools needed.',
    '- Be brief and friendly. Use short markdown lists or tables for data. Mention record names, not raw ids.',
    '',
    'Background context:',
    input.systemContext,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Chat turns → Gemini contents, merging consecutive same-role turns (e.g. a reply + "Cancelled"). */
function toContents(messages: AgentMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push({ text: `\n\n${m.content}` });
    else out.push({ role, parts: [{ text: m.content }] });
  }
  // Gemini expects the conversation to start with the user.
  if (out[0]?.role === 'model') out.unshift({ role: 'user', parts: [{ text: '(conversation continues)' }] });
  return out;
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const api = createApiClient(input.token, input.clientIp);
  const ctx = { api, actor: input.actor };
  const steps: AgentStep[] = [];
  const messages = [...input.messages];
  const visible = new Map(visibleTools(input.actor).map((t) => [t.name, t]));

  // 1) A confirmed action runs first (the API re-checks every permission).
  let confirmNote: string | null = null;
  if (input.confirm) {
    const tool = visible.get(input.confirm.tool);
    if (!tool || tool.kind === 'read') {
      return {
        reply: "I couldn't run that action — it isn't available for your role.",
        source: 'fallback',
        steps,
        pendingAction: null,
      };
    }
    const { step, response } = await runTool(tool, input.confirm.args, ctx);
    steps.push(step);
    confirmNote = step.ok
      ? `[The person confirmed "${tool.title}" and it succeeded. Result: ${JSON.stringify(response).slice(0, 4000)}. Tell them briefly what was done (names, dates, amounts in rupees). Then, only if their original request needs another change, call the next tool.]`
      : `[The person confirmed "${tool.title}" but it failed: ${step.error}. Explain briefly and suggest a fix.]`;
    messages.push({ role: 'user', content: confirmNote });
  }

  const tools = selectTools(input.actor, input.messages, input.page);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const system = systemPrompt(input);
  const contents = toContents(messages);

  for (let i = 0; i < MAX_STEPS; i++) {
    const reply = await callGemini(system, contents, tools);
    const content = reply?.candidates?.[0]?.content;
    if (!content) break;
    const parts = content.parts ?? [];
    const text = parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      return { reply: text || 'Done.', source: 'gemini', steps, pendingAction: null };
    }

    contents.push({ role: 'model', parts });
    const responses: GeminiPart[] = [];
    for (const part of calls) {
      const call = part.functionCall!;
      const tool = byName.get(call.name) ?? visible.get(call.name);
      if (!tool) {
        responses.push({ functionResponse: { name: call.name, response: { error: 'This tool is not available.' } } });
        continue;
      }
      if (tool.kind !== 'read') {
        // Changes wait for the person's confirmation.
        const pendingAction = await pendingFor(tool, call.args ?? {}, api);
        return {
          reply: text || `Here's what I'll do — please confirm.`,
          source: 'gemini',
          steps,
          pendingAction,
        };
      }
      const { step, response } = await runTool(tool, call.args ?? {}, ctx);
      steps.push(step);
      responses.push({ functionResponse: { name: tool.name, response } });
    }
    contents.push({ role: 'user', parts: responses });
  }

  // No live model (or it failed / ran out of steps).
  if (!aiEnabled) {
    const done = steps.find((s) => s.kind !== 'read');
    return {
      reply: done
        ? done.ok
          ? `Done — ${done.title.toLowerCase()}.`
          : `That didn't work: ${done.error}`
        : 'AI is not configured on this server (no GEMINI_API_KEY), so I can only run actions you confirm.',
      source: 'fallback',
      steps,
      pendingAction: null,
    };
  }
  return {
    reply: steps.length
      ? "I looked a few things up but couldn't finish. Try asking in a more specific way."
      : "Sorry — I couldn't reach the AI service just now. Please try again in a moment.",
    source: 'fallback',
    steps,
    pendingAction: null,
  };
}
