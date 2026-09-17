import { Router, type Request } from 'express';
import { z } from 'zod';
import { ok, created, param } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { projects } from '../db/schema.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize, canOrg, check, type ObjectFacts } from '../authz/engine.js';
import type { StaffActor } from '../authz/actor.js';
import { actorAuditId } from '../authz/actor.js';
import { assertAgencyStorageKey, requireInAgency } from '../authz/tenancy.js';
import {
  MESSAGE_CAPABILITIES,
  messageFacts,
  messageFactsFrom,
  participantOrModerator,
  threadCapabilities,
  threadFacts,
} from '../authz/policies/threads.js';
import { clientFacts } from '../authz/policies/clients.js';
import { resyncUsers } from '../realtime/authz-sync.js';
import { audit } from '../services/audit.js';
import {
  createMessage,
  createThread,
  deleteMessage,
  setMessagePinned,
  deleteThread,
  editMessage,
  getThread,
  listMessages,
  listThreads,
  markRead,
  unreadCount,
  updateThread,
  type SerializedMessage,
  type ThreadSummary,
} from '../services/messages.js';

/**
 * Messages & threads (staff only; client-side actors get 401 from
 * getStaffActor and hold no messages.* grants anyway).
 *
 * Policy (docs/authorization/README.md §D.7, §G.2):
 *  - every thread operation loads threadFacts; the actor must participate in
 *    the thread unless it holds the permission at organization scope
 *    (moderation). Non-visible threads are 404.
 *  - messages.update is own only; messages.delete own / assigned (any message
 *    in your threads) / organization.
 *  - removing anyone but yourself, or adding people, needs
 *    threads.manage_participants; a thread never ends with zero participants.
 */
const THREAD_STATUSES = ['open', 'awaiting', 'closed'] as const;

const attachmentSchema = z.object({
  url: z.string().url(),
  type: z.enum(['image', 'file']),
  name: z.string().min(1).max(255),
  mime: z.string().max(160).nullable().optional(),
  bytes: z.number().int().min(0).nullable().optional(),
});

export const messagesRouter = Router();
messagesRouter.use(authenticate);

// ============================================================
//  Helpers
// ============================================================

/**
 * Load thread facts and authorize `permission` with the participant rule.
 * 404 when the actor can't see the thread (not in tenant, or neither a
 * participant nor an organization-scope `messages.view` holder).
 */
async function authorizeThread(
  actor: StaffActor,
  threadId: string,
  permission: string,
  opts: { participantOnly?: boolean } = {},
): Promise<ObjectFacts> {
  const facts = await threadFacts(actor, threadId);
  authorize(actor, permission, facts, {
    // (engine: a `view` equal to the permission would turn a 404 into a 403)
    view: permission === 'messages.view' ? undefined : 'messages.view',
    condition: () =>
      (opts.participantOnly ? facts!.assigned === true : participantOrModerator(actor, facts!, permission)) ||
      'You are not a participant of this thread.',
  });
  return facts!;
}

/** Thread facts for a summary relative to the viewer (list rows). */
function summaryFacts(actor: StaffActor, s: ThreadSummary): ObjectFacts {
  return {
    agencyId: actor.agencyId,
    ownerIds: [s.createdBy],
    assigned: s.participants.some((p) => p.userId === actor.userId),
  };
}

function withThreadCaps(actor: StaffActor, s: ThreadSummary): ThreadSummary {
  return { ...s, capabilities: threadCapabilities(actor, summaryFacts(actor, s)) };
}

function withMessageCaps(actor: StaffActor, thread: ObjectFacts, m: SerializedMessage): SerializedMessage {
  return {
    ...m,
    capabilities: threadCapabilities(actor, messageFactsFrom(thread, m.senderId), MESSAGE_CAPABILITIES),
  };
}

/** Re-linking a thread to a client requires clients.view on that client. */
async function assertClientLink(actor: StaffActor, clientId: string): Promise<void> {
  const facts = await clientFacts(actor, clientId);
  if (!facts || !check(actor, 'clients.view', facts)) throw notFound('Client not found.');
}

function auditActor(actor: StaffActor, req: Request) {
  return { agencyId: actor.agencyId, actorType: actor.type, actorId: actorAuditId(actor), ip: req.ip };
}

// ============================================================
//  THREADS
// ============================================================

// GET /messages/threads?status=&search=&clientId=&scope=mine|all
// messages.view. scope=all (moderation) needs organization-scope messages.view.
const listThreadsQuery = z.object({
  status: z.enum(THREAD_STATUSES).optional(),
  search: z.string().optional(),
  clientId: z.string().min(1).optional(),
  scope: z.enum(['mine', 'all']).optional(),
});

