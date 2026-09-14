import crypto from 'node:crypto';
import { env } from '../env.js';

/**
 * AES-256-GCM application-side encryption for the credentials vault.
 * The DB stores ciphertext + iv + auth_tag only; the key lives in env.
 */
const KEY = Buffer.from(env.VAULT_ENC_KEY, 'base64'); // validated 32 bytes in env.ts
const KEY_VERSION = 1;

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export function encryptSecret(plaintext: string): SealedSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag, keyVersion: KEY_VERSION };
}

export function decryptSecret(sealed: {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, sealed.iv);
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([
    decipher.update(sealed.ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Seal a secret into one compact string ("v1.<iv>.<tag>.<ciphertext>",
 * base64url) for a TEXT column — used for OAuth tokens.
 */
export function sealToString(plaintext: string): string {
  const s = encryptSecret(plaintext);
  return [
    `v${s.keyVersion}`,
    s.iv.toString('base64url'),
    s.authTag.toString('base64url'),
    s.ciphertext.toString('base64url'),
  ].join('.');
}

export function unsealString(sealed: string): string {
  const [, iv, tag, ct] = sealed.split('.');
  if (!iv || !tag || !ct) throw new Error('Malformed sealed secret');
  return decryptSecret({
    iv: Buffer.from(iv, 'base64url'),
    authTag: Buffer.from(tag, 'base64url'),
    ciphertext: Buffer.from(ct, 'base64url'),
  });
}

/** Coerce a libSQL blob column (Buffer | Uint8Array | ArrayBuffer) to Buffer. */
export function toBuffer(v: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(v)) return v;
  return Buffer.from(v as Uint8Array);
}
