import { z } from 'zod';
import { can } from '../../authz/engine.js';
import { defineTool, type SanctumTool } from '../tool-kit.js';
import { visibleTools } from '../server.js';

type Row = Record<string, unknown>;

/** Searchable record types: list endpoint, permission, and whether the API filters by `search`. */
const SEARCHABLE = [
  { type: 'client', path: '/clients', perm: 'clients.view', serverSearch: false, query: { status: 'all' } },
  { type: 'lead', path: '/leads', perm: 'leads.view', serverSearch: true },
  { type: 'project', path: '/projects', perm: 'projects.view', serverSearch: true },
  { type: 'proposal', path: '/proposals', perm: 'proposals.view', serverSearch: false },
  { type: 'agreement', path: '/agreements', perm: 'agreements.view', serverSearch: false },
  { type: 'invoice', path: '/invoices', perm: 'invoices.view', serverSearch: true },
] as const;

const TEXT_FIELDS = ['name', 'title', 'number', 'invoiceNumber', 'companyName', 'contactName', 'clientName', 'email'];

function rowsOf(out: unknown): Row[] {
  if (Array.isArray(out)) return out as Row[];
  const items = (out as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as Row[]) : [];
}

function summarize(type: string, r: Row) {
  const title = TEXT_FIELDS.map((f) => r[f]).find((v) => typeof v === 'string' && v) ?? String(r.id);
  const sub = [r.clientName, r.companyName, r.status ?? r.stage].filter((v) => typeof v === 'string' && v && v !== title);
  return { type, id: r.id, title, detail: sub.join(' · ') || undefined };
}

interface MeResponse {
  user?: { id: string; email: string; fullName?: string | null } | null;
  agency?: { id: string; name: string } | null;
  persona?: string;
  authorization?: { roles?: Array<{ id: string; name: string }> };
}

export const coreTools: SanctumTool[] = [
  defineTool({
    name: 'whoami',
    title: 'Who am I',
    description:
      'Shows the signed-in Sanctum user, their agency, their role(s), and which modules this connection can read or change. Call this first if unsure what the person is allowed to do.',
    anyOf: [],
    kind: 'read',
    input: {},
    run: async (_args, { api, actor }) => {
      const me = await api.get<MeResponse>('/auth/me');
      const tools = visibleTools(actor);
      const modules = (kind: 'read' | 'change') =>
        [
          ...new Set(
            tools
              .filter((t) => (kind === 'read' ? t.kind === 'read' : t.kind !== 'read'))
              .map((t) => t.name.split('_')[0]),
          ),
        ].sort();
      return {
        user: me.user ? { id: me.user.id, name: me.user.fullName ?? null, email: me.user.email } : null,
        agency: me.agency ? { id: me.agency.id, name: me.agency.name } : null,
        persona: me.persona ?? null,
        roles: me.authorization?.roles?.map((r) => r.name) ?? [],
        canRead: modules('read'),
        canChange: modules('change'),
        today: new Date().toISOString().slice(0, 10),
      };
    },
  }),

  defineTool({
    name: 'search',
    title: 'Search Sanctum',
    description:
      'Find clients, leads, projects, proposals, agreements and invoices by name, title, number or email, across every area you can see. Returns ids to use with the matching *_get / *_update tools. Use this whenever the person names something ("Bloom Digital", "INV-2026-002") and you need its id.',
    anyOf: [],
    kind: 'read',
    input: {
      query: z.string().trim().min(2).describe('Text to look for (part of a name, title, number or email)'),
      types: z
        .array(z.enum(['client', 'lead', 'project', 'proposal', 'agreement', 'invoice']))
        .optional()
        .describe('Only search these record types'),
      limitPerType: z.number().int().min(1).max(25).optional().describe('Max results per type (default 8)'),
    },
    run: async ({ query, types, limitPerType }, { api, actor }) => {
      const needle = query.toLowerCase();
      const max = limitPerType ?? 8;
      const targets = SEARCHABLE.filter((s) => (!types || types.includes(s.type)) && can(actor, s.perm));
      const results = await Promise.all(
        targets.map(async (s) => {
          try {
            const q = { ...('query' in s ? s.query : {}), ...(s.serverSearch ? { search: query } : {}) };
            const rows = rowsOf(await api.get(s.path, q));
            const matches = (r: Row) =>
              TEXT_FIELDS.some((f) => typeof r[f] === 'string' && (r[f] as string).toLowerCase().includes(needle));
            return rows
              .filter((r) => s.serverSearch || matches(r))
              .slice(0, max)
              .map((r) => summarize(s.type, r));
          } catch {
            return []; // an area the person can't read is simply skipped
          }
        }),
      );
      const matches = results.flat();
      return matches.length ? { query, matches } : { query, matches: [], note: 'Nothing found. Try a shorter or different spelling.' };
    },
  }),
];
