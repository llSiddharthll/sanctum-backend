import type { Server } from 'socket.io';

/**
 * Module-level Socket.IO singleton. The HTTP server constructs the `Server`
 * (see socket.ts) and registers it here; services import the broadcast helpers
 * below to push live events. Socket.IO is the DELIVERY layer only — Turso is
 * the source of truth, so a missing/sleeping socket never loses data.
 */
let ioRef: Server | null = null;

export function setIo(io: Server): void {
  ioRef = io;
}

/** Returns the live Server, or null if the socket layer isn't initialised. */
export function getIo(): Server | null {
  return ioRef;
}

// ---- Room naming ----
export const threadRoom = (id: string): string => `thread:${id}`;
export const userRoom = (id: string): string => `user:${id}`;

// ============================================================
//  Broadcast helpers (no-ops when the socket layer is absent)
// ============================================================

/**
 * A new message landed in a thread. Emit to the thread room (everyone with the
 * thread open, including the sender for echo/ack reconciliation) and bump each
 * participant's thread-list via their personal user room.
 */
export function broadcastNewMessage(
  participantUserIds: string[],
  threadId: string,
  message: unknown,
): void {
  const io = ioRef;
  if (!io) return;
  io.to(threadRoom(threadId)).emit('message:new', message);
  for (const uid of participantUserIds) {
    io.to(userRoom(uid)).emit('thread:updated', { threadId });
  }
}

/**
 * A thread's summary changed (subject/status/participants/last message).
 * Delivered to each participant's user room so their thread list re-renders.
 */
export function broadcastThreadUpdate(
  participantUserIds: string[],
  payload: unknown,
): void {
  const io = ioRef;
  if (!io) return;
  for (const uid of participantUserIds) {
    io.to(userRoom(uid)).emit('thread:updated', payload);
  }
}

/** A brand-new thread was created — notify each participant's user room. */
export function broadcastThreadCreated(
  participantUserIds: string[],
  summary: unknown,
): void {
  const io = ioRef;
  if (!io) return;
  for (const uid of participantUserIds) {
    io.to(userRoom(uid)).emit('thread:created', summary);
  }
}

/** A new in-app notification for a single user — delivered to their user room. */
export function broadcastNotification(userId: string, payload: unknown): void {
  const io = ioRef;
  if (!io) return;
  io.to(userRoom(userId)).emit('notification:new', payload);
}

/** Someone advanced their read cursor — tell the thread room (live receipts). */
export function broadcastThreadRead(
  threadId: string,
  payload: unknown,
): void {
  const io = ioRef;
  if (!io) return;
  io.to(threadRoom(threadId)).emit('thread:read', payload);
}
