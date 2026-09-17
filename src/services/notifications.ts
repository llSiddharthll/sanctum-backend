/**
 * In-app notifications: persist to Turso (source of truth) and push live over
 * Socket.IO to the recipient's user room. Delivery is best-effort; the bell
 * also polls REST so a sleeping socket never loses a notification.
 */
import { db } from '../db/client.js';
import { usersWithPermission } from '../authz/resolver.js';
import { notifications } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { broadcastNotification } from '../realtime/io.js';
import { sendPushToUser } from './push-send.js';
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

  // Device push (best-effort, fire-and-forget) so users are alerted even when
  // the app is closed. Every notification type flows through here.
  void sendPushToUser(input.userId, {
    title: input.title,
    body: input.body ?? undefined,
    data: {
      type: input.type,
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      ...(input.link ? { link: input.link } : {}),
    },
  });
}

/** Fan a notification out to many recipients. */
export async function notifyMany(
  userIds: string[],
  base: Omit<NotifyInput, 'userId'>,
): Promise<void> {
  await Promise.all(userIds.map((userId) => notify({ ...base, userId })));
}

/**
 * Recipients by CAPABILITY: active staff holding `permission` (e.g. the people
 * who can approve leave get leave requests). Replaces role-based recipient lists.
 */
export async function notifyPermissionHolders(
  agencyId: string,
  permission: string,
  base: Omit<NotifyInput, 'userId'>,
  opts: { excludeUserId?: string } = {},
): Promise<void> {
  const ids = await usersWithPermission(agencyId, permission, opts);
  await notifyMany(ids, base);
}

export { usersWithPermission };

/**
 * @deprecated TODO(authz): call sites must use notifyPermissionHolders with the
 * specific permission. Temporary capability-based stand-in for the old
 * owner/admin role query.
 */
export async function agencyApprovers(agencyId: string, excludeUserId?: string): Promise<string[]> {
  const perms = ['leaves.approve', 'regularizations.approve', 'checkout_requests.approve', 'posts.publish'];
  const sets = await Promise.all(perms.map((p) => usersWithPermission(agencyId, p, { excludeUserId })));
  return [...new Set(sets.flat())];
}

/** @deprecated TODO(authz): use notifyPermissionHolders(agencyId, '<business permission>', …). */
export async function agencyOwners(agencyId: string): Promise<string[]> {
  return usersWithPermission(agencyId, 'proposals.view');
}

export { serialize as serializeNotification };
