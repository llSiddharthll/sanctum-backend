/**
 * Attendance, leave, regularization and checkout-request policy (design §D.6,
 * §G.2).
 *
 * Subject model: every attendance record and request has ONE subject user
 * (`userId`). `own` = the actor is that subject; `organization` = any subject in
 * the tenant. On top of scopes:
 *  - approver ≠ subject (no self-approval, owners included);
 *  - the subject must be MANAGEABLE by the approver / marker / canceller of
 *    someone else's request (§F.4: owners manage everyone but themselves;
 *    others only people with strictly less authority);
 *  - decided requests are immutable;
 *  - own cancel only while pending; cancelling an APPROVED leave needs
 *    `leaves.approve` on it (so never your own).
 */
import { and, eq, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { actorUserId, isClientSide, type Actor, type StaffActor } from '../actor.js';
import { holdsOwnerRole, isManageable } from '../admin.js';
import { check, type ObjectFacts } from '../engine.js';
import { assertCanManageUser, loadTarget, targetAuthority, type TargetUser } from '../user-admin.js';

export type RequestKind = 'leaves' | 'regularizations' | 'checkout_requests';

export interface RequestState {
  userId: string;
  status: string;
}

/** Facts for anything whose subject is `userId` (records, requests, reports). */
export function subjectFacts(agencyId: string, userId: string): ObjectFacts {
  return { agencyId, ownerIds: [userId] };
}

/**
 * SQL predicate restricting a subject `userId` column to what the actor may see
 * for `permission`: organization → every row (tenant filter is the caller's
 * job); own → the actor's rows; nothing → no rows.
 */
export function subjectScopeFilter(
  actor: Actor,
  permission: string,
  userIdColumn: AnyColumn,
): SQL {
  if (isClientSide(actor)) return sql`0`;
  const scopes = actor.grants.scopes(permission);
  if (scopes.includes('organization')) return sql`1`;
  const uid = actorUserId(actor);
  if (scopes.includes('own') && uid) return eq(userIdColumn, uid);
  return sql`0`;
}

/** The staff user `userId` in the actor's agency, or 404. */
export async function requireStaffSubject(actor: Actor, userId: string): Promise<TargetUser> {
  const t = await loadTarget(actor.agencyId, userId);
  if (t.kind !== 'staff') throw notFound('Member not found.');
  return t;
}

/**
 * Resolve an optional `?userId=` to the subject to read. Someone else requires
 * `permission` at a scope covering them (organization); the subject must be a
 * staff member of the tenant (404 otherwise).
 */
export async function resolveSubjectForRead(
  actor: StaffActor,
  permission: string,
  requested: string | undefined | null,
): Promise<string> {
  const userId = requested?.trim() || actor.userId;
  if (userId !== actor.userId) {
    await requireStaffSubject(actor, userId);
  }
  if (!check(actor, permission, subjectFacts(actor.agencyId, userId))) {
    throw forbidden(
      userId === actor.userId
        ? "You don't have permission to do that."
        : "You can only view your own records.",
    );
  }
  return userId;
}

/** Subset of `userIds` the actor may manage (never includes the actor). */
export async function manageableUserIds(actor: Actor, userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (actor.type !== 'staff') return out;
  const ids = [...new Set(userIds)].filter((id) => id && id !== actor.userId);
  if (!ids.length) return out;
  const [actorIsOwner, rows] = await Promise.all([
    holdsOwnerRole(actor.userId, actor.agencyId),
    db
      .select()
      .from(users)
      .where(and(eq(users.agencyId, actor.agencyId), inArray(users.id, ids))),
  ]);
  for (const t of rows) {
    if (actorIsOwner) {
      out.add(t.id);
      continue;
    }
    const a = await targetAuthority(t);
    if (
      isManageable({
        actorId: actor.userId,
        actorGrants: actor.grants,
        actorIsOwner,
        targetId: t.id,
        targetGrants: a.grants,
        targetIsOwner: a.isOwner,
      })
    ) {
      out.add(t.id);
    }
  }
  return out;
}

/** Throw 403 unless the actor may act on `userId` as an administrator. */
export async function assertCanManageSubject(actor: StaffActor, userId: string): Promise<void> {
  const target = await loadTarget(actor.agencyId, userId);
  try {
    await assertCanManageUser(actor, target);
  } catch {
    throw forbidden(
      "You can't do that for this person: they have as much access as you or more.",
    );
  }
}

/** Condition for `<kind>.approve`: reason string when denied, else true. */
export function decideCondition(actor: Actor, req: RequestState, manageable: boolean): true | string {
  if (req.userId === actorUserId(actor)) return "You can't approve or reject your own request.";
  if (!manageable) {
    return "You can't decide requests from someone with as much access as you or more.";
  }
  return true;
}

/** Permission gate + conditions for cancelling (see module doc). Pure. */
export function cancelDecision(
  kind: RequestKind,
  actor: Actor,
  req: RequestState,
  manageable: boolean,
): { ok: true } | { ok: false; status: 403 | 404 | 409; message: string } {
  const facts = subjectFacts(actor.agencyId, req.userId);
  const isSelf = req.userId === actorUserId(actor);
  if (!check(actor, `${kind}.cancel`, facts)) {
    return check(actor, `${kind}.view`, facts)
      ? { ok: false, status: 403, message: "You don't have permission to cancel this request." }
      : { ok: false, status: 404, message: 'Request not found.' };
  }
  if (req.status === 'pending') {
    if (!isSelf && !manageable) {
      return {
        ok: false,
        status: 403,
        message: "You can't cancel requests from someone with as much access as you or more.",
      };
    }
    return { ok: true };
  }
  if (kind === 'leaves' && req.status === 'approved') {
    if (isSelf) {
      return {
        ok: false,
        status: 403,
        message: 'Approved leave can only be cancelled by an approver.',
      };
    }
    if (!check(actor, 'leaves.approve', facts)) {
      return { ok: false, status: 403, message: 'Cancelling approved leave requires leave approval rights.' };
    }
    if (!manageable) {
      return {
        ok: false,
        status: 403,
        message: "You can't cancel leave for someone with as much access as you or more.",
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    status: 409,
    message: kind === 'leaves' ? 'This request can no longer be cancelled.' : 'Only pending requests can be cancelled.',
  };
}

/** Throwing variant of cancelDecision for handlers (404 / 403 / 409). */
export function assertCancelAllowed(
  kind: RequestKind,
  actor: Actor,
  req: RequestState,
  manageable: boolean,
): void {
  const d = cancelDecision(kind, actor, req, manageable);
  if (d.ok) return;
  if (d.status === 404) throw notFound(d.message);
  if (d.status === 409) throw conflict(d.message);
  throw forbidden(d.message);
}

/** `capabilities` for a request row, keyed by full permission key. */
export function requestCapabilities(
  kind: RequestKind,
  actor: Actor,
  req: RequestState,
  manageable: boolean,
): Record<string, boolean> {
  const facts = subjectFacts(actor.agencyId, req.userId);
  return {
    [`${kind}.approve`]:
      req.status === 'pending' &&
      check(actor, `${kind}.approve`, facts) &&
      decideCondition(actor, req, manageable) === true,
    [`${kind}.cancel`]: cancelDecision(kind, actor, req, manageable).ok,
  };
}
