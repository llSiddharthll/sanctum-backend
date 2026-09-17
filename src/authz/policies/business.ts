/**
 * Business & finance policies: leads, proposals, agreements, invoices, expenses.
 *
 * Scopes (design §E.1):
 *   leads      own = ownerId
 *   proposals  own = createdBy     (client scope = the proposal's brand, non-draft)
 *   agreements own = createdBy     (client scope = the agreement's brand/project, non-draft)
 *   invoices   organization only for staff (client scope = brand/project, non-draft)
 *   expenses   own = loggedBy
 *
 * Also home of the object STATE guards (design §G.2) shared with the client
 * portal router, the public document-link lifecycle (hashed, expiring,
 * revocable links for one proposal/agreement) and money redaction helpers.
 */
import type { Request } from 'express';
import { and, eq, gt, inArray, isNull, sql, type SQL, type AnyColumn } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  agreements,
  clients,
  documentLinks,
  expenses,
  invoices,
  leads,
  proposals,
  users,
} from '../../db/schema.js';
import { AppError, gone, invalidState, notFound } from '../../lib/errors.js';
import { hashToken, newId, newOpaqueToken } from '../../lib/ids.js';
import {
  findClientLoginByEmail,
  mintClientPortalLogin,
  sendClientPortalLoginEmail,
} from '../../lib/client-portal-login.js';
import { audit } from '../../services/audit.js';
import { actorAuditId, actorUserId, isClientSide, type Actor } from '../actor.js';
import { authorize, check, type ObjectFacts } from '../engine.js';
import { usersWithPermission } from '../resolver.js';
import { clientFacts } from './clients.js';

type LeadRow = typeof leads.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;
type AgreementRow = typeof agreements.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;
type ExpenseRow = typeof expenses.$inferSelect;

// ------------------------------------------------------------------ facts

export function leadFactsOf(l: Pick<LeadRow, 'agencyId' | 'ownerId'>): ObjectFacts {
  return { agencyId: l.agencyId, ownerIds: [l.ownerId] };
}

export function proposalFactsOf(
  p: Pick<ProposalRow, 'agencyId' | 'createdBy' | 'clientId' | 'status'>,
): ObjectFacts {
  return {
    agencyId: p.agencyId,
    ownerIds: [p.createdBy],
    clientId: p.clientId,
    projectId: null,
    clientVisible: p.status !== 'draft',
  };
}

export function agreementFactsOf(
  a: Pick<AgreementRow, 'agencyId' | 'createdBy' | 'clientId' | 'projectId' | 'status'>,
): ObjectFacts {
  return {
    agencyId: a.agencyId,
    ownerIds: [a.createdBy],
    clientId: a.clientId,
    projectId: a.projectId,
    clientVisible: a.status !== 'draft',
  };
}

export function invoiceFactsOf(
  i: Pick<InvoiceRow, 'agencyId' | 'clientId' | 'projectId' | 'status'>,
): ObjectFacts {
  return {
    agencyId: i.agencyId,
    clientId: i.clientId,
    projectId: i.projectId,
    clientVisible: i.status !== 'draft',
  };
}

export function expenseFactsOf(e: Pick<ExpenseRow, 'agencyId' | 'loggedBy'>): ObjectFacts {
  return { agencyId: e.agencyId, ownerIds: [e.loggedBy] };
}

/** Load a lead in the actor's tenant (null → 404). */
export async function loadLead(actor: Actor, id: string): Promise<{ row: LeadRow; facts: ObjectFacts } | null> {
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, id), eq(leads.agencyId, actor.agencyId)))
    .limit(1);
  return row ? { row, facts: leadFactsOf(row) } : null;
}

export async function loadProposal(
  actor: Actor,
  id: string,
): Promise<{ row: ProposalRow; facts: ObjectFacts } | null> {
  const [row] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, id), eq(proposals.agencyId, actor.agencyId)))
    .limit(1);
  return row ? { row, facts: proposalFactsOf(row) } : null;
}

