import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { parse as parseCookie } from 'cookie';
import { and, eq } from 'drizzle-orm';
import { env } from '../env.js';
import { verifyAccessToken, type Role } from '../lib/jwt.js';
import { db } from '../db/client.js';
import { threadParticipants, users } from '../db/schema.js';
import { ACCESS_COOKIE } from '../middleware/auth.js';
import { createMessage, markRead } from '../services/messages.js';
import { setIo, threadRoom, userRoom } from './io.js';

/** Same allowlist as middleware/cors.ts — credentialed handshakes only. */
const allowList = new Set(
  [env.FRONTEND_ORIGIN, 'http://localhost:3000'].filter(Boolean),
);

/** Per-socket auth context, mirroring req.auth on the REST side. */
interface SocketData {
  userId: string;
  agencyId: string;
  role: Role;
  name: string | null;
}

type AppSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  SocketData
>;

/**
 * Stand up the Socket.IO server on the existing HTTP server. Socket.IO is the
 * live-delivery layer ONLY; all durability lives in Turso (Render free tier
 * sleeps and drops sockets, so clients must reconcile via REST on reconnect).
 */
export function initSocket(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin(origin, cb) {
        // No Origin (native/curl/server-to-server) -> allow.
        if (!origin) return cb(null, true);
        if (allowList.has(origin)) return cb(null, true);
        return cb(new Error('CORS_NOT_ALLOWED'), false);
      },
      credentials: true,
    },
  });

  // ---- Handshake auth: cookie 'sanctum_at' OR auth.token fallback ----
  io.use(async (socket, next) => {
    try {
      const header = socket.handshake.headers.cookie;
      const cookieToken = header
        ? (parseCookie(header)[ACCESS_COOKIE] as string | undefined)
        : undefined;
      const authToken = socket.handshake.auth?.token as string | undefined;
      const token = cookieToken ?? authToken;
      if (!token) return next(new Error('unauthorized'));

      const claims = await verifyAccessToken(token);
      const [row] = await db
        .select({ name: users.fullName })
        .from(users)
        .where(eq(users.id, claims.sub))
        .limit(1);

      const data = socket.data as SocketData;
      data.userId = claims.sub;
      data.agencyId = claims.agencyId;
      data.role = claims.role;
      data.name = row?.name ?? null;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket: AppSocket) => {
    const { userId, agencyId } = socket.data;

    try {
      // Personal room for thread-list events (created/updated/read fan-out).
      socket.join(userRoom(userId));

      // Auto-join every thread room the user already participates in, so live
      // messages arrive without an explicit 'thread:open' first.
      const parts = await db
        .select({ threadId: threadParticipants.threadId })
        .from(threadParticipants)
        .where(
          and(
            eq(threadParticipants.agencyId, agencyId),
            eq(threadParticipants.userId, userId),
          ),
        );
      for (const p of parts) socket.join(threadRoom(p.threadId));
    } catch {
      // Joining rooms is best-effort; the socket still functions.
    }

    // ---- thread:open — verify membership, then join the room ----
    socket.on(
      'thread:open',
      async (threadId: string, ack?: (res: unknown) => void) => {
        try {
          const part = await isParticipant(agencyId, userId, threadId);
          if (!part) {
            ack?.({ ok: false, error: 'forbidden' });
            return;
          }
          socket.join(threadRoom(threadId));
          ack?.({ ok: true });
        } catch {
          ack?.({ ok: false, error: 'error' });
        }
      },
    );

    // ---- thread:close — leave the room ----
    socket.on('thread:close', (threadId: string) => {
      try {
        socket.leave(threadRoom(threadId));
      } catch {
        // ignore
      }
    });

    // ---- message:send — persist (source of truth) + broadcast via service ----
    socket.on(
      'message:send',
      async (
        payload: { threadId?: string; body?: string; clientMsgId?: string },
        ack?: (res: unknown) => void,
      ) => {
        try {
          const threadId = payload?.threadId;
          const body = (payload?.body ?? '').trim();
          if (!threadId || !body) {
            ack?.({ ok: false, error: 'invalid' });
            return;
          }
          const part = await isParticipant(agencyId, userId, threadId);
          if (!part) {
            ack?.({ ok: false, error: 'forbidden' });
            return;
          }
          // createMessage persists + broadcasts 'message:new' to the thread
          // room (incl. this sender) and 'thread:updated' to user rooms.
          const message = await createMessage(
            agencyId,
            userId,
            threadId,
            body,
          );
          ack?.({ ok: true, message, clientMsgId: payload.clientMsgId });
        } catch {
          ack?.({ ok: false, error: 'error' });
        }
      },
    );

    // ---- typing — ephemeral, relayed to the rest of the thread room ----
    socket.on(
      'typing',
      (payload: { threadId?: string; isTyping?: boolean }) => {
        try {
          const threadId = payload?.threadId;
          if (!threadId) return;
          socket.to(threadRoom(threadId)).emit('typing', {
            threadId,
            userId,
            name: socket.data.name,
            isTyping: Boolean(payload.isTyping),
          });
        } catch {
          // ignore
        }
      },
    );

    // ---- message:read — advance cursor + broadcast receipt via service ----
    socket.on('message:read', async (payload: { threadId?: string }) => {
      try {
        const threadId = payload?.threadId;
        if (!threadId) return;
        const part = await isParticipant(agencyId, userId, threadId);
        if (!part) return;
        await markRead(agencyId, userId, threadId);
      } catch {
        // ignore
      }
    });
  });

  setIo(io);
  return io;
}

/** Lightweight membership check for socket handlers (no thread-existence leak). */
async function isParticipant(
  agencyId: string,
  userId: string,
  threadId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: threadParticipants.id })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.agencyId, agencyId),
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(row);
}
