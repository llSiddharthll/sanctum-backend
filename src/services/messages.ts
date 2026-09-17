import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  messages,
  messageThreads,
  projects,
  threadParticipants,
  users,
} from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { toIso } from '../lib/http.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { requireActiveStaff } from '../authz/tenancy.js';
import {
  getIo,
  userRoom,
  broadcastNewMessage,
  broadcastThreadCreated,
  broadcastThreadRead,
  broadcastThreadUpdate,
  broadcastMessageUpdated,
  broadcastMessageDeleted,
} from '../realtime/io.js';
import { notify } from './notifications.js';

/**
 * Messaging service. AUTHORIZATION LIVES IN THE CALLER (routes/messages.ts,
 * realtime/socket.ts): every function here receives already-authorized ids.
 * `createMessage` / `markRead` keep a participation guard because they act on
 * the caller's own participant row (and are shared with realtime).
 */
const PREVIEW_MAX = 140;

export interface MessageAttachment {
  url: string;
  type: 'image' | 'file';
  name: string;
  mime?: string | null;
  bytes?: number | null;
}

/** Parse the stored attachments JSON into a safe array. */
function parseAttachments(raw: string | null | undefined): MessageAttachment[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((a) => a && typeof a.url === 'string')
      .map((a) => ({
        url: String(a.url),
        type: a.type === 'image' ? 'image' : 'file',
        name: typeof a.name === 'string' ? a.name : 'file',
        mime: a.mime ?? null,
        bytes: typeof a.bytes === 'number' ? a.bytes : null,
      }));
  } catch {
    return [];
  }
}

function preview(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > PREVIEW_MAX
    ? `${trimmed.slice(0, PREVIEW_MAX - 1)}…`
    : trimmed;
}

// ============================================================
//  Serialized shapes (the live + REST contract)
// ============================================================
export interface SerializedParticipant {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface ThreadSummary {
  id: string;
  subject: string;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  projectName: string | null;
  status: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdBy: string | null;
  createdAt: string | null;
  participants: SerializedParticipant[];
  unreadCount: number;
  /** Per-viewer capabilities (REST responses only; absent in broadcasts). */
  capabilities?: Record<string, boolean>;
}

export interface SerializedMessage {
  id: string;
  threadId: string;
  senderId: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  body: string;
  attachments: MessageAttachment[];
  createdAt: string | null;
  editedAt: string | null;
  /** Set when this message is pinned to the client's overview. */
  pinnedAt: string | null;
  pinnedBy: string | null;
  /** Per-viewer capabilities (REST responses only; absent in broadcasts). */
  capabilities?: Record<string, boolean>;
}

// ============================================================
//  Internal helpers
// ============================================================

/** The participant row for {thread,user} scoped to the agency, or undefined. */
async function getParticipant(
  agencyId: string,
  userId: string,
  threadId: string,
) {
  const [row] = await db
    .select()
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.agencyId, agencyId),
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
      ),
    )
    .limit(1);
  return row;
}

/** Throw 404 if the thread isn't in this agency; 403 if user isn't a member. */
async function requireParticipant(
  agencyId: string,
  userId: string,
  threadId: string,
) {
  const [thread] = await db
    .select()
    .from(messageThreads)
    .where(
      and(
        eq(messageThreads.id, threadId),
        eq(messageThreads.agencyId, agencyId),
      ),
    )
    .limit(1);
  if (!thread) throw notFound('Thread not found.');

  const part = await getParticipant(agencyId, userId, threadId);
  if (!part) throw forbidden('You are not a participant of this thread.');
  return { thread, part };
}

/** All user ids participating in a thread (for fan-out to user rooms). */
async function participantUserIds(
  agencyId: string,
  threadId: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: threadParticipants.userId })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.agencyId, agencyId),
        eq(threadParticipants.threadId, threadId),
      ),
    );
  return rows.map((r) => r.userId);
}