export async function loadAgreement(
  actor: Actor,
  id: string,
): Promise<{ row: AgreementRow; facts: ObjectFacts } | null> {
  const [row] = await db
    .select()
    .from(agreements)
    .where(and(eq(agreements.id, id), eq(agreements.agencyId, actor.agencyId)))
    .limit(1);
  return row ? { row, facts: agreementFactsOf(row) } : null;
}

export async function loadInvoice(
  actor: Actor,
  id: string,
): Promise<{ row: InvoiceRow; facts: ObjectFacts } | null> {
  const [row] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.agencyId, actor.agencyId)))
    .limit(1);
  return row ? { row, facts: invoiceFactsOf(row) } : null;
}

export async function loadExpense(
  actor: Actor,
  id: string,
): Promise<{ row: ExpenseRow; facts: ObjectFacts } | null> {
  const [row] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.agencyId, actor.agencyId)))
    .limit(1);
  return row ? { row, facts: expenseFactsOf(row) } : null;
}

// ------------------------------------------------------------ list filters

/**
 * SQL predicate for staff lists of `own`/`organization`-scoped resources:
 * organization → everything in the tenant; own → `ownerColumn = me`; else none.
 * (The tenant predicate is added by the caller.)
 */
export function ownScopeFilter(actor: Actor, permission: string, ownerColumn: AnyColumn): SQL {
  if (isClientSide(actor)) return sql`0`;
  const scopes = actor.grants.scopes(permission);
  if (scopes.includes('organization')) return sql`1`;
  const uid = actorUserId(actor);
  if (scopes.includes('own') && uid) return eq(ownerColumn, uid);
  return sql`0`;
}

/** Staff invoices are organization-scoped only. */
export function invoiceScopeFilter(actor: Actor, permission = 'invoices.view'): SQL {
  if (isClientSide(actor)) return sql`0`;
  return actor.grants.hasScope(permission, 'organization') ? sql`1` : sql`0`;
}

// ------------------------------------------------------------- state guards

const PROPOSAL_EDITABLE = new Set(['draft', 'sent', 'viewed', 'rejected']);
const PROPOSAL_SENDABLE = new Set(['draft', 'sent', 'viewed']);
const PROPOSAL_RESPONDABLE = new Set(['sent', 'viewed']);
const AGREEMENT_UNSIGNED = new Set(['draft', 'sent']);

/**
 * Staff edits: draft / sent (incl. viewed). A `rejected` (changes requested)
 * proposal may be revised — the update revives it to draft. Accepted, expired
 * and converted proposals are immutable.
 */
export function assertProposalEditable(p: Pick<ProposalRow, 'status'>): void {
  if (!PROPOSAL_EDITABLE.has(p.status)) {
    throw invalidState(`A ${p.status} proposal can no longer be edited.`);
  }
}

export function assertProposalSendable(p: Pick<ProposalRow, 'status' | 'validUntil'>, now = Date.now()): void {
  if (!PROPOSAL_SENDABLE.has(p.status)) {
    throw invalidState(`A ${p.status} proposal cannot be sent.`);
  }
  if (p.validUntil && p.validUntil.getTime() <= now) {
    throw invalidState('This proposal is past its valid-until date. Update it before sending.');
  }
}

/** Client accept/reject (public link or client portal): only sent/viewed and before validUntil. */
export function assertProposalRespondable(
  p: Pick<ProposalRow, 'status' | 'validUntil'>,
  now = Date.now(),
): void {
  if (!PROPOSAL_RESPONDABLE.has(p.status)) {
    throw invalidState(`This proposal is ${p.status} and can no longer be answered.`);
  }
  if (p.validUntil && p.validUntil.getTime() <= now) {
    throw invalidState('This proposal has expired.');
  }
}

