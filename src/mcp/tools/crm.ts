/**
 * CRM / business tools: clients (+ contacts, notes, tags, deals, follow-ups),
 * leads (+ activities / follow-ups, conversion), proposals and agreements.
 *
 * Every tool maps 1:1 onto a REST route (src/routes/clients.ts, leads.ts,
 * crm.ts, proposals.ts, agreements.ts). Out of scope by design: portal share
 * links / portal logins / welcome links, public document review/sign links,
 * file uploads, and AI generation endpoints.
 */
import { z } from 'zod';
import {
  defineTool,
  paise,
  seg,
  compact,
  id,
  isoDate,
  limit,
  type SanctumTool,
} from '../tool-kit.js';

// ── shared enums (mirror the route schemas) ─────────────────────────────────
const CLIENT_SOURCES = ['referral', 'inbound', 'outbound', 'social', 'event', 'agency_network', 'other'] as const;
const RELATIONSHIP_HEALTH = ['excellent', 'good', 'at_risk', 'poor'] as const;
const LEAD_STAGES = ['new', 'contacted', 'qualified', 'converted', 'lost', 'spam'] as const;
/** Stages a person may set by hand (conversion goes through leads_convert). */
const LEAD_SETTABLE_STAGES = ['new', 'contacted', 'qualified', 'lost', 'spam'] as const;
const LEAD_ACTIVITY_TYPES = ['note', 'call', 'meeting', 'email', 'follow_up'] as const;
const NOTE_TYPES = ['note', 'call', 'meeting', 'email', 'task'] as const;
const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
const PROPOSAL_STATUSES = ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'converted'] as const;
const AGREEMENT_STATUSES = ['draft', 'sent', 'signed', 'active', 'terminated', 'expired'] as const;
const AGREEMENT_TEMPLATE_TYPES = ['msa', 'retainer', 'sow', 'nda', 'custom'] as const;

const DEFAULT_LIST_LIMIT = 50;
const take = <T>(rows: T[], n: number | undefined): T[] => rows.slice(0, n ?? DEFAULT_LIST_LIMIT);

const staffId = (what: string) =>
  z.string().min(1).describe(`${what} — a team member's user id (whoami returns your own)`);

// ── rich-content helpers (proposal content / agreement terms) ───────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain text → paragraph HTML; HTML passes through unchanged. */
function toHtml(body: string): string {
  const t = body.trim();
  if (!t) return '';
  if (/<[a-z][\s\S]*>/i.test(t)) return t;
  return t
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface StoredSection {
  heading: string;
  html: string;
}

const sectionInput = z.object({
  heading: z.string().trim().max(200).describe('Section heading, e.g. "Executive Summary"'),
  body: z.string().describe('Section text: plain text (blank line = new paragraph) or HTML'),
});
type SectionIn = z.infer<typeof sectionInput>;

function buildSections(sections: SectionIn[]): StoredSection[] {
  return sections
    .map((s) => ({ heading: s.heading.trim(), html: toHtml(s.body) }))
    .filter((s) => s.heading || htmlToText(s.html));
}

/** Plain-text mirror of the sections (kept for list cards / older viewers). */
function sectionsToPlain(sections: StoredSection[]): string {
  return sections
    .map((s) => [s.heading, htmlToText(s.html)].filter(Boolean).join('\n'))
    .join('\n\n')
    .trim();
}

function readStoredSections(v: unknown): StoredSection[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      heading: typeof s.heading === 'string' ? s.heading : '',
      html: typeof s.html === 'string' ? s.html : typeof s.body === 'string' ? toHtml(s.body) : '',
    }))
    .filter((s) => s.heading || s.html);
}

function readStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

const deliverableInput = z.object({
  title: z.string().trim().min(1).max(200).describe('Line item / deliverable name'),
  description: z.string().max(2000).optional(),
  quantity: z.number().positive().optional().describe('Quantity (default 1)'),
  rateRupees: z
    .number()
    .nonnegative()
    .optional()
    .describe('Price per unit in rupees. Omit if the user cannot see/set pricing.'),
  billing: z
    .enum(['one_time', 'monthly'])
    .optional()
    .describe('one_time (default) counts toward the one-time total; monthly counts toward the monthly retainer'),
});
type DeliverableIn = z.infer<typeof deliverableInput>;

/** Stored proposal deliverable shape (same as the portal's form builder). */
function buildDeliverables(items: DeliverableIn[]) {
  return items.map((d) => {
    const quantity = d.quantity ?? 1;
    const priced =
      d.rateRupees !== undefined
        ? {
            rateRupees: d.rateRupees,
            priceRupees: quantity * d.rateRupees,
            pricePaise: paise(quantity * d.rateRupees),
          }
        : {};
    return {
      title: d.title.trim(),
      description: (d.description ?? '').trim(),
      quantity,
      ...priced,
      billing: d.billing ?? 'one_time',
    };
  });
}

/** Stored deliverable (from a template or existing proposal) → tool input shape. */
function readStoredDeliverables(v: unknown): DeliverableIn[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => {
      const quantity = typeof d.quantity === 'number' && d.quantity > 0 ? d.quantity : 1;
      const rate =
        typeof d.rateRupees === 'number'
          ? d.rateRupees
          : typeof d.priceRupees === 'number'
            ? d.priceRupees / quantity
            : typeof d.pricePaise === 'number'
              ? d.pricePaise / 100 / quantity
              : undefined;
      return {
        title: typeof d.title === 'string' && d.title.trim() ? d.title : 'Deliverable',
        description: typeof d.description === 'string' ? d.description : '',
        quantity,
        rateRupees: rate,
        billing: d.billing === 'monthly' ? ('monthly' as const) : ('one_time' as const),
      };
    });
}

/**
 * Portal pricing rule: one-time lines → subtotal; GST (taxPercent, default 18)
 * on the one-time subtotal; monthly lines → recurring retainer.
 * Returns only billingType when no line carries a price.
 */
interface ProposalPricing {
  billingType?: 'one_time' | 'retainer';
  subtotalPaise?: number;
  taxPaise?: number;
  totalPaise?: number;
  recurringPaise?: number | null;
}

function proposalPricing(items: DeliverableIn[], taxPercent: number): ProposalPricing {
  const billingType = items.some((d) => d.billing === 'monthly') ? ('retainer' as const) : ('one_time' as const);
  if (!items.some((d) => d.rateRupees !== undefined)) return { billingType };
  let oneTime = 0;
  let monthly = 0;
  for (const d of items) {
    const amount = paise((d.quantity ?? 1) * (d.rateRupees ?? 0));
    if (d.billing === 'monthly') monthly += amount;
    else oneTime += amount;
  }
  const taxPaise = Math.round((oneTime * taxPercent) / 100);
  return {
    billingType: monthly > 0 ? ('retainer' as const) : ('one_time' as const),
    subtotalPaise: oneTime,
    taxPaise,
    totalPaise: oneTime + taxPaise,
    recurringPaise: monthly > 0 ? monthly : null,
  };
}