/** Resolve participants (with display info) for a set of thread ids. */
async function participantsByThread(
  agencyId: string,
  threadIds: string[],
): Promise<Map<string, SerializedParticipant[]>> {
  const map = new Map<string, SerializedParticipant[]>();
  if (threadIds.length === 0) return map;

  const rows = await db
    .select({
      threadId: threadParticipants.threadId,
      userId: threadParticipants.userId,
      name: users.fullName,
    })
    .from(threadParticipants)
    .leftJoin(users, eq(users.id, threadParticipants.userId))
    .where(
      and(
        eq(threadParticipants.agencyId, agencyId),
        inArray(threadParticipants.threadId, threadIds),
      ),
    )
    .orderBy(asc(threadParticipants.createdAt));

  for (const r of rows) {
    const list = map.get(r.threadId) ?? [];
    // No avatar column on users today — kept in the contract as null.
    list.push({ userId: r.userId, name: r.name ?? null, avatarUrl: null });
    map.set(r.threadId, list);
  }
  return map;
}

/** Build a single thread summary for a given viewer (computes unreadCount). */
async function buildSummary(
  agencyId: string,
  userId: string,
  threadId: string,
): Promise<ThreadSummary> {
  const [row] = await db
    .select({
      id: messageThreads.id,
      subject: messageThreads.subject,
      clientId: messageThreads.clientId,
      projectId: messageThreads.projectId,
      status: messageThreads.status,
      lastMessageAt: messageThreads.lastMessageAt,
      lastMessagePreview: messageThreads.lastMessagePreview,
      createdBy: messageThreads.createdBy,
      createdAt: messageThreads.createdAt,
      clientName: clients.name,
      projectName: projects.name,
    })
    .from(messageThreads)
    .leftJoin(clients, eq(clients.id, messageThreads.clientId))
    .leftJoin(projects, eq(projects.id, messageThreads.projectId))
    .where(
      and(
        eq(messageThreads.id, threadId),
        eq(messageThreads.agencyId, agencyId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Thread not found.');

  const partsMap = await participantsByThread(agencyId, [threadId]);
  const part = await getParticipant(agencyId, userId, threadId);
  const unreadCount = await countUnread(
    agencyId,
    userId,
    threadId,
    part?.lastReadAt ?? null,
  );

  return {
    id: row.id,
    subject: row.subject,
    clientId: row.clientId,
    clientName: row.clientName ?? null,
    projectId: row.projectId,
    projectName: row.projectName ?? null,
    status: row.status,
    lastMessageAt: toIso(row.lastMessageAt),
    lastMessagePreview: row.lastMessagePreview,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    participants: partsMap.get(threadId) ?? [],
    unreadCount,
  };
}

/** Count messages in a thread newer than lastReadAt not sent by the viewer. */
async function countUnread(
  agencyId: string,
  userId: string,
  threadId: string,
  lastReadAt: Date | null,
): Promise<number> {
  const filters = [
    eq(messages.agencyId, agencyId),
    eq(messages.threadId, threadId),
    ne(messages.senderId, userId),
  ];
  if (lastReadAt) filters.push(gt(messages.createdAt, lastReadAt));

  const [r] = await db
    .select({ c: sql<number>`count(*)` })
    .from(messages)
    .where(and(...filters));
  return Number(r?.c ?? 0);
}

function serializeMessageRow(row: {
  id: string;
  threadId: string;
  senderId: string | null;
  body: string;
  attachmentsJson?: string | null;
  createdAt: Date | null;
  editedAt: Date | null;
  senderName: string | null;
  pinnedAt?: Date | null;
  pinnedBy?: string | null;
}): SerializedMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    senderId: row.senderId,
    senderName: row.senderName ?? null,
    senderAvatarUrl: null,
    body: row.body,
    attachments: parseAttachments(row.attachmentsJson),
    createdAt: toIso(row.createdAt),
    editedAt: toIso(row.editedAt),
    pinnedAt: toIso(row.pinnedAt ?? null),
    pinnedBy: row.pinnedBy ?? null,
  };
}

// ============================================================
//  Public service API
// ============================================================

export interface ListThreadsOptions {
  status?: 'open' | 'awaiting' | 'closed';
  search?: string;
  clientId?: string;
  /**
   * true = every thread in the agency (caller verified organization-scope
   * `messages.view`); default = only threads the user participates in.
   */
  all?: boolean;
}

/** Threads for a viewer, newest activity first, with unread counts. */
export async function listThreads(
  agencyId: string,
  userId: string,
  opts: ListThreadsOptions = {},
): Promise<ThreadSummary[]> {
  const filters = [eq(messageThreads.agencyId, agencyId)];
  if (!opts.all) filters.push(eq(threadParticipants.userId, userId));
  if (opts.status) filters.push(eq(messageThreads.status, opts.status));
  if (opts.clientId) filters.push(eq(messageThreads.clientId, opts.clientId));
  if (opts.search && opts.search.trim()) {
    filters.push(
      sql`lower(${messageThreads.subject}) like ${'%' + opts.search.trim().toLowerCase() + '%'}`,
    );
  }

  const rows = await db
    .select({
      id: messageThreads.id,
      subject: messageThreads.subject,
      clientId: messageThreads.clientId,
      projectId: messageThreads.projectId,
      status: messageThreads.status,
      lastMessageAt: messageThreads.lastMessageAt,
      lastMessagePreview: messageThreads.lastMessagePreview,
      createdBy: messageThreads.createdBy,
      createdAt: messageThreads.createdAt,
      lastReadAt: threadParticipants.lastReadAt,
      clientName: clients.name,
      projectName: projects.name,
    })
    .from(messageThreads)
    .leftJoin(
      threadParticipants,
      and(
        eq(threadParticipants.threadId, messageThreads.id),
        eq(threadParticipants.userId, userId),
      ),
    )
    .leftJoin(clients, eq(clients.id, messageThreads.clientId))
    .leftJoin(projects, eq(projects.id, messageThreads.projectId))
    .where(and(...filters))
    .orderBy(desc(messageThreads.lastMessageAt));

  const threadIds = rows.map((r) => r.id);
  const partsMap = await participantsByThread(agencyId, threadIds);

  const summaries: ThreadSummary[] = [];
  for (const r of rows) {
    const unreadCount = await countUnread(
      agencyId,
      userId,
      r.id,
      r.lastReadAt ?? null,
    );
    summaries.push({
      id: r.id,
      subject: r.subject,
      clientId: r.clientId,
      clientName: r.clientName ?? null,
      projectId: r.projectId,
      projectName: r.projectName ?? null,
      status: r.status,
      lastMessageAt: toIso(r.lastMessageAt),
      lastMessagePreview: r.lastMessagePreview,
      createdBy: r.createdBy,
      createdAt: toIso(r.createdAt),
      participants: partsMap.get(r.id) ?? [],
      unreadCount,
    });
  }
  return summaries;
}

/** Full thread summary for one viewer (caller authorized `messages.view`). */
export async function getThread(
  agencyId: string,
  userId: string,
  threadId: string,
): Promise<ThreadSummary> {
  return buildSummary(agencyId, userId, threadId);
}

export interface CreateThreadInput {
  subject: string;
  participantIds: string[];
  clientId?: string | null;
  projectId?: string | null;
  body?: string | null;
}

/**
 * Create a thread (+ participants, optional first message) and broadcast.
 * Caller authorized `threads.create` and any client/project link.
 */
export async function createThread(
  agencyId: string,
  creatorId: string,
  input: CreateThreadInput,
): Promise<ThreadSummary> {
  const subject = input.subject.trim();
  if (!subject) throw badRequest('Subject is required.');

  // Creator is always included, de-duped against the requested list.
  const ids = Array.from(
    new Set([creatorId, ...input.participantIds.filter(Boolean)]),
  );
  // Participants are active staff only (never client users / disabled users).
  await requireActiveStaff(agencyId, ids);

  const threadId = newId('thr');
  await db.insert(messageThreads).values({
    id: threadId,
    agencyId,
    subject,
    clientId: input.clientId ?? null,
    projectId: input.projectId ?? null,
    createdBy: creatorId,
  });

  await db.insert(threadParticipants).values(
    ids.map((uid) => ({
      id: newId('tpt'),
      agencyId,
      threadId,
      userId: uid,
    })),
  );

  // Optional first message — createMessage handles previews + its own
  // broadcasts (message:new + thread:updated).
  if (input.body && input.body.trim()) {
    await createMessage(agencyId, creatorId, threadId, input.body);
  }

  // Fan the new-thread event to every participant's user room.
  broadcastThreadCreated(ids, await buildSummaryForBroadcast(agencyId, threadId));

  // Return the creator's view (unread is relative to the viewer).
  return buildSummary(agencyId, creatorId, threadId);
}

/** A viewer-agnostic summary (unreadCount=0) for new-thread broadcasts. */
async function buildSummaryForBroadcast(
  agencyId: string,
  threadId: string,
): Promise<ThreadSummary> {
  const [row] = await db
    .select({
      id: messageThreads.id,
      subject: messageThreads.subject,
      clientId: messageThreads.clientId,
      projectId: messageThreads.projectId,
      status: messageThreads.status,
      lastMessageAt: messageThreads.lastMessageAt,
      lastMessagePreview: messageThreads.lastMessagePreview,
      createdBy: messageThreads.createdBy,
      createdAt: messageThreads.createdAt,
      clientName: clients.name,
      projectName: projects.name,
    })
    .from(messageThreads)
    .leftJoin(clients, eq(clients.id, messageThreads.clientId))
    .leftJoin(projects, eq(projects.id, messageThreads.projectId))
    .where(eq(messageThreads.id, threadId))
    .limit(1);
  const partsMap = await participantsByThread(agencyId, [threadId]);
  return {
    id: row!.id,
    subject: row!.subject,
    clientId: row!.clientId,
    clientName: row!.clientName ?? null,
    projectId: row!.projectId,
    projectName: row!.projectName ?? null,
    status: row!.status,
    lastMessageAt: toIso(row!.lastMessageAt),
    lastMessagePreview: row!.lastMessagePreview,
    createdBy: row!.createdBy,
    createdAt: toIso(row!.createdAt),
    participants: partsMap.get(threadId) ?? [],
    unreadCount: 0,
  };
}

export interface ListMessagesOptions {
  before?: string; // cursor: a message id; older messages are returned
  limit?: number;
}

/** Messages ascending by createdAt (caller authorized `messages.view`). Paginated. */
export async function listMessages(
  agencyId: string,
  threadId: string,
  opts: ListMessagesOptions = {},
): Promise<SerializedMessage[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const filters = [
    eq(messages.agencyId, agencyId),
    eq(messages.threadId, threadId),
  ];

  // Keyset pagination: fetch messages strictly older than the cursor row,
  // ordered DESC, then reverse to ascending for the client.
  if (opts.before) {
    const [cursor] = await db
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(eq(messages.id, opts.before), eq(messages.agencyId, agencyId)),
      )
      .limit(1);
    if (cursor && cursor.createdAt) {
      filters.push(
        or(
          lt(messages.createdAt, cursor.createdAt),
          and(
            eq(messages.createdAt, cursor.createdAt),
            lt(messages.id, cursor.id),
          ),
        )!,
      );
    }
  }

  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      senderId: messages.senderId,
      body: messages.body,
      attachmentsJson: messages.attachmentsJson,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      senderName: users.fullName,
      pinnedAt: messages.pinnedAt,
      pinnedBy: messages.pinnedBy,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(and(...filters))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);

  // Reverse to ascending (oldest -> newest) for natural render order.
  return rows.reverse().map(serializeMessageRow);
}

