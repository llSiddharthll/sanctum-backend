/**
 * Bridge: a client's discussion on the content calendar → the team's Messages.
 *
 * When a client comments on a content post (in the portal / logged-in client
 * area), mirror it into that client's internal "Content discussion" group thread
 * so EVERY teammate working on the client — owner + client-assigned staff +
 * members of the client's projects, not just whoever reviews the calendar — sees
 * it in Messages, can carry the conversation there, and gets a notification.
 */
import { and, eq, inArray, like, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  messageThreads,
  threadParticipants,
  users,
  clients,
  projects,
  projectMembers,
  clientAssignments,
  contentPosts,
} from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { createMessage } from './messages.js';
import { notifyMany } from './notifications.js';

const DISCUSSION_PREFIX = 'Content discussion';

/**
 * Active agency STAFF working on a client: owners + client-assigned staff +
 * members of any of the client's projects. Client-role users are excluded.
 */
async function workingStaffForClient(
  agencyId: string,
  clientId: string,
): Promise<string[]> {
  const [owners, assigned, projs] = await Promise.all([
    db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.agencyId, agencyId),
          eq(users.role, 'owner'),
          eq(users.status, 'active'),
        ),
      ),
    db
      .select({ userId: clientAssignments.userId })
      .from(clientAssignments)
      .where(
        and(
          eq(clientAssignments.agencyId, agencyId),
          eq(clientAssignments.clientId, clientId),
        ),
      ),
    db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.agencyId, agencyId), eq(projects.clientId, clientId)),
      ),
  ]);

  const projectIds = projs.map((p) => p.id);
  const projMembers = projectIds.length
    ? await db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.agencyId, agencyId),
            inArray(projectMembers.projectId, projectIds),
          ),
        )
    : [];

  const candidate = Array.from(
    new Set([
      ...owners.map((o) => o.id),
      ...assigned.map((a) => a.userId),
      ...projMembers.map((m) => m.userId),
    ]),
  );
  if (candidate.length === 0) return [];

  // Keep only active agency staff (never client-login users).
  const staff = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.agencyId, agencyId),
        inArray(users.id, candidate),
        ne(users.role, 'client'),
        eq(users.status, 'active'),
      ),
    );
  return staff.map((s) => s.id);
}

export async function mirrorClientPostComment(opts: {
  agencyId: string;
  clientId: string | null;
  postId: string;
  authorName: string;
  body: string;
}): Promise<void> {
  const { agencyId, clientId, postId, authorName } = opts;
  if (!clientId) return;

  try {
    const members = await workingStaffForClient(agencyId, clientId);
    if (members.length === 0) return;

    // The mirrored message is posted "by" an owner (a real thread participant);
    // its text makes clear it's the client speaking.
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.agencyId, agencyId),
          eq(users.role, 'owner'),
          eq(users.status, 'active'),
        ),
      )
      .limit(1);
    const authorId = owner?.id ?? members[0];

    const [brand] = await db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    const clientName = brand?.name ?? 'Client';
    const [post] = await db
      .select({ caption: contentPosts.caption })
      .from(contentPosts)
      .where(eq(contentPosts.id, postId))
      .limit(1);
    const caption = (post?.caption ?? '').replace(/\s+/g, ' ').trim();

    // Find (or open) the client's content-discussion group.
    const [existing] = await db
      .select({ id: messageThreads.id })
      .from(messageThreads)
      .where(
        and(
          eq(messageThreads.agencyId, agencyId),
          eq(messageThreads.clientId, clientId),
          like(messageThreads.subject, `${DISCUSSION_PREFIX}%`),
        ),
      )
      .limit(1);

    let threadId: string;
    if (existing) {
      threadId = existing.id;
      // Fold in anyone newly working on the client.
      const current = await db
        .select({ userId: threadParticipants.userId })
        .from(threadParticipants)
        .where(eq(threadParticipants.threadId, threadId));
      const have = new Set(current.map((c) => c.userId));
      const missing = members.filter((u) => !have.has(u));
      if (missing.length) {
        await db.insert(threadParticipants).values(
          missing.map((uid) => ({
            id: newId('tpt'),
            agencyId,
            threadId,
            userId: uid,
          })),
        );
      }
    } else {
      threadId = newId('thr');
      await db.insert(messageThreads).values({
        id: threadId,
        agencyId,
        subject: `${DISCUSSION_PREFIX} · ${clientName}`,
        clientId,
        createdBy: authorId,
      });
      await db.insert(threadParticipants).values(
        members.map((uid) => ({
          id: newId('tpt'),
          agencyId,
          threadId,
          userId: uid,
        })),
      );
    }

    const text = caption
      ? `💬 ${authorName} commented on “${caption.slice(0, 90)}”:\n${opts.body.trim()}`
      : `💬 ${authorName} commented:\n${opts.body.trim()}`;
    await createMessage(agencyId, authorId, threadId, text);

    // The message broadcast only alerts @mentions — notify every working member
    // so nobody misses a client comment (the whole point of the request).
    await notifyMany(members, {
      agencyId,
      type: 'client.discussion',
      title: `${clientName}: ${authorName} commented`,
      body: opts.body.trim().slice(0, 120),
      entityType: 'thread',
      entityId: threadId,
      link: '/messages',
    });
  } catch {
    // Mirroring is best-effort — never break the client's comment on failure.
  }
}
