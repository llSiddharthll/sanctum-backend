import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { TEST_DB_URL } from './test/paths';

/**
 * Resolve TypeScript's NodeNext `.js` import specifiers to their `.ts` source
 * when running through Vite/esbuild (the source uses `import './x.js'` but the
 * file on disk is `x.ts`).
 */
function jsToTs() {
  return {
    name: 'sanctum-js-to-ts',
    enforce: 'pre' as const,
    async resolveId(source: string, importer: string | undefined) {
      if (
        importer &&
        source.endsWith('.js') &&
        (source.startsWith('./') || source.startsWith('../'))
      ) {
        const candidate = path.resolve(
          path.dirname(importer),
          source.replace(/\.js$/, '.ts'),
        );
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [jsToTs()],
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Integration tests share one migrated SQLite file → run in a single
    // process, serially, to avoid file-lock contention.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Pre-set before any source import so env.ts (dotenv, override:false) keeps
    // these and never points at the real Turso DB or sends real email/AI calls.
    env: {
      NODE_ENV: 'test',
      TURSO_DATABASE_URL: TEST_DB_URL,
      TURSO_AUTH_TOKEN: 'test-token',
      TABLE_PREFIX: 'sanctum_',
      FRONTEND_ORIGIN: 'http://localhost:3000',
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789-abcdefghij',
      JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789-abcdefghij',
      // base64 of 32 bytes (0x41 * 32)
      VAULT_ENC_KEY: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-key',
      CLOUDINARY_API_SECRET: 'test-secret',
      EMAIL_USER: '',
      EMAIL_PASS: '',
      GEMINI_API_KEY: '',
    },
  },
});
