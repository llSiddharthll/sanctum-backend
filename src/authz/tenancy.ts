/**
 * Tenant-binding helpers for input references (design §G.2 "Foreign keys in
 * input"). Every id a caller supplies must exist in the actor's agency.
 */
import { and, eq, inArray, type AnyColumn } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { notFound, badRequest } from '../lib/errors.js';

/** Throw 404 unless the row `id` exists in `table` for `agencyId`. */
export async function requireInAgency(
  table: SQLiteTable & { id: AnyColumn; agencyId: AnyColumn },
  agencyId: string,
  id: string,
  label = 'Resource',
): Promise<void> {
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.agencyId, agencyId)))
    .limit(1);
  if (!row) throw notFound(`${label} not found.`);
}

/**
 * Throw unless every user id is an ACTIVE STAFF user of the agency (assignees,
 * owners, members, participants). Client users are never valid here.
 */
export async function requireActiveStaff(agencyId: string, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.agencyId, agencyId),
        inArray(users.id, ids),
        eq(users.kind, 'staff'),
        eq(users.status, 'active'),
      ),
    );
  if (rows.length !== ids.length) throw badRequest('One or more people are not active team members.');
}

/** Storage keys / URLs must be under this agency's prefix. */
export function assertAgencyStorageKey(agencyId: string, keyOrUrl: string | null | undefined): void {
  if (!keyOrUrl) return;
  const needle = `sanctum/${agencyId}/`;
  if (!keyOrUrl.includes(needle)) {
    throw badRequest('That file does not belong to this workspace.');
  }
}
