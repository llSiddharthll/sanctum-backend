import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calendarReservations } from '../db/schema.js';
import { ok, created, param, toIso } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth, requireClientAccess } from '../middleware/tenant.js';
import { broadcastPortalRefresh } from '../realtime/io.js';

/**
 * Reserved calendar days for a client (e.g. a shoot day). A reserved date shows
 * on the calendar and blocks tasks/posts there — publishing a calendar sheet
 * skips reserved dates.
 */
export const reservationsRouter = Router({ mergeParams: true });
reservationsRouter.use(requireAuth);
reservationsRouter.use(requireModuleRW('clients'));

// GET /clients/:clientId/reservations
reservationsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const rows = await db
    .select()
    .from(calendarReservations)
    .where(
      and(
        eq(calendarReservations.agencyId, ctx.agencyId),
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
reservationsRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const body = createSchema.parse(req.body);
  const id = newId('rsv');
  const label = body.label?.trim() || 'Reserved';
  await db.insert(calendarReservations).values({
    id,
    agencyId: ctx.agencyId,
    clientId,
    date: body.date,
    label,
    createdBy: ctx.userId,
  });
  broadcastPortalRefresh(clientId);
  created(res, { id, date: body.date.toISOString(), label });
});

// DELETE /clients/:clientId/reservations/:id
reservationsRouter.delete('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  await db
    .delete(calendarReservations)
    .where(
      and(
        eq(calendarReservations.id, param(req, 'id')),
        eq(calendarReservations.agencyId, ctx.agencyId),
      ),
    );
  broadcastPortalRefresh(clientId);
  ok(res, { deleted: true });
});
