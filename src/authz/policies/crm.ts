/**
 * CRM policy: contacts, notes (activities), deals and tags. Every CRM child
 * object inherits the scope of its client (staff `assigned` = assigned to the
 * client or its account owner, see policies/clients.ts). Notes add `own`
 * (author) for update/delete.
 *
 * Facts loaders return null (→ 404) when the object is not in the actor's
 * agency OR, when a URL parent is given, does not belong to that client.
 */
import { and, eq, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clientContacts, clientNotes, clientTags, deals } from '../../db/schema.js';
import type { Actor } from '../actor.js';
import type { ObjectFacts } from '../engine.js';
import { assignedClientIds, clientScopeFilter, isAssignedToClient } from './clients.js';

export interface ChildFacts<Row> {
  row: Row;
  facts: ObjectFacts;
}

function bound(rowClientId: string, urlClientId: string | undefined): boolean {
  return urlClientId === undefined || urlClientId === rowClientId;
}

async function childFacts(
  actor: Actor,
  clientId: string,
  ownerIds?: Array<string | null>,
): Promise<ObjectFacts> {
  return {
    agencyId: actor.agencyId,
    clientId,
    assigned: await isAssignedToClient(actor, clientId),
    ...(ownerIds ? { ownerIds } : {}),
  };
}

export async function contactFacts(
  actor: Actor,
  contactId: string,
  urlClientId?: string,
): Promise<ChildFacts<typeof clientContacts.$inferSelect> | null> {
  const [row] = await db
    .select()
    .from(clientContacts)
    .where(and(eq(clientContacts.id, contactId), eq(clientContacts.agencyId, actor.agencyId)))
    .limit(1);
  if (!row || !bound(row.clientId, urlClientId)) return null;
  return { row, facts: await childFacts(actor, row.clientId) };
}

/** Notes: `own` = author. */
export async function noteFacts(
  actor: Actor,
  noteId: string,
  urlClientId?: string,
): Promise<ChildFacts<typeof clientNotes.$inferSelect> | null> {
  const [row] = await db
    .select()
    .from(clientNotes)
    .where(and(eq(clientNotes.id, noteId), eq(clientNotes.agencyId, actor.agencyId)))
    .limit(1);
  if (!row || !bound(row.clientId, urlClientId)) return null;
  return { row, facts: await childFacts(actor, row.clientId, [row.authorId]) };
}

export async function dealFacts(
  actor: Actor,
  dealId: string,
  urlClientId?: string,
): Promise<ChildFacts<typeof deals.$inferSelect> | null> {
  const [row] = await db
    .select()
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.agencyId, actor.agencyId)))
    .limit(1);
  if (!row || !bound(row.clientId, urlClientId)) return null;
  return { row, facts: await childFacts(actor, row.clientId) };
}

/** Tag definitions are agency-level (organization only). */
export async function tagFacts(
  actor: Actor,
  tagId: string,
): Promise<ChildFacts<typeof clientTags.$inferSelect> | null> {
  const [row] = await db
    .select()
    .from(clientTags)
    .where(and(eq(clientTags.id, tagId), eq(clientTags.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) return null;
  return { row, facts: { agencyId: row.agencyId } };
}

/**
 * Facts builder for list rows: loads the actor's assigned client ids ONCE and
 * returns a sync function producing per-row facts (for field redaction and
 * capabilities without a query per row).
 */
export async function clientRowFactsBuilder(
  actor: Actor,
): Promise<(clientId: string, ownerIds?: Array<string | null>) => ObjectFacts> {
  const assigned = new Set(await assignedClientIds(actor));
  return (clientId, ownerIds) => ({
    agencyId: actor.agencyId,
    clientId,
    assigned: assigned.has(clientId),
    ...(ownerIds ? { ownerIds } : {}),
  });
}

/** SQL scope filters for CRM lists (tenant predicate is added by callers). */
export function dealScopeFilter(actor: Actor, permission = 'deals.view'): Promise<SQL> {
  return clientScopeFilter(actor, permission, deals.clientId as AnyColumn);
}

export function contactScopeFilter(actor: Actor, permission = 'clients.view'): Promise<SQL> {
  return clientScopeFilter(actor, permission, clientContacts.clientId as AnyColumn);
}

export function noteScopeFilter(actor: Actor, permission = 'clients.view'): Promise<SQL> {
  return clientScopeFilter(actor, permission, clientNotes.clientId as AnyColumn);
}
