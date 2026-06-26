/**
 * In-app notifications: persist to Turso (source of truth) and push live over
 * Socket.IO to the recipient's user room. Delivery is best-effort; the bell
 * also polls REST so a sleeping socket never loses a notification.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { broadcastNotification } from '../realtime/io.js';
import { toIso } from '../lib/http.js';

export interface NotifyInput {
  agencyId: string;
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  link?: string | null;
}

function serialize(row: typeof notifications.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    entityType: row.entityType,
    entityId: row.entityId,
    link: row.link,
    readAt: toIso(row.readAt),
    createdAt: toIso(row.createdAt),
  };
}

export async function notify(input: NotifyInput): Promise<void> {
  const id = newId('ntf');
  const createdAt = new Date();
  await db.insert(notifications).values({
    id,
    agencyId: input.agencyId,
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    link: input.link ?? null,
    createdAt,
  });
  broadcastNotification(input.userId, {
    id,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    link: input.link ?? null,
    readAt: null,
    createdAt: createdAt.toISOString(),
  });
}

/** Fan a notification out to many recipients. */
export async function notifyMany(
  userIds: string[],
  base: Omit<NotifyInput, 'userId'>,
): Promise<void> {
  await Promise.all(userIds.map((userId) => notify({ ...base, userId })));
}

/** Active owners/admins of an agency (recipients of approval requests). */
export async function agencyApprovers(
  agencyId: string,
  excludeUserId?: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.agencyId, agencyId),
        inArray(users.role, ['owner', 'admin']),
        eq(users.status, 'active'),
        excludeUserId ? ne(users.id, excludeUserId) : undefined,
      ),
    );
  return rows.map((r) => r.id);
}

export { serialize as serializeNotification };