const proposalMoneyOverrides = {
  subtotalRupees: z.number().nonnegative().optional().describe('Override: one-time subtotal in rupees (before tax)'),
  taxRupees: z.number().nonnegative().optional().describe('Override: tax amount in rupees'),
  totalRupees: z.number().nonnegative().optional().describe('Override: one-time total in rupees (incl. tax)'),
  recurringRupees: z.number().nonnegative().nullable().optional().describe('Override: monthly retainer amount in rupees'),
  billingType: z.enum(['one_time', 'retainer']).optional().describe('Override: one_time or retainer'),
  taxPercent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('GST % applied to one-time line items when computing totals (default 18)'),
};

interface ProposalTemplate {
  id: string;
  name: string;
  category?: string | null;
  description?: string | null;
  content?: Record<string, unknown>;
}

interface AgreementTemplate {
  id: string;
  name: string;
  type?: string | null;
  description?: string | null;
  terms?: Record<string, unknown>;
}

interface ProposalRow {
  id: string;
  proposalNumber: string | null;
  title: string;
  status: string;
  clientId: string | null;
  clientName: string | null;
  leadId: string | null;
  leadName: string | null;
  currency: string;
  billingType: string;
  subtotalPaise: number | null;
  totalPaise: number | null;
  recurringPaise: number | null;
  validUntil: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  convertedAgreementId: string | null;
  createdByName: string | null;
  createdAt: string;
  content?: Record<string, unknown>;
}

interface AgreementRow {
  id: string;
  agreementNumber: string | null;
  title: string;
  status: string;
  clientId: string;
  clientName: string | null;
  proposalId: string | null;
  projectId: string | null;
  currency: string;
  retainerPaise: number | null;
  totalValuePaise: number | null;
  effectiveDate: string | null;
  expirationDate: string | null;
  sentAt: string | null;
  signedAt: string | null;
  signerName: string | null;
  createdAt: string;
  terms?: Record<string, unknown>;
  signatureDataUrl?: string | null;
}

/**
 * Build proposal content + pricing fields from tool input. `base` is the
 * existing content (update) or template content (create); parts the caller
 * passes replace the matching part of `base`, everything else is kept.
 */
function composeProposal(
  base: Record<string, unknown>,
  input: {
    sections?: SectionIn[];
    deliverables?: DeliverableIn[];
    terms?: string[];
    taxPercent?: number;
    subtotalRupees?: number;
    taxRupees?: number;
    totalRupees?: number;
    recurringRupees?: number | null;
    billingType?: 'one_time' | 'retainer';
  },
  recomputeFromBase: boolean,
) {
  const content: Record<string, unknown> = { ...base };
  if (input.sections) {
    const sections = buildSections(input.sections);
    content.sections = sections;
    content.scopeOverview = sectionsToPlain(sections);
  }
  const lineItems = input.deliverables ?? (recomputeFromBase ? readStoredDeliverables(base.deliverables) : undefined);
  if (lineItems) content.deliverables = buildDeliverables(lineItems);
  if (input.terms) content.terms = input.terms.map((t) => t.trim()).filter(Boolean);

  const computed: ProposalPricing = lineItems ? proposalPricing(lineItems, input.taxPercent ?? 18) : {};
  const money: Record<string, unknown> = compact({
    subtotalPaise: paise(input.subtotalRupees) ?? computed.subtotalPaise,
    taxPaise: paise(input.taxRupees) ?? computed.taxPaise,
    totalPaise: paise(input.totalRupees) ?? computed.totalPaise,
    recurringPaise: input.recurringRupees !== undefined ? paise(input.recurringRupees) : computed.recurringPaise,
    billingType: input.billingType ?? computed.billingType,
  });
  return { content, money };
}

/** Build agreement terms ({ scope, sections, clauses, …}) from tool input over `base`. */
function composeAgreementTerms(
  base: Record<string, unknown>,
  input: { sections?: SectionIn[]; clauses?: string[] },
): Record<string, unknown> {
  const terms: Record<string, unknown> = { ...base };
  if (input.sections) {
    const sections = buildSections(input.sections);
    terms.sections = sections;
    terms.scope = sectionsToPlain(sections) || 'Agency professional services execution.';
  } else if (typeof terms.scope !== 'string' || !terms.scope) {
    const existing = readStoredSections(terms.sections);
    terms.scope = (existing && sectionsToPlain(existing)) || 'Agency professional services execution.';
  }
  if (input.clauses) terms.clauses = input.clauses.map((c) => c.trim()).filter(Boolean);
  else if (!readStrings(terms.clauses)) terms.clauses = [];
  return terms;
}

// ── summaries ───────────────────────────────────────────────────────────────
const proposalSummary = (p: ProposalRow) => ({
  id: p.id,
  number: p.proposalNumber,
  title: p.title,
  status: p.status,
  clientId: p.clientId,
  clientName: p.clientName,
  leadId: p.leadId,
  leadName: p.leadName,
  billingType: p.billingType,
  totalPaise: p.totalPaise,
  recurringPaise: p.recurringPaise,
  validUntil: p.validUntil,
  sentAt: p.sentAt,
  acceptedAt: p.acceptedAt,
  rejectedAt: p.rejectedAt,
  convertedAgreementId: p.convertedAgreementId,
  createdAt: p.createdAt,
});

const agreementSummary = (a: AgreementRow) => ({
  id: a.id,
  number: a.agreementNumber,
  title: a.title,
  status: a.status,
  clientId: a.clientId,
  clientName: a.clientName,
  proposalId: a.proposalId,
  projectId: a.projectId,
  retainerPaise: a.retainerPaise,
  totalValuePaise: a.totalValuePaise,
  effectiveDate: a.effectiveDate,
  expirationDate: a.expirationDate,
  sentAt: a.sentAt,
  signedAt: a.signedAt,
  signerName: a.signerName,
});

/** Drop the (large base64) signature image from agreement payloads. */
function leanAgreement<T extends { signatureDataUrl?: string | null }>(a: T) {
  const { signatureDataUrl, ...rest } = a;
  return { ...rest, hasSignature: !!signatureDataUrl };
}

// ============================================================================
//  CLIENTS
// ============================================================================
interface ClientRow {
  id: string;
  name: string;
  status: string;
  industry: string | null;
  contactEmail: string | null;
  phone: string | null;
  clientSource: string | null;
  relationshipHealth: string | null;
  nextFollowUpAt: string | null;
  ownerId: string | null;
}

const clientWritable = {
  logoUrl: z.string().url().nullable().optional().describe('Logo image URL'),
  brandColor: z.string().max(20).nullable().optional().describe('Brand colour, e.g. #ff6b00'),
  handles: z
    .record(z.string(), z.string())
    .optional()
    .describe('Social handles, e.g. {"instagram":"@brand","linkedin":"company/brand"}'),
  contactEmail: z.string().email().nullable().optional(),
  industry: z.string().trim().max(120).nullable().optional(),
  website: z.string().trim().max(255).nullable().optional(),
  phoneCc: z.string().trim().max(8).nullable().optional().describe('Phone country code, e.g. +91'),
  phone: z.string().trim().max(32).nullable().optional(),
  clientSource: z.enum(CLIENT_SOURCES).nullable().optional().describe('How the client was acquired'),
  gstNumber: z.string().trim().max(32).nullable().optional().describe('GSTIN (needs clients.view_financials)'),
  paymentTermsDays: z.number().int().min(0).nullable().optional().describe('Invoice payment terms in days (financial)'),
  billingAddress: z.string().trim().max(500).nullable().optional().describe('Financial field'),
  billingState: z.string().trim().max(120).nullable().optional().describe('Financial field'),
  billingCity: z.string().trim().max(120).nullable().optional().describe('Financial field'),
  billingPincode: z.string().trim().max(16).nullable().optional().describe('Financial field'),
  relationshipHealth: z.enum(RELATIONSHIP_HEALTH).optional(),
  nextFollowUpAt: isoDate('Next follow-up date; null clears it').nullable().optional(),
  internalNotes: z.string().trim().max(5000).nullable().optional().describe('Internal notes (staff only)'),
  ownerId: staffId('Account manager (needs clients.manage_assignments); null clears').nullable().optional(),
  portalRole: z
    .enum(['approver', 'reviewer'])
    .optional()
    .describe("Client's role in the client portal (needs clients.manage_portal)"),
};