/** Convert only an accepted proposal, and only once. */
export function assertProposalConvertible(
  p: Pick<ProposalRow, 'status' | 'convertedAgreementId'>,
): void {
  if (p.convertedAgreementId || p.status === 'converted') {
    throw new AppError('CONFLICT', 'This proposal has already been converted to an agreement.', {
      agreementId: p.convertedAgreementId,
    });
  }
  if (p.status !== 'accepted') {
    throw invalidState('Only an accepted proposal can be converted to an agreement.');
  }
}

/** Staff update/delete/send: only unsigned (draft/sent) agreements. */
export function assertAgreementUnsigned(a: Pick<AgreementRow, 'status'>): void {
  if (!AGREEMENT_UNSIGNED.has(a.status)) {
    throw invalidState(`This agreement is ${a.status} and can no longer be changed.`);
  }
}

/** Client signature (public link or client portal): only sent, once, before expiry. */
export function assertAgreementSignable(
  a: Pick<AgreementRow, 'status' | 'signedAt' | 'expirationDate'>,
  now = Date.now(),
): void {
  if (a.signedAt || a.status === 'signed' || a.status === 'active') {
    throw invalidState('This agreement has already been signed.');
  }
  if (a.status !== 'sent') {
    throw invalidState(`This agreement is ${a.status} and cannot be signed.`);
  }
  if (a.expirationDate && a.expirationDate.getTime() <= now) {
    throw invalidState('This agreement has expired.');
  }
}

/** A signature image must be a small PNG/JPEG data URL (never a remote/javascript URL). */
export function assertSignatureDataUrl(v: string): void {
  if (v.length > 700_000 || !/^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=\s]+$/.test(v)) {
    throw new AppError('VALIDATION_ERROR', 'Signature must be a PNG or JPEG image.');
  }
}

export function assertInvoiceEditable(i: Pick<InvoiceRow, 'status'>): void {
  if (i.status === 'paid' || i.status === 'cancelled') {
    throw invalidState(`A ${i.status} invoice cannot be edited.`);
  }
}

export type InvoiceStatus = InvoiceRow['status'];

/**
 * Explicit invoice status machine for PATCH /invoices/:id/status.
 * Returns null when allowed, or the reason it is not.
 *   draft          → sent, cancelled
 *   sent           → draft (no payments), cancelled (no payments), paid (settled or override)
 *   partially_paid → paid (settled or override)
 *   paid           → (terminal)
 *   cancelled      → (terminal: no un-cancel)
 */
export function invoiceTransitionError(input: {
  from: InvoiceStatus;
  to: 'draft' | 'sent' | 'paid' | 'cancelled';
  paid: number;
  total: number;
  override: boolean;
}): string | null {
  const { from, to, paid, total, override } = input;
  if (from === to) return null;
  if (from === 'cancelled') return 'A cancelled invoice cannot be reopened.';
  if (from === 'paid') return 'A paid invoice cannot change status.';
  switch (to) {
    case 'sent':
      return from === 'draft' ? null : `Cannot move a ${from} invoice back to sent.`;
    case 'draft':
      if (from !== 'sent') return `Cannot move a ${from} invoice back to draft.`;
      return paid > 0 ? 'An invoice with payments cannot go back to draft.' : null;
    case 'cancelled':
      return paid > 0 ? 'An invoice with recorded payments cannot be cancelled.' : null;
    case 'paid':
      if (from === 'draft') return 'Send the invoice before marking it paid.';
      if (paid >= total || override) return null;
      return 'Payments do not cover the total. Record the payment, or mark paid with override.';
  }
}

// -------------------------------------------------------- money redaction

