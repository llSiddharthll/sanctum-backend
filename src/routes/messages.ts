import { Router } from 'express';
import { z } from 'zod';
import { ok, created, param } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';
import {
  createMessage,
  createThread,
  deleteMessage,
  deleteThread,
  editMessage,
  getThread,
  listMessages,
  listThreads,
  markRead,
  unreadCount,
  updateThread,
} from '../services/messages.js';

const THREAD_STATUSES = ['open', 'awaiting', 'closed'] as const;

const attachmentSchema = z.object({
  url: z.string().url(),
  type: z.enum(['image', 'file']),
  name: z.string().min(1).max(255),
  mime: z.string().max(160).nullable().optional(),
  bytes: z.number().int().min(0).nullable().optional(),
});

export const messagesRouter = Router();
messagesRouter.use(requireAuth);
messagesRouter.use(requireModuleRW('messages'));

// ============================================================
//  THREADS
// ============================================================

// GET /messages/threads?status=&search=&clientId=
const listThreadsQuery = z.object({
  status: z.enum(THREAD_STATUSES).optional(),
  search: z.string().optional(),
  clientId: z.string().min(1).optional(),
});

messagesRouter.get('/threads', async (req, res) => {
  const ctx = getAuth(req);
  const q = listThreadsQuery.parse(req.query);
  const rows = await listThreads(ctx.agencyId, ctx.userId, {
    status: q.status,
    search: q.search,
    clientId: q.clientId,
  });
  ok(res, rows);
});

// POST /messages/threads
const createThreadSchema = z.object({
  subject: z.string().min(1).max(200),
  participantIds: z.array(z.string().min(1)),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  body: z.string().max(10000).nullable().optional(),
});

messagesRouter.post('/threads', async (req, res) => {
  const ctx = getAuth(req);
  const body = createThreadSchema.parse(req.body);
  const summary = await createThread(ctx.agencyId, ctx.userId, {
    subject: body.subject,
    participantIds: body.participantIds,
    clientId: body.clientId ?? null,
    projectId: body.projectId ?? null,
    body: body.body ?? null,
  });
  created(res, summary);
});

// GET /messages/threads/:id
messagesRouter.get('/threads/:id', async (req, res) => {
  const ctx = getAuth(req);
  const summary = await getThread(ctx.agencyId, ctx.userId, param(req, 'id'));
  ok(res, summary);
});

// PATCH /messages/threads/:id
const updateThreadSchema = z.object({
  subject: z.string().min(1).max(200).optional(),
  status: z.enum(THREAD_STATUSES).optional(),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  addParticipantIds: z.array(z.string().min(1)).optional(),
  removeParticipantIds: z.array(z.string().min(1)).optional(),
});

messagesRouter.patch('/threads/:id', async (req, res) => {
  const ctx = getAuth(req);
  const body = updateThreadSchema.parse(req.body);
  const summary = await updateThread(
    ctx.agencyId,
    ctx.userId,
    param(req, 'id'),
    body,
  );
  ok(res, summary);
});

// DELETE /messages/threads/:id
messagesRouter.delete('/threads/:id', async (req, res) => {
  const ctx = getAuth(req);
  await deleteThread(ctx.agencyId, ctx.userId, param(req, 'id'));
  ok(res, { deleted: true });
});

// ============================================================
//  MESSAGES
// ============================================================

// GET /messages/threads/:id/messages?before=&limit=
const listMessagesQuery = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

messagesRouter.get('/threads/:id/messages', async (req, res) => {
  const ctx = getAuth(req);
  const q = listMessagesQuery.parse(req.query);
  const rows = await listMessages(ctx.agencyId, ctx.userId, param(req, 'id'), {
    before: q.before,
    limit: q.limit,
  });
  ok(res, rows);
});

// POST /messages/threads/:id/messages
const createMessageSchema = z
  .object({
    body: z.string().max(10000).optional().default(''),
    attachments: z.array(attachmentSchema).max(10).optional(),
  })
  .refine((v) => v.body.trim().length > 0 || (v.attachments?.length ?? 0) > 0, {
    message: 'A message body or at least one attachment is required.',
  });

messagesRouter.post('/threads/:id/messages', async (req, res) => {
  const ctx = getAuth(req);
  const body = createMessageSchema.parse(req.body);
  const message = await createMessage(
    ctx.agencyId,
    ctx.userId,
    param(req, 'id'),
    body.body,
    { attachments: body.attachments },
  );
  created(res, message);
});

// PATCH /messages/threads/:id/messages/:msgId — edit your own message.
const editMessageSchema = z.object({ body: z.string().min(1).max(10000) });

messagesRouter.patch('/threads/:id/messages/:msgId', async (req, res) => {
  const ctx = getAuth(req);
  const body = editMessageSchema.parse(req.body);
  const message = await editMessage(
    ctx.agencyId,
    ctx.userId,
    param(req, 'id'),
    param(req, 'msgId'),
    body.body,
  );
  ok(res, message);
});

// DELETE /messages/threads/:id/messages/:msgId — your own, or any if admin.
messagesRouter.delete('/threads/:id/messages/:msgId', async (req, res) => {
  const ctx = getAuth(req);
  await deleteMessage(
    ctx.agencyId,
    ctx.userId,
    ctx.role,
    param(req, 'id'),
    param(req, 'msgId'),
  );
  ok(res, { deleted: true });
});

// POST /messages/threads/:id/read
messagesRouter.post('/threads/:id/read', async (req, res) => {
  const ctx = getAuth(req);
  const payload = await markRead(ctx.agencyId, ctx.userId, param(req, 'id'));
  ok(res, payload);
});

// GET /messages/unread-count
messagesRouter.get('/unread-count', async (req, res) => {
  const ctx = getAuth(req);
  const count = await unreadCount(ctx.agencyId, ctx.userId);
  ok(res, { count });
});