const clientTools: SanctumTool[] = [
  defineTool({
    name: 'clients_list',
    title: 'List clients',
    description:
      'Lists clients the user can see (active by default). Returns a lean summary per client; use clients_get for full details. Search/owner filters are applied to the result list.',
    anyOf: ['clients.view'],
    kind: 'read',
    input: {
      status: z.enum(['active', 'archived', 'all']).optional().describe('Default active'),
      search: z.string().optional().describe('Case-insensitive match on name, email or industry'),
      ownerId: z.string().optional().describe('Only clients managed by this team member'),
      limit,
    },
    run: async ({ status, search, ownerId, limit: n }, { api }) => {
      const rows = await api.get<ClientRow[]>('/clients', { status });
      const q = search?.trim().toLowerCase();
      const filtered = rows.filter(
        (c) =>
          (!ownerId || c.ownerId === ownerId) &&
          (!q ||
            [c.name, c.contactEmail, c.industry].some((v) => v && v.toLowerCase().includes(q))),
      );
      return {
        total: filtered.length,
        clients: take(filtered, n).map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          industry: c.industry,
          contactEmail: c.contactEmail,
          phone: c.phone,
          relationshipHealth: c.relationshipHealth,
          nextFollowUpAt: c.nextFollowUpAt,
          ownerId: c.ownerId,
        })),
      };
    },
  }),

  defineTool({
    name: 'clients_get',
    title: 'Get client details',
    description:
      'Full client profile: contact info, billing/GST (if permitted), owner, tags, project/invoice/document counts, outstanding amount (paise), plus the client\'s contacts. Find the id with clients_list.',
    anyOf: ['clients.view'],
    kind: 'read',
    input: { clientId: id('Client') },
    run: async ({ clientId }, { api }) => {
      const [client, contacts] = await Promise.all([
        api.get<Record<string, unknown>>(`/clients/${seg(clientId)}`),
        api.get<unknown[]>(`/crm/clients/${seg(clientId)}/contacts`),
      ]);
      return { ...client, contacts };
    },
  }),

  defineTool({
    name: 'clients_create',
    title: 'Create a client',
    description:
      'Creates a new client. Subject to the plan\'s client limit. Billing/GST fields need financial access; ownerId needs assignment permission. To turn a lead into a client use leads_convert instead.',
    anyOf: ['clients.create'],
    kind: 'write',
    input: {
      name: z.string().min(1).max(120),
      ...clientWritable,
      isActive: z.boolean().optional().describe('false creates it archived (default true)'),
    },
    run: (args, { api }) => api.post('/clients', compact(args)),
  }),

  defineTool({
    name: 'clients_update',
    title: 'Update a client',
    description:
      "Changes a client's details. Only the fields you pass are changed; pass null to clear a field. To archive/restore use clients_archive / clients_restore. Find the id with clients_list.",
    anyOf: ['clients.update'],
    kind: 'write',
    input: {
      clientId: id('Client'),
      name: z.string().min(1).max(120).optional(),
      ...clientWritable,
    },
    run: ({ clientId, ...rest }, { api }) => api.patch(`/clients/${seg(clientId)}`, compact(rest)),
  }),

  defineTool({
    name: 'clients_archive',
    title: 'Archive a client',
    description:
      'Archives a client (hides it from pickers and active lists). Reversible with clients_restore. Find the id with clients_list.',
    anyOf: ['clients.archive'],
    kind: 'write',
    input: { clientId: id('Client') },
    run: ({ clientId }, { api }) => api.post(`/clients/${seg(clientId)}/archive`),
  }),

  defineTool({
    name: 'clients_restore',
    title: 'Restore an archived client',
    description:
      'Restores an archived client to active (checks the plan client limit). Find archived clients with clients_list status=archived.',
    anyOf: ['clients.archive'],
    kind: 'write',
    input: { clientId: id('Client') },
    run: ({ clientId }, { api }) => api.post(`/clients/${seg(clientId)}/restore`),
  }),

  defineTool({
    name: 'clients_activity',
    title: 'Client activity feed',
    description:
      "Recent audit activity across a client's projects (who did what, when). Find the id with clients_list.",
    anyOf: ['clients.view_activity'],
    kind: 'read',
    input: { clientId: id('Client'), limit },
    run: async ({ clientId, limit: n }, { api }) => {
      const rows = await api.get<
        Array<{ action: string; actorName: string | null; entityType: string; projectName: string | null; createdAt: string; metadata: unknown }>
      >(`/clients/${seg(clientId)}/activity`, { limit: n ?? 60 });
      return rows.map((r) => ({
        at: r.createdAt,
        action: r.action,
        by: r.actorName,
        entityType: r.entityType,
        project: r.projectName,
        metadata: r.metadata,
      }));
    },
  }),

  defineTool({
    name: 'clients_follow_ups',
    title: 'Client follow-ups due',
    description:
      'Active clients with a next follow-up date, soonest first (default: due within the next 14 days, incl. overdue). Set the date with clients_update nextFollowUpAt.',
    anyOf: ['clients.view'],
    kind: 'read',
    input: {
      window: z.enum(['next_14_days', 'all']).optional().describe('Default next_14_days'),
    },
    run: ({ window }, { api }) => api.get('/crm/follow-ups', { window: window === 'all' ? 'all' : undefined }),
  }),

  defineTool({
    name: 'clients_pinned_messages',
    title: "Client's pinned messages",
    description:
      "Pinned messages from this client's conversations that you participate in (the key facts of the account), newest pin first. Find the id with clients_list.",
    anyOf: ['messages.view'],
    allOf: ['clients.view'],
    kind: 'read',
    input: { clientId: id('Client') },
    run: async ({ clientId }, { api }) => {
      const rows = await api.get<
        Array<{ id: string; threadId: string; threadSubject: string | null; senderName: string | null; body: string; pinnedAt: string | null; projectId: string | null }>
      >(`/clients/${seg(clientId)}/pinned`);
      return rows.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        thread: m.threadSubject,
        from: m.senderName,
        body: m.body,
        pinnedAt: m.pinnedAt,
        projectId: m.projectId,
      }));
    },
  }),

  // ── contacts ──
  defineTool({
    name: 'clients_contacts_list',
    title: "List a client's contacts",
    description: 'People at a client (primary first). Find the client id with clients_list.',
    anyOf: ['clients.view'],
    kind: 'read',
    input: { clientId: id('Client') },
    run: ({ clientId }, { api }) => api.get(`/crm/clients/${seg(clientId)}/contacts`),
  }),

  defineTool({
    name: 'clients_contacts_add',
    title: 'Add a client contact',
    description:
      'Adds a contact person to a client. Setting isPrimary/isBilling moves that flag from any other contact. Find the client id with clients_list.',
    anyOf: ['contacts.manage'],
    kind: 'write',
    input: {
      clientId: id('Client'),
      name: z.string().trim().min(1).max(120),
      role: z.string().trim().max(80).nullable().optional().describe('Job title / role'),
      email: z.string().email().nullable().optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      isPrimary: z.boolean().optional(),
      isBilling: z.boolean().optional().describe('Receives invoices'),
      notes: z.string().trim().max(1000).nullable().optional(),
    },
    run: ({ clientId, ...rest }, { api }) => api.post(`/crm/clients/${seg(clientId)}/contacts`, compact(rest)),
  }),

  defineTool({
    name: 'clients_contacts_update',
    title: 'Update a client contact',
    description:
      'Changes a contact. Only fields you pass change; null clears. Find the contact id with clients_contacts_list.',
    anyOf: ['contacts.manage'],
    kind: 'write',
    input: {
      contactId: id('Contact'),
      name: z.string().trim().min(1).max(120).optional(),
      role: z.string().trim().max(80).nullable().optional(),
      email: z.string().email().nullable().optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      isPrimary: z.boolean().optional(),
      isBilling: z.boolean().optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
    },
    run: ({ contactId, ...rest }, { api }) => api.patch(`/crm/contacts/${seg(contactId)}`, compact(rest)),
  }),

  defineTool({
    name: 'clients_contacts_delete',
    title: 'Delete a client contact',
    description: 'Permanently deletes a contact person. Find the contact id with clients_contacts_list.',
    anyOf: ['contacts.manage'],
    kind: 'delete',
    input: { contactId: id('Contact') },
    run: ({ contactId }, { api }) => api.delete(`/crm/contacts/${seg(contactId)}`),
  }),

  // ── notes / timeline ──
  defineTool({
    name: 'clients_notes_list',
    title: "List a client's notes",
    description:
      "A client's notes / calls / meetings / emails / tasks timeline (pinned first, newest first). Find the client id with clients_list.",
    anyOf: ['clients.view'],
    kind: 'read',
    input: { clientId: id('Client'), limit },
    run: async ({ clientId, limit: n }, { api }) => {
      const rows = await api.get<
        Array<{ id: string; type: string; body: string; pinned: boolean; authorName: string | null; dueAt: string | null; completedAt: string | null; createdAt: string }>
      >(`/crm/clients/${seg(clientId)}/notes`);
      return take(rows, n).map((r) => ({
        id: r.id,
        type: r.type,
        body: r.body,
        pinned: r.pinned,
        author: r.authorName,
        dueAt: r.dueAt,
        completedAt: r.completedAt,
        createdAt: r.createdAt,
      }));
    },
  }),

  defineTool({
    name: 'clients_notes_add',
    title: 'Log a client note / call / task',
    description:
      "Adds an entry to a client's timeline: a note, call, meeting or email log, or a task with a due date. Find the client id with clients_list.",
    anyOf: ['client_notes.create'],
    kind: 'write',
    input: {
      clientId: id('Client'),
      body: z.string().trim().min(1).max(5000),
      type: z.enum(NOTE_TYPES).optional().describe('Default note'),
      pinned: z.boolean().optional(),
      dueAt: isoDate('Due date (for tasks)').nullable().optional(),
    },
    run: ({ clientId, ...rest }, { api }) => api.post(`/crm/clients/${seg(clientId)}/notes`, compact(rest)),
  }),

  defineTool({
    name: 'clients_notes_update',
    title: 'Update a client note',
    description:
      'Edits a client note/task: text, type, pin, due date, or mark a task completed. Find the note id with clients_notes_list.',
    anyOf: ['client_notes.update'],
    kind: 'write',
    input: {
      noteId: id('Note'),
      body: z.string().trim().min(1).max(5000).optional(),
      type: z.enum(NOTE_TYPES).optional(),
      pinned: z.boolean().optional(),
      dueAt: isoDate('Due date; null clears').nullable().optional(),
      completed: z.boolean().optional().describe('true marks done, false reopens'),
    },
    run: ({ noteId, ...rest }, { api }) => api.patch(`/crm/notes/${seg(noteId)}`, compact(rest)),
  }),

  defineTool({
    name: 'clients_notes_delete',
    title: 'Delete a client note',
    description: 'Permanently deletes a client note/task. Find the note id with clients_notes_list.',
    anyOf: ['client_notes.delete'],
    kind: 'delete',
    input: { noteId: id('Note') },
    run: ({ noteId }, { api }) => api.delete(`/crm/notes/${seg(noteId)}`),
  }),

  // ── tags ──
  defineTool({
    name: 'clients_tags_list',
    title: 'List client tags',
    description:
      "All client tag labels in the agency (id, name, colour). Pass clientId to get only that client's tags.",
    anyOf: ['clients.view'],
    kind: 'read',
    input: { clientId: z.string().min(1).optional().describe('Client id (optional)') },
    run: ({ clientId }, { api }) =>
      clientId ? api.get(`/crm/clients/${seg(clientId)}/tags`) : api.get('/crm/tags'),
  }),

  defineTool({
    name: 'clients_tags_create',
    title: 'Create a client tag',
    description: 'Creates a new agency-wide client tag label. Attach it to clients with clients_tag.',
    anyOf: ['tags.manage'],
    kind: 'write',
    input: {
      name: z.string().trim().min(1).max(40),
      colorToken: z.string().trim().max(20).optional().describe("Colour token (default 'pine')"),
    },
    run: (args, { api }) => api.post('/crm/tags', compact(args)),
  }),

  defineTool({
    name: 'clients_tags_delete',
    title: 'Delete a client tag',
    description:
      'Permanently deletes a tag label and removes it from every client. Find the tag id with clients_tags_list.',
    anyOf: ['tags.manage'],
    kind: 'delete',
    input: { tagId: id('Tag') },
    run: ({ tagId }, { api }) => api.delete(`/crm/tags/${seg(tagId)}`),
  }),

  defineTool({
    name: 'clients_tag',
    title: 'Tag / untag a client',
    description:
      'Adds a tag to a client or removes it. Find the client id with clients_list and the tag id with clients_tags_list.',
    anyOf: ['clients.update'],
    kind: 'write',
    input: {
      clientId: id('Client'),
      tagId: id('Tag'),
      action: z.enum(['add', 'remove']).optional().describe('Default add'),
    },
    run: ({ clientId, tagId, action }, { api }) => {
      const path = `/crm/clients/${seg(clientId)}/tags/${seg(tagId)}`;
      return action === 'remove' ? api.delete(path) : api.post(path);
    },
  }),

  // ── deals / pipeline ──
  defineTool({
    name: 'clients_deals_list',
    title: 'List deals (sales pipeline)',
    description:
      'Deals in the sales pipeline (upsell/new business on existing clients). Optional filters by client and stage. valuePaise is in paise (null without value access).',
    anyOf: ['deals.view'],
    kind: 'read',
    input: {
      clientId: z.string().min(1).optional().describe('Only deals for this client (from clients_list)'),
      stage: z.enum(DEAL_STAGES).optional(),
      open: z.boolean().optional().describe('true = only open deals (not won/lost)'),
      limit,
    },
    run: async ({ clientId, stage, open, limit: n }, { api }) => {
      const rows = await api.get<
        Array<{ id: string; clientId: string; clientName: string | null; title: string; stage: string; valuePaise: number | null; currency: string; probability: number; expectedCloseAt: string | null; ownerName: string | null; closedAt: string | null }>
      >(clientId ? `/crm/clients/${seg(clientId)}/deals` : '/crm/deals');
      const filtered = rows.filter(
        (d) => (!stage || d.stage === stage) && (!open || (d.stage !== 'won' && d.stage !== 'lost')),
      );
      return {
        total: filtered.length,
        deals: take(filtered, n).map((d) => ({
          id: d.id,
          title: d.title,
          clientId: d.clientId,
          clientName: d.clientName,
          stage: d.stage,
          valuePaise: d.valuePaise,
          currency: d.currency,
          probability: d.probability,
          expectedCloseAt: d.expectedCloseAt,
          owner: d.ownerName,
          closedAt: d.closedAt,
        })),
      };
    },
  }),

  defineTool({
    name: 'clients_deals_create',
    title: 'Create a deal',
    description:
      'Adds a deal to the pipeline for a client. Setting a value needs deals.update_value. Find the client id with clients_list.',
    anyOf: ['deals.create'],
    kind: 'write',
    input: {
      clientId: id('Client'),
      title: z.string().trim().min(1).max(160),
      stage: z.enum(DEAL_STAGES).optional().describe('Default lead'),
      valueRupees: z.number().nonnegative().optional().describe('Deal value in rupees'),
      currency: z.string().trim().max(8).optional().describe('Default INR'),
      probability: z.number().int().min(0).max(100).optional().describe('Win probability %'),
      expectedCloseAt: isoDate('Expected close date').nullable().optional(),
      ownerId: staffId('Deal owner').nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    },
    run: ({ clientId, valueRupees, ...rest }, { api }) =>
      api.post(`/crm/clients/${seg(clientId)}/deals`, compact({ ...rest, valuePaise: paise(valueRupees) })),
  }),

  defineTool({
    name: 'clients_deals_update',
    title: 'Update a deal',
    description:
      'Changes a deal: move stage (won/lost closes it), value, probability, close date, owner, notes, lost reason. Only passed fields change. Find the id with clients_deals_list.',
    anyOf: ['deals.update'],
    kind: 'write',
    input: {
      dealId: id('Deal'),
      title: z.string().trim().min(1).max(160).optional(),
      stage: z.enum(DEAL_STAGES).optional(),
      valueRupees: z.number().nonnegative().optional().describe('Deal value in rupees (needs deals.update_value)'),
      currency: z.string().trim().max(8).optional(),
      probability: z.number().int().min(0).max(100).optional(),
      expectedCloseAt: isoDate('Expected close date; null clears').nullable().optional(),
      ownerId: staffId('Deal owner').nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
      lostReason: z.string().trim().max(500).nullable().optional(),
    },
    run: ({ dealId, valueRupees, ...rest }, { api }) =>
      api.patch(`/crm/deals/${seg(dealId)}`, compact({ ...rest, valuePaise: paise(valueRupees) })),
  }),

  defineTool({
    name: 'clients_deals_delete',
    title: 'Delete a deal',
    description: 'Permanently deletes a deal. Find the id with clients_deals_list.',
    anyOf: ['deals.delete'],
    kind: 'delete',
    input: { dealId: id('Deal') },
    run: ({ dealId }, { api }) => api.delete(`/crm/deals/${seg(dealId)}`),
  }),
];

