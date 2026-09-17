import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { parse as parseCookie } from 'cookie';
import { eq } from 'drizzle-orm';
import { env } from '../env.js';
import { db } from '../db/client.js';
import { portalTokens, users } from '../db/schema.js';
import { ACCESS_COOKIE } from '../middleware/auth.js';
import { isAllowedOrigin } from '../middleware/origin.js';
import { hashToken } from '../lib/ids.js';
import { createMessage, markRead } from '../services/messages.js';
import {
  setIo,
  threadRoom,
  userRoom,
  portalRoom,
  sessionRoom,
  portalTokenRoom,
} from './io.js';
import type { Actor } from '../authz/actor.js';
import { check } from '../authz/engine.js';
import {
  actorFromLegacyUser,
  actorFromSessionId,
  portalLinkActor,
} from '../authz/http.js';
import { verifyAnyAccessToken } from '../authz/sessions.js';
import { participantThreadIds, threadFacts } from '../authz/policies/threads.js';
import { registerRealtimeAuthzHooks } from './authz-sync.js';

const allowList = new Set(
  [...env.FRONTEND_ORIGIN.split(','), 'http://localhost:3000']
    .map((s) => s.trim())
    .filter(Boolean),
);
const allowPrivateLan = env.NODE_ENV !== 'production';

/**
 * Per-socket identity. Authority is NEVER cached here: every protected event
 * re-resolves the actor (session liveness, principal status, current grants)
 * through the same engine as REST.
 */
export interface SocketData {
  kind: 'user' | 'portal';
  agencyId: string;
  userId: string | null;
  sessionId: string | null;
  portalTokenId: string | null;
  clientId: string | null;
  name: string | null;
  /** Access-token expiry (ms). The socket is dropped when it passes. */
  expiresAtMs: number | null;
}

export type AppSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  SocketData
>;

/** Re-resolve the live actor behind a socket, or null (→ disconnect). */
export async function socketActor(data: SocketData): Promise<Actor | null> {
  try {
    if (data.expiresAtMs && Date.now() >= data.expiresAtMs) return null;
    if (data.kind === 'portal') {
      return data.sessionId
        ? (await actorFromSessionId(data.sessionId)).actor
        : await portalLinkActor(data.portalTokenId!, data.agencyId, null);
    }
    if (data.sessionId) return (await actorFromSessionId(data.sessionId)).actor;
    return (await actorFromLegacyUser(data.userId!, data.agencyId)).actor;
  } catch {
    return null;
  }
}

/** Put a user socket in exactly the thread rooms it may read right now. */
export async function syncThreadRooms(socket: AppSocket, actor: Actor): Promise<void> {
  if (actor.type !== 'staff' || !socket.data.userId) return;
  const allowed = new Set<string>();
  if (actor.grants.has('messages.view')) {
    for (const id of await participantThreadIds(actor.agencyId, socket.data.userId)) {
      allowed.add(threadRoom(id));
    }
  }
  for (const room of socket.rooms) {
    if (room.startsWith('thread:') && !allowed.has(room)) socket.leave(room);
  }
  for (const room of allowed) socket.join(room);
}

