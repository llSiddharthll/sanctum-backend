import cron from 'node-cron';
import { db } from '../db/client.js';
import { agencies } from '../db/schema.js';
import { emailEmployeeReports } from './reports.js';
import { sweepStaleTimers } from '../routes/timers.js';

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
export function startScheduler(): void {
  cron.schedule('0 9 1 * *', () => {
    void runMonthlyReports();
  });
  console.log('[scheduler] monthly employee reports scheduled (0 9 1 * *)');

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
}
