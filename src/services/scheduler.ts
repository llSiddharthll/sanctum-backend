import cron from 'node-cron';
import { db } from '../db/client.js';
import { agencies } from '../db/schema.js';
import { emailEmployeeReports } from './reports.js';
import { audit } from './audit.js';
import { actorAuditId, systemActor } from '../authz/actor.js';
import { sweepStaleTimers } from '../routes/timers.js';
import { runMediaArchive } from './media-archive.js';
import { sweepEndedMonths } from './archive.js';
import { pullInvoices, refrensSyncEnabled, syncAgencyId } from './refrens-sync.js';
import { env } from '../env.js';
import { runDuePublishing, socialPublishEnabled } from './social-publish.js';

/** Previous calendar month as {from:'YYYY-MM-01', to:'YYYY-MM-<last>'} (UTC). */
export function previousMonthRange(now: Date): { from: string; to: string } {
  const firstOfThis = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const lastOfPrev = new Date(firstOfThis.getTime() - 86_400_000);
  const py = lastOfPrev.getUTCFullYear();
  const pm = String(lastOfPrev.getUTCMonth() + 1).padStart(2, '0');
  return {
    from: `${py}-${pm}-01`,
    to: `${py}-${pm}-${String(lastOfPrev.getUTCDate()).padStart(2, '0')}`,
  };
}

/** Explicit, minimal grants of the monthly reports job (design §I.4). */
export const MONTHLY_REPORTS_GRANTS = [
  'attendance.view_reports',
  'attendance.email_reports',
  'time_logs.view',
  'tasks.view',
].map((permission) => ({ permission, scope: 'organization' as const }));

/**
 * Email last month's per-employee reports for every agency. Runs as a per-agency
 * system actor (never as a user) and is audited with actorType 'system'.
 */
export async function runMonthlyReports(now = new Date()): Promise<void> {
  const { from, to } = previousMonthRange(now);
  const rows = await db.select({ id: agencies.id }).from(agencies);
  for (const a of rows) {
    try {
      const actor = systemActor('monthly_reports', a.id, MONTHLY_REPORTS_GRANTS);
      const r = await emailEmployeeReports(actor, from, to);
      await audit({
        agencyId: a.id,
        actorType: actor.type,
        actorId: actorAuditId(actor),
        action: 'attendance.reports.emailed',
        entityType: 'agency',
        entityId: a.id,
        metadata: { from, to, ...r, job: actor.job },
      });
      console.log(
        `[reports] monthly ${from}..${to} agency=${a.id} employees=${r.employees} owners=${r.owners}`,
      );
    } catch (e) {
      console.error(`[reports] monthly failed agency=${a.id}`, e);
    }
  }
}

/**
 * Start background schedules. Currently: email each employee their monthly work
 * report (and owners the team overview) on the 1st of every month at 09:00 UTC.
 * Single fork (pm2) → fires once; a restart does not replay past fires.
 */
/** Archive incomplete tasks/posts from every fully-ended month (all agencies). */
async function runMonthArchiveSweep(reason: string): Promise<void> {
  try {
    const r = await sweepEndedMonths(new Date());
    if (r.tasks > 0 || r.posts > 0) {
      console.log(
        `[archive] ${reason}: archived ${r.tasks} task(s) + ${r.posts} post(s) from ended months`,
      );
    }
  } catch (e) {
    console.error(`[archive] ${reason} sweep failed`, e);
  }
}

