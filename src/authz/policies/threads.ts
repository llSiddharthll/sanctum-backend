/**
 * Message thread policy. `assigned` = the actor participates in the thread;
 * `own` = the actor created it. Used by REST (messages router) and realtime.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { messages, messageThreads, threadParticipants } from '../../db/schema.js';
import type { Actor } from '../actor.js';
import { actorUserId } from '../actor.js';
import { canOrg, check, type ObjectFacts } from '../engine.js';

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

/**
 * A thread operation is allowed only when the actor participates in the
 * thread, or holds `permission` at organization scope (moderation).
 */
export function participantOrModerator(actor: Actor, facts: ObjectFacts, permission: string): boolean {
  return facts.assigned === true || canOrg(actor, permission);
}

/** Capability keys attached to thread objects. */
export const THREAD_CAPABILITIES = [
  'messages.send',
  'messages.pin',
  'threads.update',
  'threads.manage_participants',
  'threads.delete',
] as const;

/** Capability keys attached to message objects. */
export const MESSAGE_CAPABILITIES = ['messages.update', 'messages.delete', 'messages.pin'] as const;

/** Capabilities with the participant rule applied (engine scope ∧ participant/moderator). */
export function threadCapabilities(
  actor: Actor,
  facts: ObjectFacts,
  permissions: readonly string[] = THREAD_CAPABILITIES,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of permissions) {
    out[p] = check(actor, p, facts) && participantOrModerator(actor, facts, p);
  }
  return out;
}

/** Facts for a message relative to its thread's facts (`own` = sender). */
export function messageFactsFrom(thread: ObjectFacts, senderId: string | null): ObjectFacts {
  return { agencyId: thread.agencyId, ownerIds: [senderId], assigned: thread.assigned };
}

/**
 * Facts for a message bound to its URL thread (null when either is missing in
 * the actor's agency or the message belongs to another thread).
 */
export async function messageFacts(
  actor: Actor,
  threadId: string,
  messageId: string,
): Promise<{ thread: ObjectFacts; message: ObjectFacts } | null> {
  const thread = await threadFacts(actor, threadId);
  if (!thread) return null;
  const [m] = await db
    .select({ senderId: messages.senderId })
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.threadId, threadId),
        eq(messages.agencyId, actor.agencyId),
      ),
    )
    .limit(1);
  if (!m) return null;
  return { thread, message: messageFactsFrom(thread, m.senderId) };
}