messagesRouter.get('/threads', requires('messages.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const q = listThreadsQuery.parse(req.query);
  const all = q.scope === 'all' && canOrg(actor, 'messages.view');
  const rows = await listThreads(actor.agencyId, actor.userId, {
    status: q.status,
    search: q.search,
    clientId: q.clientId,
    all,
  });
  ok(res, rows.map((s) => withThreadCaps(actor, s)));
});

// POST /messages/threads — threads.create
const createThreadSchema = z.object({
  subject: z.string().min(1).max(200),
  participantIds: z.array(z.string().min(1)),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  body: z.string().max(10000).nullable().optional(),
});

messagesRouter.post('/threads', requires('threads.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = createThreadSchema.parse(req.body);
  if (body.clientId) await assertClientLink(actor, body.clientId);
  if (body.projectId) await requireInAgency(projects, actor.agencyId, body.projectId, 'Project');
  // Participants are validated as active staff inside the service.
  const summary = await createThread(actor.agencyId, actor.userId, {
    subject: body.subject,
    participantIds: body.participantIds,
    clientId: body.clientId ?? null,
    projectId: body.projectId ?? null,
    body: body.body ?? null,
  });
  await resyncUsers(summary.participants.map((p) => p.userId));
  created(res, withThreadCaps(actor, summary));
});

// GET /messages/threads/:id — messages.view (participant, or organization moderation)
messagesRouter.get('/threads/:id', requires('messages.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const threadId = param(req, 'id');
  await authorizeThread(actor, threadId, 'messages.view');
  const summary = await getThread(actor.agencyId, actor.userId, threadId);
  ok(res, withThreadCaps(actor, summary));
});

// PATCH /messages/threads/:id
//   subject/status/clientId/projectId → threads.update (own = creator / organization)
//   addParticipantIds, or removing anyone but yourself → threads.manage_participants
//   removing only yourself → messages.view as a participant (leave thread)
const updateThreadSchema = z.object({
  subject: z.string().min(1).max(200).optional(),
  status: z.enum(THREAD_STATUSES).optional(),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  addParticipantIds: z.array(z.string().min(1)).optional(),
  removeParticipantIds: z.array(z.string().min(1)).optional(),
});

messagesRouter.patch('/threads/:id', requires('messages.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const threadId = param(req, 'id');
  const body = updateThreadSchema.parse(req.body);

  const facts = await authorizeThread(actor, threadId, 'messages.view');
  const changesThread =
    body.subject !== undefined ||
    body.status !== undefined ||
    body.clientId !== undefined ||
    body.projectId !== undefined;
  if (changesThread) await authorizeThread(actor, threadId, 'threads.update');

  const adds = (body.addParticipantIds ?? []).filter(Boolean);
  const removesOthers = (body.removeParticipantIds ?? []).some((id) => id !== actor.userId);
  if (adds.length || removesOthers) {
    await authorizeThread(actor, threadId, 'threads.manage_participants');
  } else if ((body.removeParticipantIds ?? []).length && !facts.assigned) {
    // Leaving a thread you aren't in is meaningless.
    await authorizeThread(actor, threadId, 'messages.view', { participantOnly: true });
  }

  if (body.clientId) await assertClientLink(actor, body.clientId);
  if (body.projectId) await requireInAgency(projects, actor.agencyId, body.projectId, 'Project');

  const result = await updateThread(actor.agencyId, actor.userId, threadId, body);

  if (result.added.length || result.removed.length) {
    await resyncUsers([...result.added, ...result.removed]);
    await audit({
      ...auditActor(actor, req),
      action: 'thread.participants_changed',
      entityType: 'thread',
      entityId: threadId,
      metadata: { added: result.added, removed: result.removed },
    });
  }

  // The caller may have left the thread: capabilities reflect the new state.
  ok(res, withThreadCaps(actor, result.summary));
});

// DELETE /messages/threads/:id — threads.delete (own = creator / organization)
messagesRouter.delete('/threads/:id', requires('threads.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const threadId = param(req, 'id');
  await authorizeThread(actor, threadId, 'threads.delete');
  const former = await deleteThread(actor.agencyId, threadId);
  await resyncUsers(former);
  await audit({
    ...auditActor(actor, req),
    action: 'thread.delete',
    entityType: 'thread',
    entityId: threadId,
    metadata: { participants: former },
  });
  ok(res, { deleted: true });
});

// ============================================================
//  MESSAGES
// ============================================================

// GET /messages/threads/:id/messages?before=&limit= — messages.view
const listMessagesQuery = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

messagesRouter.get('/threads/:id/messages', requires('messages.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const threadId = param(req, 'id');
  const q = listMessagesQuery.parse(req.query);
  const facts = await authorizeThread(actor, threadId, 'messages.view');
  const rows = await listMessages(actor.agencyId, threadId, {
    before: q.before,
    limit: q.limit,
  });
  ok(res, rows.map((m) => withMessageCaps(actor, facts, m)));
});

