/**
 * Client (brand) policy. Staff `assigned` = the actor is in client_assignments
 * for the client or is its account owner (clients.owner_id). Client-side actors
 * use the `client` scope (their own brand only).
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clientAssignments, clients } from '../../db/schema.js';
import { actorUserId, isClientSide, type Actor } from '../actor.js';
import type { ObjectFacts } from '../engine.js';

/** Client ids the actor is assigned to (assignment table ∪ account owner). */
export async function assignedClientIds(actor: Actor): Promise<string[]> {
  const uid = actorUserId(actor);
  if (!uid || isClientSide(actor)) return [];
  const rows = await db
    .select({ id: clientAssignments.clientId })
    .from(clientAssignments)
    .where(and(eq(clientAssignments.agencyId, actor.agencyId), eq(clientAssignments.userId, uid)));
  const owned = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.agencyId, actor.agencyId), eq(clients.ownerId, uid)));
  return [...new Set([...rows.map((r) => r.id), ...owned.map((r) => r.id)])];
}

export async function isAssignedToClient(actor: Actor, clientId: string): Promise<boolean> {
  const uid = actorUserId(actor);
  if (!uid || isClientSide(actor)) return false;
  const [a] = await db
    .select({ one: sql`1` })
    .from(clientAssignments)
    .where(
      and(
        eq(clientAssignments.agencyId, actor.agencyId),
        eq(clientAssignments.clientId, clientId),
        eq(clientAssignments.userId, uid),
      ),
    )
    .limit(1);
  if (a) return true;
  const [o] = await db
    .select({ one: sql`1` })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, actor.agencyId), eq(clients.ownerId, uid)))
    .limit(1);
  return !!o;
}

/** Facts for a client row (null when it doesn't exist in the actor's agency). */
export async function clientFacts(actor: Actor, clientId: string): Promise<ObjectFacts | null> {
  const [c] = await db
    .select({ id: clients.id, agencyId: clients.agencyId, ownerId: clients.ownerId })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, actor.agencyId)))
    .limit(1);
  if (!c) return null;
  return {
    agencyId: c.agencyId,
    clientId: c.id,
    assigned: await isAssignedToClient(actor, c.id),
  };
}

/**
 * SQL predicate restricting a `clientId` column to the clients the actor may
 * access for `permission` (organization → all in tenant; assigned → assigned
 * ids; client actors → their brand). Returns `sql\`0\`` when nothing is allowed.
 */
export async function clientScopeFilter(
  actor: Actor,
  permission: string,
  clientIdColumn: SQL | import('drizzle-orm').AnyColumn,
): Promise<SQL> {
  const scopes = actor.grants.scopes(permission);
  if (isClientSide(actor)) {
    return scopes.includes('client') ? sql`${clientIdColumn} = ${actor.clientId}` : sql`0`;
  }
  if (scopes.includes('organization')) return sql`1`;
  if (scopes.includes('assigned')) {
    const ids = await assignedClientIds(actor);
    return ids.length ? inArray(clientIdColumn as never, ids) : sql`0`;
  }
  return sql`0`;
}