export function initSocket(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (isAllowedOrigin(origin, allowList, allowPrivateLan)) {
          return cb(null, true);
        }
        return cb(new Error('CORS_NOT_ALLOWED'), false);
      },
      credentials: true,
    },
  });

  // ---- Handshake: session token (user or link session) OR raw share-link token ----
  io.use(async (socket, next) => {
    try {
      const data = socket.data as SocketData;
      data.name = null;
      data.expiresAtMs = null;

      const portalToken = socket.handshake.auth?.portalToken as string | undefined;
      if (portalToken) {
        const [tok] = await db
          .select({ id: portalTokens.id, agencyId: portalTokens.agencyId })
          .from(portalTokens)
          .where(eq(portalTokens.tokenHash, hashToken(portalToken)))
          .limit(1);
        if (!tok) return next(new Error('unauthorized'));
        const actor = await portalLinkActor(tok.id, tok.agencyId, null); // throws when revoked/expired
        data.kind = 'portal';
        data.agencyId = actor.agencyId;
        data.portalTokenId = actor.tokenId;
        data.clientId = actor.clientId;
        data.userId = null;
        data.sessionId = null;
        return next();
      }

      const header = socket.handshake.headers.cookie;
      const cookieToken = header
        ? (parseCookie(header)[ACCESS_COOKIE] as string | undefined)
        : undefined;
      const token = (socket.handshake.auth?.token as string | undefined) ?? cookieToken;
      if (!token) return next(new Error('unauthorized'));

      const claims = await verifyAnyAccessToken(token);
      data.expiresAtMs = typeof claims.exp === 'number' ? claims.exp * 1000 : null;
      let actor: Actor;
      if (claims.v === 2) {
        actor = (await actorFromSessionId(claims.sid as string)).actor;
        data.sessionId = claims.sid as string;
      } else {
        actor = (await actorFromLegacyUser(claims.sub as string, claims.agencyId as string)).actor;
        data.sessionId = null;
      }
      data.agencyId = actor.agencyId;
      if (actor.type === 'portal_link') {
        data.kind = 'portal';
        data.portalTokenId = actor.tokenId;
        data.clientId = actor.clientId;
        data.userId = null;
      } else if (actor.type === 'staff' || actor.type === 'client') {
        data.kind = actor.type === 'client' ? 'portal' : 'user';
        data.userId = actor.userId;
        data.portalTokenId = null;
        data.clientId = actor.type === 'client' ? actor.clientId : null;
        const [row] = await db
          .select({ name: users.fullName })
          .from(users)
          .where(eq(users.id, actor.userId))
          .limit(1);
        data.name = row?.name ?? null;
      } else {
        return next(new Error('unauthorized'));
      }
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket: AppSocket) => {
    const data = socket.data;
    if (data.sessionId) socket.join(sessionRoom(data.sessionId));
    if (data.portalTokenId) socket.join(portalTokenRoom(data.portalTokenId));
    if (data.userId) socket.join(userRoom(data.userId));

    // Drop the connection when the access token it was opened with expires;
    // the client reconnects with a fresh token (re-authorized handshake).
    if (data.expiresAtMs) {
      const ms = Math.max(0, data.expiresAtMs - Date.now());
      const timer = setTimeout(() => socket.disconnect(true), Math.min(ms, 2 ** 31 - 1));
      socket.on('disconnect', () => clearTimeout(timer));
    }

    // Client-side sockets only RECEIVE portal refreshes for their brand.
    if (data.kind === 'portal') {
      if (data.clientId) socket.join(portalRoom(data.clientId));
      return;
    }

    try {
      const actor = await socketActor(data);
      if (!actor) return void socket.disconnect(true);
      await syncThreadRooms(socket, actor);
    } catch {
      // room sync is best-effort; events are still individually authorized
    }

    /** Authorize one event against a thread; disconnects dead sessions. */
    async function authorizeThread(permission: string, threadId: unknown) {
      const actor = await socketActor(data);
      if (!actor) {
        socket.disconnect(true);
        return null;
      }
      if (typeof threadId !== 'string' || !threadId) return null;
      const facts = await threadFacts(actor, threadId);
      // Every thread operation requires participation (even organization-scope
      // moderators must be participants to act in realtime).
      if (!facts?.assigned || !check(actor, permission, facts)) return null;
      return actor;
    }

    socket.on('thread:open', async (threadId: string, ack?: (res: unknown) => void) => {
      try {
        const actor = await authorizeThread('messages.view', threadId);
        if (!actor) return void ack?.({ ok: false, error: 'forbidden' });
        socket.join(threadRoom(threadId));
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false, error: 'error' });
      }
    });

    socket.on('thread:close', (threadId: string) => {
      try {
        if (typeof threadId === 'string') socket.leave(threadRoom(threadId));
      } catch {
        // ignore
      }
    });

    socket.on(
      'message:send',
      async (
        payload: { threadId?: string; body?: string; clientMsgId?: string },
        ack?: (res: unknown) => void,
      ) => {
        try {
          const body = (payload?.body ?? '').trim();
          if (!payload?.threadId || !body) return void ack?.({ ok: false, error: 'invalid' });
          const actor = await authorizeThread('messages.send', payload.threadId);
          if (!actor || actor.type !== 'staff') return void ack?.({ ok: false, error: 'forbidden' });
          const message = await createMessage(actor.agencyId, actor.userId, payload.threadId, body);
          ack?.({ ok: true, message, clientMsgId: payload.clientMsgId });
        } catch {
          ack?.({ ok: false, error: 'error' });
        }
      },
    );

    socket.on('typing', async (payload: { threadId?: string; isTyping?: boolean }) => {
      try {
        const actor = await authorizeThread('messages.send', payload?.threadId);
        if (!actor || actor.type !== 'staff') return;
        socket.to(threadRoom(payload.threadId!)).emit('typing', {
          threadId: payload.threadId,
          userId: actor.userId,
          name: data.name,
          isTyping: Boolean(payload.isTyping),
        });
      } catch {
        // ignore
      }
    });

    socket.on('message:read', async (payload: { threadId?: string }) => {
      try {
        const actor = await authorizeThread('messages.view', payload?.threadId);
        if (!actor || actor.type !== 'staff') return;
        await markRead(actor.agencyId, actor.userId, payload.threadId!);
      } catch {
        // ignore
      }
    });
  });

  setIo(io);
  registerRealtimeAuthzHooks(io);
  return io;
}
