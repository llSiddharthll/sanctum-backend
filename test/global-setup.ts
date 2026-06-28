import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { TEST_DB_DIR, TEST_DB_FILE, TEST_DB_URL, DRIZZLE_DIR } from './paths';

/**
 * Vitest global setup: builds a fresh, isolated SQLite database by replaying
 * the project's drizzle migrations, then seeds the plan catalog (so signup can
 * attach a subscription). Runs ONCE before the whole suite.
 */
export default async function setup() {
  // Fresh DB every run.
  rmSync(TEST_DB_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DB_DIR, { recursive: true });

  const db = createClient({ url: TEST_DB_URL });

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };

  for (const entry of journal.entries) {
    const sql = readFileSync(
      path.join(DRIZZLE_DIR, `${entry.tag}.sql`),
      'utf8',
    );
    for (const raw of sql.split('--> statement-breakpoint')) {
      const stmt = raw.trim();
      if (stmt) await db.execute(stmt);
    }
  }

  // Plan catalog — signup attaches the first plan (lowest sort_order) as a
  // trial subscription. Client/team caps are raised so integration suites can
  // create many fixtures in one tenant without hitting QUOTA_EXCEEDED; the AI
  // cap stays at 5 so the AI-quota test can still drive it to 402.
  await db.execute(
    `INSERT INTO sanctum_plans
       (id, name, max_clients, max_team_members, max_ai_generations, max_storage_bytes, price_cents_monthly, is_active, sort_order)
     VALUES
       ('studio','Studio',100000,100000,5,1099511627776,4900,1,1),
       ('agency','Agency',100000,100000,30,1099511627776,1,1,2)`,
  );

  db.close();
}