// ============================================================================
//  LEADS
// ============================================================================
interface LeadRow {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  service: string | null;
  budget: string | null;
  stage: string;
  estimatedValue: number | null;
  ownerId: string | null;
  ownerName: string | null;
  convertedClientId: string | null;
  openFollowUps: number;
  nextFollowUpAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
}

const leadWritable = {
  company: z.string().trim().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().trim().max(60).nullable().optional(),
  service: z.string().trim().max(200).nullable().optional().describe('Service they are interested in'),
  budget: z.string().trim().max(120).nullable().optional().describe('Budget as free text, e.g. "₹50k-1L/mo" (needs leads.view_value)'),
  message: z.string().trim().max(5000).nullable().optional().describe('Enquiry message / context'),
  estimatedValueRupees: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe('Estimated deal value in rupees (needs leads.view_value)'),
  ownerId: staffId('Lead owner (assigning to someone else needs leads.assign)').nullable().optional(),
  stage: z.enum(LEAD_SETTABLE_STAGES).optional().describe('Use leads_convert to convert'),
};

const leadTools: SanctumTool[] = [
  defineTool({
    name: 'leads_list',
    title: 'List leads',
    description:
      'Lists leads in the user\'s scope. bucket: open (new/contacted/qualified, default), converted, bin (lost/spam), all; or filter one stage. estimatedValue is in paise. Use leads_get for the activity timeline.',
    anyOf: ['leads.view'],
    kind: 'read',
    input: {
      bucket: z.enum(['open', 'converted', 'bin', 'all']).optional(),
      stage: z.enum(LEAD_STAGES).optional().describe('Overrides bucket'),
      search: z.string().optional().describe('Matches name, company or email'),
      limit,
    },
    run: async ({ bucket, stage, search, limit: n }, { api }) => {
      const rows = await api.get<LeadRow[]>('/leads', { bucket, stage, search });
      return {
        total: rows.length,
        leads: take(rows, n).map((l) => ({
          id: l.id,
          name: l.name,
          company: l.company,
          email: l.email,
          phone: l.phone,
          stage: l.stage,
          source: l.source,
          service: l.service,
          budget: l.budget,
          estimatedValue: l.estimatedValue,
          owner: l.ownerName,
          openFollowUps: l.openFollowUps,
          nextFollowUpAt: l.nextFollowUpAt,
          lastActivityAt: l.lastActivityAt,
          convertedClientId: l.convertedClientId,
          createdAt: l.createdAt,
        })),
      };
    },
  }),

  defineTool({
    name: 'leads_stats',
    title: 'Lead pipeline counts',
    description: 'Counts of leads by stage and by bucket (open / converted / bin) in the user\'s scope.',
    anyOf: ['leads.view'],
    kind: 'read',
    input: {},
    run: (_args, { api }) => api.get('/leads/stats'),
  }),

  defineTool({
    name: 'leads_follow_ups',
    title: 'Pending lead follow-ups',
    description:
      'Open follow-ups across open leads, soonest due first, with an overdue flag. Mark one done with leads_activity_update done=true.',
    anyOf: ['leads.view'],
    kind: 'read',
    input: {
      overdueOnly: z.boolean().optional(),
      limit,
    },
    run: async ({ overdueOnly, limit: n }, { api }) => {
      const rows = await api.get<
        Array<{ id: string; leadId: string; leadName: string; leadCompany: string | null; leadStage: string; body: string; dueAt: string | null; overdue: boolean; authorName: string | null }>
      >('/leads/follow-ups');
      const filtered = overdueOnly ? rows.filter((r) => r.overdue) : rows;
      return {
        total: filtered.length,
        followUps: take(filtered, n).map((r) => ({
          activityId: r.id,
          leadId: r.leadId,
          lead: r.leadCompany ? `${r.leadName} (${r.leadCompany})` : r.leadName,
          leadStage: r.leadStage,
          body: r.body,
          dueAt: r.dueAt,
          overdue: r.overdue,
          by: r.authorName,
        })),
      };
    },
  }),

  defineTool({
    name: 'leads_get',
    title: 'Get lead details',
    description:
      'Full lead record with its activity timeline (notes, calls, follow-ups, stage changes). Find the id with leads_list.',
    anyOf: ['leads.view'],
    kind: 'read',
    input: { leadId: id('Lead') },
    run: ({ leadId }, { api }) => api.get(`/leads/${seg(leadId)}`),
  }),

  defineTool({
    name: 'leads_create',
    title: 'Create a lead',
    description:
      'Adds a lead manually. Owner defaults to you. Add a follow-up afterwards with leads_activity_add type=follow_up.',
    anyOf: ['leads.create'],
    kind: 'write',
    input: {
      name: z.string().trim().min(1).max(200).describe('Contact person name'),
      source: z.string().trim().max(120).nullable().optional().describe('Where it came from, e.g. website, referral (default manual)'),
      ...leadWritable,
    },
    run: ({ estimatedValueRupees, ...rest }, { api }) =>
      api.post('/leads', compact({ ...rest, estimatedValue: paise(estimatedValueRupees) })),
  }),

  defineTool({
    name: 'leads_update',
    title: 'Update a lead / move stage',
    description:
      'Changes lead fields, moves it to another stage (new, contacted, qualified, lost, spam), or reassigns the owner. Only passed fields change; null clears. A stage change is logged on the timeline. Find the id with leads_list.',
    anyOf: ['leads.update'],
    kind: 'write',
    input: {
      leadId: id('Lead'),
      name: z.string().trim().min(1).max(200).optional(),
      ...leadWritable,
    },
    run: ({ leadId, estimatedValueRupees, ...rest }, { api }) =>
      api.patch(`/leads/${seg(leadId)}`, compact({ ...rest, estimatedValue: paise(estimatedValueRupees) })),
  }),

  defineTool({
    name: 'leads_convert',
    title: 'Convert a lead to a client',
    description:
      'Creates a client from the lead and marks the lead converted (idempotent: an already-converted lead returns its client). Returns clientId. Find the lead id with leads_list.',
    anyOf: ['leads.convert'],
    allOf: ['clients.create'],
    kind: 'write',
    input: {
      leadId: id('Lead'),
      name: z.string().trim().min(1).max(200).optional().describe('Client name (default: the lead\'s company or name)'),
      industry: z.string().trim().max(120).optional(),
    },
    run: ({ leadId, ...rest }, { api }) => api.post(`/leads/${seg(leadId)}/convert`, compact(rest)),
  }),

  defineTool({
    name: 'leads_delete',
    title: 'Delete a lead',
    description:
      'Permanently deletes a lead and its whole activity timeline. To keep it but close it, use leads_update stage=lost or spam instead. Find the id with leads_list.',
    anyOf: ['leads.delete'],
    kind: 'delete',
    input: { leadId: id('Lead') },
    run: ({ leadId }, { api }) => api.delete(`/leads/${seg(leadId)}`),
  }),

  defineTool({
    name: 'leads_activity_add',
    title: 'Log lead activity / schedule follow-up',
    description:
      'Adds a note, call, meeting or email log to a lead, or schedules a follow-up (type=follow_up with dueAt). Find the lead id with leads_list.',
    anyOf: ['leads.update'],
    kind: 'write',
    input: {
      leadId: id('Lead'),
      body: z.string().trim().min(1).max(5000).describe('What happened / what to do'),
      type: z.enum(LEAD_ACTIVITY_TYPES).optional().describe('Default note'),
      dueAt: isoDate('Due date/time (for follow-ups)').nullable().optional(),
    },
    run: ({ leadId, ...rest }, { api }) => api.post(`/leads/${seg(leadId)}/activities`, compact(rest)),
  }),

  defineTool({
    name: 'leads_activity_update',
    title: 'Update lead activity / complete follow-up',
    description:
      'Edits a lead activity (text, due date) or marks a follow-up done/undone. Stage-change history cannot be edited. Find ids with leads_get (activities) or leads_follow_ups.',
    anyOf: ['leads.update'],
    kind: 'write',
    input: {
      leadId: id('Lead'),
      activityId: id('Activity'),
      body: z.string().trim().min(1).max(5000).optional(),
      dueAt: isoDate('Due date; null clears').nullable().optional(),
      done: z.boolean().optional().describe('true = completed now, false = reopen'),
    },
    run: ({ leadId, activityId, ...rest }, { api }) =>
      api.patch(`/leads/${seg(leadId)}/activities/${seg(activityId)}`, compact(rest)),
  }),

  defineTool({
    name: 'leads_activity_delete',
    title: 'Delete a lead activity',
    description:
      'Permanently deletes a note/follow-up from a lead (not stage-change history). Find ids with leads_get.',
    anyOf: ['leads.delete'],
    kind: 'delete',
    input: { leadId: id('Lead'), activityId: id('Activity') },
    run: ({ leadId, activityId }, { api }) =>
      api.delete(`/leads/${seg(leadId)}/activities/${seg(activityId)}`),
  }),
];

