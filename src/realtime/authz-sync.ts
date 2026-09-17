/**
 * Propagate authorization changes to live sockets (design §I.2/§I.3):
 *  - session revoked      → disconnect that session's sockets
 *  - portal link revoked  → disconnect that link's sockets
 *  - user grants changed  → re-sync the user's thread rooms, emit `authz:changed`
 *  - thread membership    → callers use resyncUsers([...]) after participant changes
 */
import type { Server } from 'socket.io';
import { setAuthzChangeHooks } from '../authz/resolver.js';
import { setSessionRevokeHook } from '../authz/sessions.js';
import { portalTokenRoom, sessionRoom, userRoom } from './io.js';
import type { AppSocket } from './socket.js';

let ioRef: Server | null = null;

export async function resyncUsers(userIds: string[]): Promise<void> {
  const io = ioRef;
  if (!io) return;
  const { socketActor, syncThreadRooms } = await import('./socket.js');
  for (const uid of new Set(userIds)) {
    const sockets = (await io.in(userRoom(uid)).fetchSockets()) as unknown as AppSocket[];
    for (const s of sockets) {
      const actor = await socketActor(s.data);
      if (!actor) {
        s.disconnect(true);
        continue;
      }
      // fetchSockets returns RemoteSocket in cluster mode; locally it is the Socket.
      if (typeof (s as AppSocket).join === 'function') {
        await syncThreadRooms(s, actor);
      }
    }
    io.to(userRoom(uid)).emit('authz:changed' as never, {} as never);
  }
}

export function disconnectPortalToken(tokenId: string): void {
  ioRef?.in(portalTokenRoom(tokenId)).disconnectSockets(true);
}

export function registerRealtimeAuthzHooks(io: Server): void {
  ioRef = io;
  setSessionRevokeHook((ids) => {
    for (const id of ids) io.in(sessionRoom(id)).disconnectSockets(true);
  });
  setAuthzChangeHooks({
    users: (userIds) => {
      void resyncUsers(userIds);
    },
  });
}
