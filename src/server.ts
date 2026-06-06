import http from 'node:http';
import { createApp } from './app.js';
import { env } from './env.js';
import { ensurePragmas } from './db/client.js';
import { initSocket } from './realtime/socket.js';

async function main() {
  // Enable SQLite FK enforcement before serving traffic (best-effort).
  await ensurePragmas();

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
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[sanctum] failed to start', err);
  process.exit(1);
});