// ============================================================================
//  PROPOSALS
// ============================================================================
const proposalContentInput = {
  sections: z
    .array(sectionInput)
    .optional()
    .describe('Document sections in order (e.g. Executive Summary, Approach, Timeline). Replaces all sections.'),
  deliverables: z
    .array(deliverableInput)
    .optional()
    .describe('Line items with pricing. Replaces all line items and recomputes subtotal/GST/total/retainer.'),
  terms: z.array(z.string()).optional().describe('Terms & conditions bullet points. Replaces all terms.'),
};

const proposalTools: SanctumTool[] = [
  defineTool({
    name: 'proposals_list',
    title: 'List proposals',
    description:
      'Lists proposals in the user\'s scope, newest first, optionally for one client or lead and/or status. Money is in paise (null without pricing access). Use proposals_get for full content.',
    anyOf: ['proposals.view'],
    kind: 'read',
    input: {
      clientId: z.string().min(1).optional().describe('From clients_list'),
      leadId: z.string().min(1).optional().describe('From leads_list'),
      status: z.enum(PROPOSAL_STATUSES).optional(),
      limit,
    },
    run: async ({ clientId, leadId, status, limit: n }, { api }) => {
      const rows = await api.get<ProposalRow[]>('/proposals', { clientId, leadId });
      const filtered = status ? rows.filter((p) => p.status === status) : rows;
      return { total: filtered.length, proposals: take(filtered, n).map(proposalSummary) };
    },
  }),

  defineTool({
    name: 'proposals_get',
    title: 'Get proposal details',
    description:
      'Full proposal: sections, line items (deliverables), terms, pricing in paise, status timeline (sent/viewed/accepted/rejected + reason), linked agreement. Find the id with proposals_list.',
    anyOf: ['proposals.view'],
    kind: 'read',
    input: { proposalId: id('Proposal') },
    run: ({ proposalId }, { api }) => api.get(`/proposals/${seg(proposalId)}`),
  }),

  defineTool({
    name: 'proposals_templates_list',
    title: 'List proposal templates',
    description: 'Saved proposal templates (id, name, category, content). Pass templateId to proposals_create to start from one.',
    anyOf: ['proposals.view'],
    kind: 'read',
    input: {},
    run: (_args, { api }) => api.get('/proposals/templates'),
  }),

  defineTool({
    name: 'proposals_templates_create',
    title: 'Save a proposal template',
    description:
      'Saves a reusable proposal template from sections, line items and terms (rates in rupees).',
    anyOf: ['proposals.manage_templates'],
    kind: 'write',
    input: {
      name: z.string().trim().min(1).max(160),
      category: z.string().trim().max(60).optional().describe("Default 'general'"),
      description: z.string().trim().max(1000).optional(),
      ...proposalContentInput,
    },
    run: ({ name, category, description, sections, deliverables, terms }, { api }) => {
      const { content } = composeProposal({}, { sections, deliverables, terms }, false);
      return api.post('/proposals/templates', compact({ name, category, description, content }));
    },
  }),

  defineTool({
    name: 'proposals_create',
    title: 'Create a proposal',
    description:
      'Creates a draft proposal for a client or a lead. Build it from sections (narrative), deliverables (priced line items; one-time items get GST, monthly items form the retainer) and terms. Totals are computed like the portal unless you pass the *Rupees overrides. With templateId and no sections/deliverables/terms, the template content is used. Nothing is sent — use proposals_send afterwards.',
    anyOf: ['proposals.create'],
    kind: 'write',
    input: {
      title: z.string().trim().min(1).max(200),
      clientId: z.string().min(1).optional().describe('Client id (from clients_list) — set this or leadId'),
      leadId: z.string().min(1).optional().describe('Lead id (from leads_list) — set this or clientId'),
      templateId: z.string().min(1).optional().describe('From proposals_templates_list'),
      validUntil: isoDate('Valid until').optional(),
      currency: z.string().trim().max(8).optional().describe('Default INR'),
      ...proposalContentInput,
      ...proposalMoneyOverrides,
    },
    run: async (args, { api }) => {
      const { title, clientId, leadId, templateId, validUntil, currency, ...rest } = args;
      let base: Record<string, unknown> = {};
      let useBaseItems = false;
      if (templateId && !rest.sections && !rest.deliverables && !rest.terms) {
        const templates = await api.get<ProposalTemplate[]>('/proposals/templates');
        const tpl = templates.find((t) => t.id === templateId);
        if (tpl?.content) {
          base = { ...tpl.content };
          const tplSections = readStoredSections(tpl.content.sections);
          if (tplSections) {
            base.sections = tplSections;
            base.scopeOverview = sectionsToPlain(tplSections);
          }
          useBaseItems = true;
        }
      }
      const { content, money } = composeProposal(base, rest, useBaseItems);
      return api.post(
        '/proposals',
        compact({ title, clientId, leadId, templateId, validUntil, currency, ...money, content }),
      );
    },
  }),

  defineTool({
    name: 'proposals_update',
    title: 'Update a proposal',
    description:
      'Edits a proposal (draft/sent/viewed/rejected/accepted). Only what you pass changes: sections, deliverables or terms each replace that whole part (other content is kept); passing deliverables recomputes pricing. Editing a rejected proposal revives it as a draft so it can be re-sent. Converted proposals are frozen. Find the id with proposals_list; read current content with proposals_get.',
    anyOf: ['proposals.update'],
    kind: 'write',
    input: {
      proposalId: id('Proposal'),
      title: z.string().trim().min(1).max(200).optional(),
      clientId: z.string().min(1).nullable().optional().describe('Switch to a client (null removes)'),
      leadId: z.string().min(1).nullable().optional().describe('Switch to a lead (null removes)'),
      validUntil: isoDate('Valid until; null clears').nullable().optional(),
      currency: z.string().trim().max(8).optional(),
      ...proposalContentInput,
      ...proposalMoneyOverrides,
    },
    run: async (args, { api }) => {
      const { proposalId, title, clientId, leadId, validUntil, currency, ...rest } = args;
      const touchesContent = !!(rest.sections || rest.deliverables || rest.terms);
      let content: Record<string, unknown> | undefined;
      let money: Record<string, unknown> = {};
      if (touchesContent) {
        const current = await api.get<ProposalRow>(`/proposals/${seg(proposalId)}`);
        const composed = composeProposal(current.content ?? {}, rest, false);
        content = composed.content;
        money = composed.money;
      } else {
        money = composeProposal({}, rest, false).money;
      }
      return api.put(
        `/proposals/${seg(proposalId)}`,
        compact({ title, clientId, leadId, validUntil, currency, ...money, content }),
      );
    },
  }),

  defineTool({
    name: 'proposals_send',
    title: 'Send a proposal',
    description:
      'Emails the proposal to the recipient with a review link where they can accept or request changes (file-based proposals are delivered via the client portal instead). Marks a draft as sent; any earlier link stops working. Must not be past validUntil. Find the id with proposals_list.',
    anyOf: ['proposals.send'],
    kind: 'write',
    input: {
      proposalId: id('Proposal'),
      recipientEmail: z.string().email().describe("Client's email (see clients_get contacts or leads_get)"),
      message: z.string().max(2000).optional().describe('Personal note included in the email'),
    },
    run: ({ proposalId, ...rest }, { api }) => api.post(`/proposals/${seg(proposalId)}/send`, compact(rest)),
  }),

  defineTool({
    name: 'proposals_convert_to_agreement',
    title: 'Convert proposal to agreement',
    description:
      'Turns an ACCEPTED proposal into a draft agreement (sections, deliverables, terms and value carry over). If the proposal is for a lead, the lead is converted to a client first (needs leads.convert + clients.create). Returns agreementId — then review with agreements_get and send with agreements_send.',
    anyOf: ['proposals.convert'],
    allOf: ['agreements.create'],
    kind: 'write',
    input: { proposalId: id('Proposal') },
    run: ({ proposalId }, { api }) => api.post(`/proposals/${seg(proposalId)}/convert-to-agreement`),
  }),

  defineTool({
    name: 'proposals_delete',
    title: 'Delete a proposal',
    description:
      'Permanently deletes a proposal (any status except converted) and kills its review link. Find the id with proposals_list.',
    anyOf: ['proposals.delete'],
    kind: 'delete',
    input: { proposalId: id('Proposal') },
    run: ({ proposalId }, { api }) => api.delete(`/proposals/${seg(proposalId)}`),
  }),
];

