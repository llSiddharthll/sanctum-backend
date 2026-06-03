import crypto from 'node:crypto';

/** Short prefixed identifier, e.g. newId('post') -> 'post_aB3...'. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

/** Generate a raw opaque portal token (shown once) + its sha256 hash. */
export function newOpaqueToken(): { raw: string; hash: string } {
  const raw = `pzt_${crypto.randomBytes(24).toString('base64url')}`;
  const hash = hashToken(raw);
  return { raw, hash };
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Current period bucket 'YYYY-MM' (UTC). */
export function currentPeriod(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
