/**
 * Message thread policy. `assigned` = the actor participates in the thread;
 * `own` = the actor created it. Used by REST (messages router) and realtime.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { messageThreads, threadParticipants } from '../../db/schema.js';
import type { Actor } from '../actor.js';
import { actorUserId } from '../actor.js';
import type { ObjectFacts } from '../engine.js';

export async function threadFacts(actor: Actor, threadId: string): Promise<ObjectFacts | null> {
  const [t] = await db
    .select({
      id: messageThreads.id,
      agencyId: messageThreads.agencyId,
      createdBy: messageThreads.createdBy,
    })
    .from(messageThreads)
    .where(and(eq(messageThreads.id, threadId), eq(messageThreads.agencyId, actor.agencyId)))
    .limit(1);
  if (!t) return null;
  const uid = actorUserId(actor);
  let participant = false;
  if (uid) {
    const [p] = await db
      .select({ id: threadParticipants.id })
      .from(threadParticipants)
      .where(
        and(
          eq(threadParticipants.agencyId, actor.agencyId),
          eq(threadParticipants.threadId, threadId),
          eq(threadParticipants.userId, uid),
        ),
      )
      .limit(1);
    participant = !!p;
  }
  return { agencyId: t.agencyId, ownerIds: [t.createdBy], assigned: participant };
}

/** Thread ids the user participates in (room sync). */
export async function participantThreadIds(agencyId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ threadId: threadParticipants.threadId })
    .from(threadParticipants)
    .where(and(eq(threadParticipants.agencyId, agencyId), eq(threadParticipants.userId, userId)));
  return rows.map((r) => r.threadId);
}