// ============================================================================
//  AGREEMENTS
// ============================================================================
const agreementTermsInput = {
  sections: z
    .array(sectionInput)
    .optional()
    .describe('Contract sections in order (scope of work, deliverables, payment terms…). Replaces all sections.'),
  clauses: z.array(z.string()).optional().describe('Legal clauses, one per item. Replaces all clauses.'),
};

const agreementTools: SanctumTool[] = [
  defineTool({
    name: 'agreements_list',
    title: 'List agreements',
    description:
      'Lists agreements in the user\'s scope, newest first, optionally for one client and/or status. Money in paise (null without pricing access). Use agreements_get for terms.',
    anyOf: ['agreements.view'],
    kind: 'read',
    input: {
      clientId: z.string().min(1).optional().describe('From clients_list'),
      status: z.enum(AGREEMENT_STATUSES).optional(),
      limit,
    },
    run: async ({ clientId, status, limit: n }, { api }) => {
      const rows = await api.get<AgreementRow[]>('/agreements', { clientId });
      const filtered = status ? rows.filter((a) => a.status === status) : rows;
      return { total: filtered.length, agreements: take(filtered, n).map(agreementSummary) };
    },
  }),

  defineTool({
    name: 'agreements_get',
    title: 'Get agreement details',
    description:
      'Full agreement: terms (sections, clauses), values in paise, dates, status, signer details. Find the id with agreements_list.',
    anyOf: ['agreements.view'],
    kind: 'read',
    input: { agreementId: id('Agreement') },
    run: async ({ agreementId }, { api }) =>
      leanAgreement(await api.get<AgreementRow>(`/agreements/${seg(agreementId)}`)),
  }),

  defineTool({
    name: 'agreements_templates_list',
    title: 'List agreement templates',
    description: 'Saved agreement templates (MSA, retainer, SOW, NDA, custom). Pass templateId to agreements_create to start from one.',
    anyOf: ['agreements.view'],
    kind: 'read',
    input: {},
    run: (_args, { api }) => api.get('/agreements/templates'),
  }),

  defineTool({
    name: 'agreements_templates_create',
    title: 'Save an agreement template',
    description: 'Saves a reusable agreement template from sections and clauses.',
    anyOf: ['agreements.manage_templates'],
    kind: 'write',
    input: {
      name: z.string().trim().min(1).max(160),
      type: z.enum(AGREEMENT_TEMPLATE_TYPES).optional().describe("Default 'msa'"),
      description: z.string().trim().max(1000).optional(),
      ...agreementTermsInput,
    },
    run: ({ name, type, description, sections, clauses }, { api }) =>
      api.post(
        '/agreements/templates',
        compact({ name, type, description, terms: composeAgreementTerms({}, { sections, clauses }) }),
      ),
  }),

  defineTool({
    name: 'agreements_create',
    title: 'Create an agreement',
    description:
      'Creates a draft agreement (contract) for a client from sections and clauses. If retainerRupees is set and totalValueRupees is not, total = 12 × retainer (as in the portal). With templateId and no sections/clauses, the template terms are used. Nothing is sent — use agreements_send. To build one from an accepted proposal, use proposals_convert_to_agreement instead.',
    anyOf: ['agreements.create'],
    kind: 'write',
    input: {
      clientId: id('Client').describe('Client id (from clients_list)'),
      title: z.string().trim().min(1).max(200),
      proposalId: z.string().min(1).optional().describe('Related proposal (from proposals_list)'),
      projectId: z.string().min(1).optional().describe('Related project id'),
      templateId: z.string().min(1).optional().describe('From agreements_templates_list'),
      effectiveDate: isoDate('Effective date (default today)').optional(),
      expirationDate: isoDate('End / expiry date').optional(),
      retainerRupees: z.number().nonnegative().optional().describe('Monthly retainer in rupees'),
      totalValueRupees: z.number().nonnegative().optional().describe('Total contract value in rupees'),
      currency: z.string().trim().max(8).optional().describe('Default INR'),
      ...agreementTermsInput,
    },
    run: async (args, { api }) => {
      const { retainerRupees, totalValueRupees, sections, clauses, ...rest } = args;
      let base: Record<string, unknown> = {};
      if (rest.templateId && !sections && !clauses) {
        const templates = await api.get<AgreementTemplate[]>('/agreements/templates');
        base = { ...(templates.find((t) => t.id === rest.templateId)?.terms ?? {}) };
      }
      const total =
        totalValueRupees ?? (retainerRupees !== undefined ? retainerRupees * 12 : undefined);
      return api.post(
        '/agreements',
        compact({
          ...rest,
          retainerPaise: paise(retainerRupees),
          totalValuePaise: paise(total),
          terms: composeAgreementTerms(base, { sections, clauses }),
        }),
      );
    },
  }),

  defineTool({
    name: 'agreements_update',
    title: 'Update an agreement',
    description:
      'Edits an unsigned (draft/sent) agreement. Only what you pass changes; sections or clauses each replace that whole part (other terms are kept). Changing the client invalidates any signing link already sent. Signed agreements cannot be changed. Find the id with agreements_list.',
    anyOf: ['agreements.update'],
    kind: 'write',
    input: {
      agreementId: id('Agreement'),
      title: z.string().trim().min(1).max(200).optional(),
      clientId: z.string().min(1).optional().describe('From clients_list'),
      projectId: z.string().min(1).nullable().optional().describe('Related project id; null clears'),
      effectiveDate: isoDate('Effective date').optional(),
      expirationDate: isoDate('End / expiry date; null clears').nullable().optional(),
      retainerRupees: z.number().nonnegative().optional().describe('Monthly retainer in rupees'),
      totalValueRupees: z.number().nonnegative().optional().describe('Total contract value in rupees'),
      currency: z.string().trim().max(8).optional(),
      ...agreementTermsInput,
    },
    run: async (args, { api }) => {
      const { agreementId, retainerRupees, totalValueRupees, sections, clauses, ...rest } = args;
      let terms: Record<string, unknown> | undefined;
      if (sections || clauses) {
        const current = await api.get<AgreementRow>(`/agreements/${seg(agreementId)}`);
        terms = composeAgreementTerms(current.terms ?? {}, { sections, clauses });
      }
      const out = await api.put<AgreementRow>(
        `/agreements/${seg(agreementId)}`,
        compact({
          ...rest,
          retainerPaise: paise(retainerRupees),
          totalValuePaise: paise(totalValueRupees),
          terms,
        }),
      );
      return leanAgreement(out);
    },
  }),

  defineTool({
    name: 'agreements_send',
    title: 'Send an agreement for signature',
    description:
      'Emails the agreement to the recipient with a link to review and e-sign it (file-based agreements go via the client portal instead). Marks a draft as sent; earlier links stop working. Must be unsigned and not past its expiry date. Find the id with agreements_list.',
    anyOf: ['agreements.send'],
    kind: 'write',
    input: {
      agreementId: id('Agreement'),
      recipientEmail: z.string().email().describe("Signer's email (see clients_get contacts)"),
      message: z.string().max(2000).optional().describe('Personal note included in the email'),
    },
    run: ({ agreementId, ...rest }, { api }) => api.post(`/agreements/${seg(agreementId)}/send`, compact(rest)),
  }),

  defineTool({
    name: 'agreements_delete',
    title: 'Delete an agreement',
    description:
      'Permanently deletes a draft or sent (unsigned) agreement and kills its signing link. Signed/active agreements cannot be deleted. Find the id with agreements_list.',
    anyOf: ['agreements.delete'],
    kind: 'delete',
    input: { agreementId: id('Agreement') },
    run: ({ agreementId }, { api }) => api.delete(`/agreements/${seg(agreementId)}`),
  }),
];

export const crmTools: SanctumTool[] = [...clientTools, ...leadTools, ...proposalTools, ...agreementTools];