/** Words (camelCase / snake_case tokens of a JSON key) that denote money. */
const MONEY_WORDS = new Set([
  'paise', 'rupees', 'price', 'prices', 'pricing', 'amount', 'amounts', 'budget', 'subtotal',
  'total', 'tax', 'fee', 'fees', 'cost', 'costs', 'rate', 'rates', 'retainer', 'investment',
  'roi', 'spend',
]);
const MONEY_KEY_EXEMPT = new Set(['gstRate', 'gst_rate']);
const MONEY_HEADING = /\b(investment|pricing|prices?|fees?|costs?|budget|payments?|commercials?|retainer|roi)\b/i;

function isMoneyKey(k: string): boolean {
  if (MONEY_KEY_EXEMPT.has(k)) return false;
  const words = k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .map((w) => w.toLowerCase());
  return words.some((w) => MONEY_WORDS.has(w));
}

function isMoneySection(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const heading = o.heading ?? o.title ?? o.name;
  return typeof heading === 'string' && MONEY_HEADING.test(heading);
}

/** Deep copy of structured proposal content / agreement terms with money removed. */
export function redactMoney(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !isMoneySection(x)).map(redactMoney);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (isMoneyKey(k)) continue;
      out[k] = redactMoney(val);
    }
    return out;
  }
  return v;
}

/** True when structured content carries money (keys or pricing sections). */
export function containsMoney(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => isMoneySection(x) || containsMoney(x));
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).some(
      ([k, val]) => (isMoneyKey(k) && val !== null && val !== undefined && val !== '') || containsMoney(val),
    );
  }
  return false;
}

// ---------------------------------------------------- public document links

export type DocumentObjectType = 'proposal' | 'agreement';
const DEFAULT_LINK_DAYS = 30;

export function defaultLinkExpiry(explicit: Date | null | undefined, now = Date.now()): Date {
  if (explicit && explicit.getTime() > now) return explicit;
  return new Date(now + DEFAULT_LINK_DAYS * 86_400_000);
}

/** Revoke every live link for an object (resend, terminal status, delete). */
export async function revokeDocumentLinks(
  agencyId: string,
  objectType: DocumentObjectType,
  objectId: string,
): Promise<void> {
  await db
    .update(documentLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(documentLinks.agencyId, agencyId),
        eq(documentLinks.objectType, objectType),
        eq(documentLinks.objectId, objectId),
        isNull(documentLinks.revokedAt),
      ),
    );
}

/** Mint a fresh link (revoking earlier ones). Returns the raw token — shown once, in the email. */
export async function mintDocumentLink(input: {
  agencyId: string;
  objectType: DocumentObjectType;
  objectId: string;
  expiresAt: Date;
  createdBy: string | null;
}): Promise<{ raw: string; id: string; expiresAt: Date }> {
  await revokeDocumentLinks(input.agencyId, input.objectType, input.objectId);
  const { raw, hash } = newOpaqueToken();
  const id = newId('dln');
  await db.insert(documentLinks).values({
    id,
    agencyId: input.agencyId,
    objectType: input.objectType,
    objectId: input.objectId,
    tokenHash: hash,
    expiresAt: input.expiresAt,
    createdBy: input.createdBy,
  });
  return { raw, id, expiresAt: input.expiresAt };
}

