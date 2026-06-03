import 'dotenv/config';
import { z } from 'zod';

/**
 * Zod-validated process.env. Fails fast on boot if required vars are missing
 * or malformed, so the server never starts in a half-configured state.
 */
const envSchema = z.object({
  // Runtime
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  // CORS
  FRONTEND_ORIGIN: z.string().url(),

  // Table prefixing (collision-safety). Default "sanctum_". "" allowed.
  TABLE_PREFIX: z.string().default('sanctum_'),

  // Database (Turso / libSQL)
  TURSO_DATABASE_URL: z.string().min(1, 'TURSO_DATABASE_URL is required'),
  TURSO_AUTH_TOKEN: z.string().min(1, 'TURSO_AUTH_TOKEN is required'),

  // Auth / JWT
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),

  // Credentials vault encryption — base64 of exactly 32 bytes
  VAULT_ENC_KEY: z
    .string()
    .min(1, 'VAULT_ENC_KEY is required')
    .refine(
      (val) => {
        try {
          return Buffer.from(val, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      { message: 'VAULT_ENC_KEY must be base64 of exactly 32 bytes' },
    ),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  // Gemini (Google Generative Language) — primary AI provider.
  // Optional: when absent, AI generation falls back to a deterministic
  // local template generator instead of failing.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-flash-latest'),

  // Which provider to prefer. 'gemini' is the only live provider; any other
  // value forces the deterministic fallback. Kept for forward-compat.
  AI_PROVIDER: z.string().default('gemini'),

  // Anthropic — optional, retained for back-compat. No longer the default
  // provider; present so older .env files keep validating.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** Convenience flags. */
export const isProd = env.NODE_ENV === 'production';
/**
 * True when a live AI provider is configured. With Gemini as the primary
 * provider this is keyed on GEMINI_API_KEY. When false, AI generation still
 * succeeds via the deterministic local fallback (it never returns 501).
 */
export const aiEnabled = Boolean(env.GEMINI_API_KEY);