/**
 * Persist a message (source of truth), bump the thread, advance the sender's
 * read cursor, and broadcast 'message:new' + 'thread:updated'. Called by BOTH
 * the REST route and the socket 'message:send' handler.
 */
export interface CreateMessageOptions {
  attachments?: MessageAttachment[];
}

export async function createMessage(
  agencyId: string,
  senderId: string,
  threadId: string,
  body: string,
  opts: CreateMessageOptions = {},
): Promise<SerializedMessage> {
  const trimmed = body.trim();
  const attachments = (opts.attachments ?? []).filter(
    (a) => a && typeof a.url === 'string',
  );
  if (!trimmed && attachments.length === 0) {
    throw badRequest('Message body or an attachment is required.');
  }

  const { thread } = await requireParticipant(agencyId, senderId, threadId);

  const now = new Date();
  const id = newId('msg');
  await db.insert(messages).values({
    id,
    agencyId,
    threadId,
    senderId,
    body: trimmed,
    attachmentsJson: attachments.length ? JSON.stringify(attachments) : null,
    createdAt: now,
  });

  // Bump the thread's activity + preview (attachment-only → a paperclip hint).
  await db
    .update(messageThreads)
    .set({
      lastMessageAt: now,
      lastMessagePreview: trimmed
        ? preview(trimmed)
        : `📎 ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(messageThreads.id, threadId),
        eq(messageThreads.agencyId, agencyId),
      ),
    );

  // The sender has by definition read their own message.
  await db
    .update(threadParticipants)
    .set({ lastReadAt: now })
    .where(
      and(
        eq(threadParticipants.agencyId, agencyId),
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, senderId),
      ),
    );

  const [senderRow] = await db
    .select({ name: users.fullName })
    .from(users)
    .where(eq(users.id, senderId))
    .limit(1);
  const senderName = senderRow?.name ?? null;

  const message = serializeMessageRow({
    id,
    threadId,
    senderId,
    body: trimmed,
    attachmentsJson: attachments.length ? JSON.stringify(attachments) : null,
    createdAt: now,
    editedAt: null,
    senderName,
  });

  const userIds = await participantUserIds(agencyId, threadId);
  broadcastNewMessage(userIds, threadId, message);

  // @mentions → in-app notification to mentioned participants.
  await notifyMentions(agencyId, threadId, thread.subject, senderId, senderName, trimmed);

  return message;
}

/** Parse `@name` tokens and notify any matching thread participants. */
async function notifyMentions(
  agencyId: string,
  threadId: string,
  subject: string,
  senderId: string,
  senderName: string | null,
  body: string,
): Promise<void> {
  if (!body.includes('@')) return;
  const tokens = new Set(
    (body.match(/@([\p{L}\p{N}_]+)/gu) ?? []).map((t) => t.slice(1).toLowerCase()),
  );
  if (tokens.size === 0) return;

  const rows = await db
    .select({ userId: threadParticipants.userId, name: users.fullName })
    .from(threadParticipants)
    .leftJoin(users, eq(users.id, threadParticipants.userId))
    .where(
      and(
        eq(threadParticipants.agencyId, agencyId),
        eq(threadParticipants.threadId, threadId),
      ),
    );

  for (const r of rows) {
    const rawName = r.name as string | null;
    const name = (rawName ?? '').trim();
    if (r.userId === senderId || !name) continue;
    const first = name.split(/\s+/)[0]?.toLowerCase();
    const full = name.replace(/\s+/g, '').toLowerCase();
    if ((first && tokens.has(first)) || tokens.has(full)) {
      await notify({
        agencyId,
        userId: r.userId,
        type: 'message.mention',
        title: `${senderName ?? 'Someone'} mentioned you`,
        body: `${subject}: ${preview(body)}`,
        entityType: 'thread',
        entityId: threadId,
        link: `/messages?thread=${threadId}`,
      });
    }
  }
}

/** Edit a message body (caller authorized `messages.update`). Broadcasts 'message:updated'. */
export async function editMessage(
  agencyId: string,
  threadId: string,
  messageId: string,
  body: string,
): Promise<SerializedMessage> {
  const trimmed = body.trim();
  if (!trimmed) throw badRequest('Message body is required.');

  const [msg] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.threadId, threadId),
        eq(messages.agencyId, agencyId),
      ),
    )
    .limit(1);
  if (!msg) throw notFound('Message not found.');

  const now = new Date();
  await db
    .update(messages)
    .set({ body: trimmed, editedAt: now })
    .where(and(eq(messages.id, messageId), eq(messages.agencyId, agencyId)));

  const [senderRow] = msg.senderId
    ? await db
        .select({ name: users.fullName })
        .from(users)
        .where(eq(users.id, msg.senderId))
        .limit(1)
    : [];

  const message = serializeMessageRow({
    id: messageId,
    threadId,
    senderId: msg.senderId,
    body: trimmed,
    attachmentsJson: msg.attachmentsJson,
    createdAt: msg.createdAt,
    editedAt: now,
    senderName: senderRow?.name ?? null,
  });
  broadcastMessageUpdated(threadId, message);
  return message;
}

/** Delete a message (caller authorized `messages.delete`). Broadcasts. */
export async function deleteMessage(
  agencyId: string,
  threadId: string,
  messageId: string,
): Promise<void> {
  const [msg] = await db
    .select({ senderId: messages.senderId })
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.threadId, threadId),
        eq(messages.agencyId, agencyId),
      ),
    )
    .limit(1);
  if (!msg) throw notFound('Message not found.');

  await db
    .delete(messages)
    .where(and(eq(messages.id, messageId), eq(messages.agencyId, agencyId)));
  broadcastMessageDeleted(threadId, { threadId, messageId });
}

/** Advance the viewer's read cursor and broadcast a live read receipt. */
export async function markRead(
  agencyId: string,
  userId: string,
  threadId: string,
): Promise<{ threadId: string; userId: string; lastReadAt: string | null }> {
  await requireParticipant(agencyId, userId, threadId);

  const now = new Date();
  await db
    .update(threadParticipants)
    .set({ lastReadAt: now })
    .where(
      and(
        eq(threadParticipants.agencyId, agencyId),
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
      ),
    );

  const payload = { threadId, userId, lastReadAt: toIso(now) };
  broadcastThreadRead(threadId, payload);
  return payload;
}

export interface UpdateThreadInput {
  subject?: string;
  status?: 'open' | 'awaiting' | 'closed';
  /** null clears the link; undefined leaves it unchanged. */
  clientId?: string | null;
  projectId?: string | null;
  addParticipantIds?: string[];
  removeParticipantIds?: string[];
}

export interface UpdateThreadResult {
  summary: ThreadSummary;
  /** User ids actually added / removed (for room re-sync + audit). */
  added: string[];
  removed: string[];
}

/**
 * Mutate a thread (subject/status/links/membership) and broadcast
 * 'thread:updated'. The caller authorized every part of `input` (and validated
 * client/project links). Invariants enforced here: added participants are
 * active staff, and a thread can never be left without participants.
 */
export async function updateThread(
  agencyId: string,
  userId: string,
  threadId: string,
  input: UpdateThreadInput,
): Promise<UpdateThreadResult> {
  const before = await participantUserIds(agencyId, threadId);
  const add = Array.from(new Set((input.addParticipantIds ?? []).filter(Boolean))).filter(
    (id) => !before.includes(id),
  );
  const removeReq = new Set((input.removeParticipantIds ?? []).filter(Boolean));
  const remove = before.filter((id) => removeReq.has(id));
  const after = [...before, ...add].filter((id) => !remove.includes(id));
  if (after.length === 0) {
    throw badRequest('A thread must keep at least one participant.');
  }
  if (add.length) await requireActiveStaff(agencyId, add);

  const patch: Partial<typeof messageThreads.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.subject !== undefined) {
    const s = input.subject.trim();
    if (!s) throw badRequest('Subject cannot be empty.');
    patch.subject = s;
  }
  if (input.status !== undefined) patch.status = input.status;
  if (input.clientId !== undefined) {
    patch.clientId = input.clientId; // null clears the link
    // Clearing the client also clears a now-orphaned project link.
    if (input.clientId === null) patch.projectId = null;
  }
  if (input.projectId !== undefined) {
    patch.projectId = input.projectId;
  }

  await db
    .update(messageThreads)
    .set(patch)
    .where(
      and(
        eq(messageThreads.id, threadId),
        eq(messageThreads.agencyId, agencyId),
      ),
    );

  for (const uid of add) {
    await db
      .insert(threadParticipants)
      .values({ id: newId('tpt'), agencyId, threadId, userId: uid })
      .onConflictDoNothing();
  }
  if (remove.length) {
    await db
      .delete(threadParticipants)
      .where(
        and(
          eq(threadParticipants.agencyId, agencyId),
          eq(threadParticipants.threadId, threadId),
          inArray(threadParticipants.userId, remove),
        ),
      );
    // Evicted users drop the thread from their list.
    const io = getIo();
    for (const uid of remove) io?.to(userRoom(uid)).emit('thread:removed', { threadId });
  }

  // Fan the updated summary to the (possibly new) participant set.
  const userIds = await participantUserIds(agencyId, threadId);
  broadcastThreadUpdate(
    userIds,
    await buildSummaryForBroadcast(agencyId, threadId),
  );

  return { summary: await buildSummary(agencyId, userId, threadId), added: add, removed: remove };
}

/**
 * Delete a thread (participants + messages cascade; caller authorized
 * `threads.delete`). Returns the former participants (for room re-sync).
 */
export async function deleteThread(
  agencyId: string,
  threadId: string,
): Promise<string[]> {
  const former = await participantUserIds(agencyId, threadId);
  await db
    .delete(messageThreads)
    .where(
      and(
        eq(messageThreads.id, threadId),
        eq(messageThreads.agencyId, agencyId),
      ),
    );
  const io = getIo();
  for (const uid of former) io?.to(userRoom(uid)).emit('thread:deleted', { threadId });
  return former;
}

/** Total unread messages across all threads the user participates in. */
export async function unreadCount(
  agencyId: string,
  userId: string,
): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)` })
    .from(messages)
    .innerJoin(
      threadParticipants,
      and(
        eq(threadParticipants.threadId, messages.threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.agencyId, agencyId),
      ),
    )
    .where(
      and(
        eq(messages.agencyId, agencyId),
        ne(messages.senderId, userId),
        or(
          sql`${threadParticipants.lastReadAt} is null`,
          gt(messages.createdAt, threadParticipants.lastReadAt),
        ),
      ),
    );
  return Number(r?.c ?? 0);
}

// ============================================================
//  Pinning
// ============================================================

/**
 * Pin or unpin a message. Pinned messages surface on the client overview so a
 * newcomer can read the few messages that actually explain the engagement.
 * Caller authorized `messages.pin`.
 */
export async function setMessagePinned(
  agencyId: string,
  userId: string,
  threadId: string,
  messageId: string,
  pinned: boolean,
): Promise<SerializedMessage> {
  const [existing] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.threadId, threadId),
        eq(messages.agencyId, agencyId),
      ),
    )
    .limit(1);
  if (!existing) throw notFound('Message not found.');

  await db
    .update(messages)
    .set({
      pinnedAt: pinned ? new Date() : null,
      pinnedBy: pinned ? userId : null,
    })
    .where(and(eq(messages.id, messageId), eq(messages.agencyId, agencyId)));

  const [row] = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      senderId: messages.senderId,
      body: messages.body,
      attachmentsJson: messages.attachmentsJson,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      senderName: users.fullName,
      pinnedAt: messages.pinnedAt,
      pinnedBy: messages.pinnedBy,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(eq(messages.id, messageId));

  return serializeMessageRow(row!);
}
