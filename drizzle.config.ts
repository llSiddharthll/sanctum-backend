import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config. Generates migration SQL into src/drizzle from the
 * schema. NOTE: only `drizzle-kit generate` is used here — never run
 * `migrate`/`push` against the shared production DB from this repo.
 */
export default defineConfig({
  dialect: 'turso',
  schema: './src/db/schema.ts',
  out: './src/drizzle',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? 'libsql://placeholder.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
  verbose: true,
  strict: true,
});