// POST /messages/threads/:id/messages — messages.send (participant)
// Attachment URLs must point at this agency's storage (sanctum/<agencyId>/…).
const createMessageSchema = z
  .object({
    body: z.string().max(10000).optional().default(''),
    attachments: z.array(attachmentSchema).max(10).optional(),
  })
  .refine((v) => v.body.trim().length > 0 || (v.attachments?.length ?? 0) > 0, {
    message: 'A message body or at least one attachment is required.',
  });

messagesRouter.post('/threads/:id/messages', requires('messages.send'), async (req, res) => {
  const actor = getStaffActor(req);
  const threadId = param(req, 'id');
  const body = createMessageSchema.parse(req.body);
  const facts = await authorizeThread(actor, threadId, 'messages.send', { participantOnly: true });
  for (const a of body.attachments ?? []) assertAgencyStorageKey(actor.agencyId, a.url);
  const message = await createMessage(actor.agencyId, actor.userId, threadId, body.body, {
    attachments: body.attachments,
  });
  created(res, withMessageCaps(actor, facts, message));
});

// PATCH /messages/threads/:id/messages/:msgId — messages.update (own, participant)
const editMessageSchema = z.object({ body: z.string().min(1).max(10000) });

messagesRouter.patch('/threads/:id/messages/:msgId', requires('messages.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const threadId = param(req, 'id');
  const messageId = param(req, 'msgId');
  const body = editMessageSchema.parse(req.body);
  const loaded = await loadMessage(actor, threadId, messageId, 'messages.update', true);
  const message = await editMessage(actor.agencyId, threadId, messageId, body.body);
  ok(res, withMessageCaps(actor, loaded.thread, message));
});

// DELETE /messages/threads/:id/messages/:msgId — messages.delete
//   own: your message (as a participant); assigned: any message in your
//   threads; organization: any message (moderation), audited.
messagesRouter.delete('/threads/:id/messages/:msgId', requires('messages.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const threadId = param(req, 'id');
  const messageId = param(req, 'msgId');
  const loaded = await loadMessage(actor, threadId, messageId, 'messages.delete', false);
  await deleteMessage(actor.agencyId, threadId, messageId);
  const own = loaded.message.ownerIds?.includes(actor.userId) === true;
  if (!own) {
    await audit({
      ...auditActor(actor, req),
      action: 'message.delete',
      entityType: 'message',
      entityId: messageId,
      metadata: { threadId, senderId: loaded.message.ownerIds?.[0] ?? null },
    });
  }
  ok(res, { deleted: true });
});

// PATCH /messages/threads/:id/messages/:msgId/pin — messages.pin (assigned / organization)
const pinSchema = z.object({ pinned: z.boolean() });

messagesRouter.patch('/threads/:id/messages/:msgId/pin', requires('messages.pin'), async (req, res) => {
  const actor = getStaffActor(req);
  const threadId = param(req, 'id');
  const messageId = param(req, 'msgId');
  const body = pinSchema.parse(req.body);
  const loaded = await loadMessage(actor, threadId, messageId, 'messages.pin', false);
  const message = await setMessagePinned(actor.agencyId, actor.userId, threadId, messageId, body.pinned);
  ok(res, withMessageCaps(actor, loaded.thread, message));
});

// POST /messages/threads/:id/read — messages.view as a participant (own read cursor)
messagesRouter.post('/threads/:id/read', requires('messages.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const threadId = param(req, 'id');
  await authorizeThread(actor, threadId, 'messages.view', { participantOnly: true });
  const payload = await markRead(actor.agencyId, actor.userId, threadId);
  ok(res, payload);
});

// GET /messages/unread-count — messages.view (the actor's own threads only)
messagesRouter.get('/unread-count', requires('messages.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const count = await unreadCount(actor.agencyId, actor.userId);
  ok(res, { count });
});

/**
 * Load a message bound to its URL thread and authorize `permission` on it.
 * `participantOnly` forces participation even for organization scope.
 */
async function loadMessage(
  actor: StaffActor,
  threadId: string,
  messageId: string,
  permission: string,
  participantOnly: boolean,
): Promise<{ thread: ObjectFacts; message: ObjectFacts }> {
  const loaded = await messageFacts(actor, threadId, messageId);
  if (!loaded) {
    // Existence of the message is only revealed to those who can see the thread.
    await authorizeThread(actor, threadId, 'messages.view');
    throw notFound('Message not found.');
  }
  const f = loaded.message;
  authorize(actor, permission, f, {
    view: 'messages.view',
    condition: () =>
      (participantOnly ? f.assigned === true : participantOrModerator(actor, f, permission)) ||
      'You are not a participant of this thread.',
  });
  return loaded;
}