/** Active (unrevoked, unexpired) link summary for staff responses — never the token. */
export async function activeLinkExpiry(
  agencyId: string,
  objectType: DocumentObjectType,
  objectId: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ expiresAt: documentLinks.expiresAt })
    .from(documentLinks)
    .where(
      and(
        eq(documentLinks.agencyId, agencyId),
        eq(documentLinks.objectType, objectType),
        eq(documentLinks.objectId, objectId),
        isNull(documentLinks.revokedAt),
        gt(documentLinks.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row?.expiresAt ?? null;
}

export type DocumentLinkRow = typeof documentLinks.$inferSelect;

function assertLinkUsable(link: DocumentLinkRow): void {
  if (link.revokedAt) throw gone('This link is no longer valid.');
  if (link.expiresAt.getTime() <= Date.now()) throw gone('This link has expired.');
}

/**
 * Resolve a presented proposal token. Lazy one-time migration: a legacy
 * plaintext `proposals.token` with no link rows becomes a hashed link row and
 * the plaintext column is cleared.
 */
export async function resolveProposalLink(raw: string): Promise<{ link: DocumentLinkRow; row: ProposalRow }> {
  const hash = hashToken(raw);
  let [link] = await db
    .select()
    .from(documentLinks)
    .where(and(eq(documentLinks.tokenHash, hash), eq(documentLinks.objectType, 'proposal')))
    .limit(1);
  if (!link) {
    const [legacy] = await db.select().from(proposals).where(eq(proposals.token, raw)).limit(1);
    if (!legacy) throw notFound('Proposal not found or link has expired.');
    const migrated = await migrateLegacyLink('proposal', legacy.agencyId, legacy.id, hash, legacy.validUntil, legacy.createdBy);
    await db.update(proposals).set({ token: null }).where(eq(proposals.id, legacy.id));
    if (!migrated) throw notFound('Proposal not found or link has expired.');
    link = migrated;
  }
  assertLinkUsable(link);
  const [row] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, link.objectId), eq(proposals.agencyId, link.agencyId)))
    .limit(1);
  if (!row || row.status === 'draft') throw notFound('Proposal not found or link has expired.');
  return { link, row };
}

export async function resolveAgreementLink(raw: string): Promise<{ link: DocumentLinkRow; row: AgreementRow }> {
  const hash = hashToken(raw);
  let [link] = await db
    .select()
    .from(documentLinks)
    .where(and(eq(documentLinks.tokenHash, hash), eq(documentLinks.objectType, 'agreement')))
    .limit(1);
  if (!link) {
    const [legacy] = await db.select().from(agreements).where(eq(agreements.token, raw)).limit(1);
    if (!legacy) throw notFound('Agreement not found or link has expired.');
    const migrated = await migrateLegacyLink('agreement', legacy.agencyId, legacy.id, hash, legacy.expirationDate, legacy.createdBy);
    await db.update(agreements).set({ token: null }).where(eq(agreements.id, legacy.id));
    if (!migrated) throw notFound('Agreement not found or link has expired.');
    link = migrated;
  }
  assertLinkUsable(link);
  const [row] = await db
    .select()
    .from(agreements)
    .where(and(eq(agreements.id, link.objectId), eq(agreements.agencyId, link.agencyId)))
    .limit(1);
  if (!row || !['sent', 'signed', 'active'].includes(row.status)) {
    throw notFound('Agreement not found or link has expired.');
  }
  return { link, row };
}

/** Create the hashed link row for a legacy plaintext token, unless the object already has link rows. */
async function migrateLegacyLink(
  objectType: DocumentObjectType,
  agencyId: string,
  objectId: string,
  hash: string,
  explicitExpiry: Date | null,
  createdBy: string | null,
): Promise<DocumentLinkRow | null> {
  const [existing] = await db
    .select({ id: documentLinks.id })
    .from(documentLinks)
    .where(
      and(
        eq(documentLinks.agencyId, agencyId),
        eq(documentLinks.objectType, objectType),
        eq(documentLinks.objectId, objectId),
      ),
    )
    .limit(1);
  if (existing) return null; // a newer link superseded the legacy one
  const id = newId('dln');
  const row = {
    id,
    agencyId,
    objectType,
    objectId,
    tokenHash: hash,
    // Legacy links honour the document's own expiry, else 30 days from now.
    expiresAt: explicitExpiry ?? new Date(Date.now() + DEFAULT_LINK_DAYS * 86_400_000),
    createdBy,
  };
  await db.insert(documentLinks).values(row);
  const [inserted] = await db.select().from(documentLinks).where(eq(documentLinks.id, id)).limit(1);
  return inserted ?? null;
}

