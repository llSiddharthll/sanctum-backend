import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calendarReservations } from '../db/schema.js';
import { ok, created, param, toIso } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { broadcastPortalRefresh } from '../realtime/io.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize } from '../authz/engine.js';
import { clientFacts } from '../authz/policies/clients.js';
import { reservationFacts } from '../authz/policies/posts.js';
import { authorizeContentClient } from './posts.js';

/**
 * Reserved calendar days for a client (e.g. a shoot day). A reserved date shows
 * on the calendar and blocks tasks/posts there — publishing a calendar sheet
 * skips reserved dates. Reservations are governed by the posts permissions
 * (catalog: "posts & reservations").
 */
export const reservationsRouter = Router({ mergeParams: true });
reservationsRouter.use(authenticate);

// GET /clients/:clientId/reservations
reservationsRouter.get('/', requires('posts.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  await authorizeContentClient(actor, clientId, 'posts.view');
  const rows = await db
    .select()
    .from(calendarReservations)
    .where(
      and(
        eq(calendarReservations.agencyId, actor.agencyId),
        eq(calendarReservations.clientId, clientId),
      ),
    );
  ok(
    res,
    rows.map((r) => ({ id: r.id, date: toIso(r.date), label: r.label })),
  );
});

// POST /clients/:clientId/reservations
const createSchema = z.object({
  date: z.coerce.date(),
  label: z.string().trim().max(120).optional(),
});
reservationsRouter.post('/', requires('posts.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  await authorizeContentClient(actor, clientId, 'posts.create');
  const body = createSchema.parse(req.body);
  const id = newId('rsv');
  const label = body.label?.trim() || 'Reserved';
  await db.insert(calendarReservations).values({
    id,
    agencyId: actor.agencyId,
    clientId,
    date: body.date,
    label,
    createdBy: actor.userId,
  });
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'reservation.create',
    entityType: 'reservation',
    entityId: id,
    ip: req.ip,
  });
  broadcastPortalRefresh(clientId);
  created(res, { id, date: body.date.toISOString(), label });
});

// DELETE /clients/:clientId/reservations/:id — the reservation must belong to
// the URL client (and agency); otherwise 404.
reservationsRouter.delete('/:id', requires('posts.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const client = await clientFacts(actor, clientId);
  const loaded = client ? await reservationFacts(actor, clientId, param(req, 'id'), client) : null;
  if (!loaded) throw notFound('Reservation not found.');
  authorize(actor, 'posts.delete', loaded.facts, { view: 'posts.view' });
  await db
    .delete(calendarReservations)
    .where(
      and(
        eq(calendarReservations.id, loaded.row.id),
        eq(calendarReservations.agencyId, actor.agencyId),
        eq(calendarReservations.clientId, clientId),
      ),
    );
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'reservation.delete',
    entityType: 'reservation',
    entityId: loaded.row.id,
    ip: req.ip,
  });
  broadcastPortalRefresh(clientId);
  ok(res, { deleted: true });
});
