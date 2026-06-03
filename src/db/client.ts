import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { env } from '../env.js';
import * as schema from './schema.js';

/**
 * libSQL / Turso connection. FK enforcement is requested per the data model;
 * SQLite has FKs off by default. We enable it lazily on first use.
 */
export const libsql = createClient({
  url: env.TURSO_DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
});

let pragmaSet = false;
export async function ensurePragmas(): Promise<void> {
  if (pragmaSet) return;
  try {
    await libsql.execute('PRAGMA foreign_keys = ON;');
    pragmaSet = true;
  } catch {
    // Some hosted libSQL configs ignore per-connection pragmas; non-fatal.
    pragmaSet = true;
  }
}

export const db = drizzle(libsql, { schema });
export { schema };
export type DB = typeof db;