export function startScheduler(): void {
  cron.schedule('0 9 1 * *', () => {
    void runMonthlyReports();
  });
  console.log('[scheduler] monthly employee reports scheduled (0 9 1 * *)');

  // 1st of the month at 00:15 UTC: sweep the just-ended month's incomplete
  // tasks/posts into the month-wise archive. Also backfill once at boot so any
  // already-ended months are cleaned up immediately (idempotent).
  cron.schedule('15 0 1 * *', () => {
    void runMonthArchiveSweep('monthly');
  });
  console.log('[scheduler] monthly archive sweep scheduled (15 0 1 * *)');
  // Backfill shortly after boot (delay so it doesn't slow startup).
  setTimeout(() => void runMonthArchiveSweep('startup backfill'), 20_000);

  // Every 15 min: auto-close timers left running past their shift end (for
  // people who forgot to stop the timer AND to check out). The sweep acts per
  // agency as systemActor('timer_sweep', agency, [time_logs.create:organization])
  // (routes/timers.ts) — never as the timer's owner — audited as 'system'.
  cron.schedule('*/15 * * * *', () => {
    void sweepStaleTimers()
      .then((n) => {
        if (n > 0) console.log(`[timers] shift-end sweep closed ${n} stale timer(s)`);
      })
      .catch((e) => console.error('[timers] shift-end sweep failed', e));
  });
  console.log('[scheduler] timer shift-end sweep scheduled (*/15 * * * *)');

  // Weekly (Sun 22:00): archive + delete self-hosted media past the retention
  // window. Off unless MEDIA_AUTODELETE_ENABLED — local files are only removed
  // after their archive copy to Drive succeeds. Runs as
  // systemActor('media-archive', agency, ['storage.archive']) per agency, only
  // within PLATFORM_AGENCY_ID when that is set; audited as actorType 'system'.
  if (env.MEDIA_AUTODELETE_ENABLED) {
    cron.schedule('0 22 * * 0', () => {
      void runMediaArchive({ agencyId: env.PLATFORM_AGENCY_ID })
        .then((r) => {
          if (r.archived > 0 || r.errors > 0) {
            console.log(
              `[media-archive] archived ${r.archived}, errors ${r.errors} (scanned ${r.scanned})`,
            );
          }
        })
        .catch((e) => console.error('[media-archive] run failed', e));
    });
    console.log('[scheduler] media archive scheduled (0 22 * * 0)');
  }

  // Every 15 min: pull invoices from Refrens (it has no webhooks, so polling is
  // the only option). Off unless REFRENS_SYNC_ENABLED and credentials are set.
  // Only for the agency bound to the credentials (REFRENS_AGENCY_ID), as
  // systemActor('refrens-pull', agency, [invoices.sync, invoices.create]);
  // every run is audited with actorType 'system'.
  if (refrensSyncEnabled()) {
    cron.schedule('*/15 * * * *', () => {
      void (async () => {
        const agencyId = await syncAgencyId();
        if (!agencyId) {
          console.warn('[refrens] skipped: REFRENS_AGENCY_ID is not set to an existing agency');
          return;
        }
        const actor = systemActor('refrens-pull', agencyId, [
          { permission: 'invoices.sync', scope: 'organization' },
          { permission: 'invoices.create', scope: 'organization' },
        ]);
        if (!actor.grants.has('invoices.sync') || !actor.grants.has('invoices.create')) return;
        const r = await pullInvoices(actor.agencyId);
        await audit({
          agencyId: actor.agencyId,
          actorType: actor.type,
          actorId: actorAuditId(actor),
          action: 'refrens.sync',
          entityType: 'agency',
          entityId: actor.agencyId,
          metadata: {
            job: actor.job,
            scanned: r.scanned,
            created: r.created,
            updated: r.updated,
            clientsCreated: r.clientsCreated,
            paymentsAdded: r.paymentsAdded,
            errors: r.errors.length,
          },
        });
        if (r.created || r.updated || r.errors.length) {
          console.log(
            `[refrens] pulled ${r.scanned}: +${r.created} new, ${r.updated} updated, ` +
              `${r.paymentsAdded} payments, ${r.clientsCreated} clients, ${r.errors.length} errors`,
          );
        }
      })().catch((e) => console.error('[refrens] sync failed', e));
    });
    console.log('[scheduler] Refrens invoice sync scheduled (*/15 * * * *)');
  }

  // Every 5 min: publish approved/scheduled posts that came due to the client's
  // connected Instagram / Facebook accounts. Off unless SOCIAL_PUBLISH_ENABLED
  // and the Meta app credentials are set. Runs as
  // systemActor('social-auto-publish', agency, ['posts.publish']) and only
  // publishes posts whose client approval is still valid; audited as 'system'.
  if (socialPublishEnabled()) {
    cron.schedule('*/5 * * * *', () => {
      void runDuePublishing()
        .then((r) => {
          if (r.published || r.failed || r.processing) {
            console.log(
              `[social] posts ${r.posts}: ${r.published} published, ${r.failed} failed, ${r.processing} processing`,
            );
          }
        })
        .catch((e) => console.error('[social] publish run failed', e));
    });
    console.log('[scheduler] social auto-publish scheduled (*/5 * * * *)');
  }
}
