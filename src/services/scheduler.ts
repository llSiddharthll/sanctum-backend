import cron from 'node-cron';
import { db } from '../db/client.js';
import { agencies } from '../db/schema.js';
import { emailEmployeeReports } from './reports.js';
import { sweepStaleTimers } from '../routes/timers.js';
import { runMediaArchive } from './media-archive.js';
import { sweepEndedMonths } from './archive.js';
import { pullInvoices, refrensSyncEnabled, syncAgencyId } from './refrens-sync.js';
import { env } from '../env.js';

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

/** Email last month's per-employee reports for every agency. */
async function runMonthlyReports(): Promise<void> {
  const { from, to } = previousMonthRange(new Date());
  const rows = await db.select({ id: agencies.id }).from(agencies);
  for (const a of rows) {
    try {
      const r = await emailEmployeeReports(a.id, from, to);
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
  // people who forgot to stop the timer AND to check out).
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
  // after their archive copy to Drive succeeds.
  if (env.MEDIA_AUTODELETE_ENABLED) {
    cron.schedule('0 22 * * 0', () => {
      void runMediaArchive()
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
  if (refrensSyncEnabled()) {
    cron.schedule('*/15 * * * *', () => {
      void (async () => {
        const agencyId = await syncAgencyId();
        if (!agencyId) {
          console.warn('[refrens] skipped: could not resolve a single agency to sync into');
          return;
        }
        const r = await pullInvoices(agencyId);
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
}
