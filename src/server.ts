import http from 'node:http';
import { createApp } from './app.js';
import { env } from './env.js';
import { ensurePragmas } from './db/client.js';
import { initSocket } from './realtime/socket.js';
import { startScheduler } from './services/scheduler.js';
import { migrateAllAgencies } from './authz/migrate-legacy.js';
import { purgeInvalidGrants, syncOwnerRoles } from './authz/roles-store.js';

async function main() {
  // Enable SQLite FK enforcement before serving traffic (best-effort).
  await ensurePragmas();

  // Authorization bootstrap (idempotent): migrate legacy RBAC for agencies that
  // haven't been migrated, keep Owner roles in sync with the catalog, and drop
  // grants for permissions that no longer exist (fail closed).
  const migrated = await migrateAllAgencies();
  await syncOwnerRoles();
  const purged = await purgeInvalidGrants();
  console.log(`[authz] migrated ${migrated} agencies, purged ${purged} invalid grants`);

  const app = createApp();
  const port = env.PORT;

  // Wrap Express in an http.Server so Socket.IO can share the same port.
  const httpServer = http.createServer(app);
  initSocket(httpServer);

  httpServer.listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[sanctum] listening on http://0.0.0.0:${port} (${env.NODE_ENV}) — REST + Socket.IO`,
    );
  });

  // Background schedules (monthly employee reports).
  startScheduler();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[sanctum] failed to start', err);
  process.exit(1);
});
