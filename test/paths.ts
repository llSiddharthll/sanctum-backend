import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared, isolated test-database location (recreated fresh each run). */
const here = path.dirname(fileURLToPath(import.meta.url));
// SANCTUM_TEST_DB_DIR lets parallel runs (separate worktrees/agents) use isolated DBs.
export const TEST_DB_DIR = process.env.SANCTUM_TEST_DB_DIR
  ? path.resolve(process.env.SANCTUM_TEST_DB_DIR)
  : path.join(here, '..', '.test-data');
export const TEST_DB_FILE = path.join(TEST_DB_DIR, 'sanctum-test.db');
export const TEST_DB_URL = `file:${TEST_DB_FILE}`;
export const DRIZZLE_DIR = path.join(here, '..', 'src', 'drizzle');
