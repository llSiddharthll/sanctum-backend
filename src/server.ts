import { createApp } from './app.js';
import { env } from './env.js';
import { ensurePragmas } from './db/client.js';

async function main() {
  // Enable SQLite FK enforcement before serving traffic (best-effort).
  await ensurePragmas();

  const app = createApp();
  const port = env.PORT;

  app.listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[sanctum] listening on http://0.0.0.0:${port} (${env.NODE_ENV})`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[sanctum] failed to start', err);
  process.exit(1);
});