/** Mark a link used (accept / reject / sign). Returns false if it was already consumed. */
export async function consumeDocumentLink(linkId: string): Promise<boolean> {
  const res = await db
    .update(documentLinks)
    .set({ consumedAt: new Date() })
    .where(and(eq(documentLinks.id, linkId), isNull(documentLinks.consumedAt)))
    .returning({ id: documentLinks.id });
  return res.length > 0;
}

// ------------------------------------------------------------ notifications

/**
 * Staff who can see an object governed by an own/organization permission:
 * organization-scope holders, plus the object's owner if they hold `own`.
 */
export async function objectViewerIds(
  agencyId: string,
  permission: string,
  ownerId: string | null | undefined,
): Promise<string[]> {
  const org = await usersWithPermission(agencyId, permission, { scope: 'organization' });
  const ids = new Set(org);
  if (ownerId && !ids.has(ownerId)) {
    const own = await usersWithPermission(agencyId, permission, { scope: 'own' });
    if (own.includes(ownerId)) ids.add(ownerId);
  }
  return [...ids];
}

// ------------------------------------------------------------------ misc

/** Money-field visibility for one object. */
export function canSee(actor: Actor, permission: string, facts: ObjectFacts): boolean {
  return check(actor, permission, facts);
}

/** Minimal HTML escaping for user text interpolated into outbound email HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Name lookup restricted to the tenant (avoids cross-tenant name leaks). */
export async function staffNames(agencyId: string, ids: Array<string | null | undefined>): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string | null>();
  if (!uniq.length) return out;
  const rows = await db
    .select({ id: users.id, name: users.fullName })
    .from(users)
    .where(and(eq(users.agencyId, agencyId), inArray(users.id, uniq)));
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

// ------------------------------------------------- send → portal access

/**
 * Document/invoice "send" that delivers access through the client portal.
 *  - The brand already has a login for `recipientEmail` → nothing about that
 *    account changes; the recipient is told to sign in with their password.
 *  - Otherwise a NEW login is created (never overwriting another account),
 *    which additionally requires `clients.manage_portal` on the client.
 */
export async function deliverViaPortalLogin(input: {
  actor: Actor;
  req: Request;
  clientId: string;
  recipientEmail: string;
  agencyName: string;
  note: string;
}): Promise<{ created: boolean; email: string }> {
  const { actor, req } = input;
  const [client] = await db
    .select({ id: clients.id, name: clients.name, contactEmail: clients.contactEmail })
    .from(clients)
    .where(and(eq(clients.id, input.clientId), eq(clients.agencyId, actor.agencyId)))
    .limit(1);
  if (!client) throw notFound('Client not found.');

  const existing = await findClientLoginByEmail(actor.agencyId, client.id, input.recipientEmail);
  if (existing) {
    if (existing.status !== 'active') {
      throw invalidState('That client portal login is disabled. Re-enable it before sending.');
    }
    await sendClientPortalLoginEmail({
      req,
      agencyName: input.agencyName,
      clientName: client.name,
      to: existing.email,
      email: existing.email,
      note: input.note,
    });
    return { created: false, email: existing.email };
  }

  authorize(actor, 'clients.manage_portal', await clientFacts(actor, client.id), {
    view: 'clients.view',
    message: "Sending creates a client portal login, which needs permission to manage this client's portal.",
  });
  const login = await mintClientPortalLogin({
    agencyId: actor.agencyId,
    clientId: client.id,
    clientName: client.name,
    clientContactEmail: client.contactEmail,
    email: input.recipientEmail,
    req,
  });
  await sendClientPortalLoginEmail({
    req,
    agencyName: input.agencyName,
    clientName: client.name,
    to: login.email,
    email: login.email,
    password: login.password,
    note: input.note,
  });
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: login.created ? 'client_user.create_via_send' : 'client_user.notify_via_send',
    entityType: 'client_user',
    entityId: login.userId,
    metadata: { clientId: client.id, email: login.email },
    ip: req.ip,
  });
  return { created: login.created, email: login.email };
}
