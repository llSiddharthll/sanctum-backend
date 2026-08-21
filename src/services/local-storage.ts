import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../env.js';

/**
 * Self-hosted ("local") storage driver. Files live under MEDIA_DIR on the box's
 * own disk and are served by nginx (prod) or express.static (dev). The browser
 * uploads through the backend's PUT /uploads/local endpoint, authorised by a
 * short-lived HMAC token that binds the object key + expiry (no session needed,
 * like a presigned URL). Images get light-loss compression on the way in.
 */

const MAX_BYTES = 104_857_600; // 100 MB

function mediaRoot(): string {
  return path.resolve(env.MEDIA_DIR);
}

/** Reject path-traversal; keys are server-generated but the token carries them. */
function safeKey(key: string): string {
  const norm = key.replace(/^\/+/, '');
  if (!norm || norm.includes('..') || norm.includes('\0')) {
    throw new Error('Invalid object key');
  }
  return norm;
}

// ---- upload token (HMAC over key + expiry) ----
function sign(key: string, exp: number): string {
  return crypto
    .createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`${key}.${exp}`)
    .digest('base64url');
}

export function verifyUploadToken(key: string, exp: number, sig: string): boolean {
  if (!key || !exp || !sig || Date.now() > exp) return false;
  const expected = sign(key, exp);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export interface LocalPresign {
  driver: 'local';
  method: 'PUT';
  uploadUrl: string;
  key: string;
  publicUrl: string;
  contentType: string;
  maxBytes: number;
  expiresAt: string;
}

/** Public URL a key is served from (MEDIA_PUBLIC_BASE, or <origin>/files). */
export function publicUrlFor(key: string, origin?: string): string {
  const base = (
    env.MEDIA_PUBLIC_BASE ??
    (origin ? `${origin.replace(/\/$/, '')}/files` : '/files')
  ).replace(/\/$/, '');
  return `${base}/${safeKey(key)}`;
}

/** Origin (scheme+host) the browser reaches this server at, for upload/serve URLs. */
export function uploadOrigin(req: {
  protocol: string;
  get(name: string): string | undefined;
}): string {
  return env.MEDIA_UPLOAD_BASE ?? `${req.protocol}://${req.get('host')}`;
}

export function presignLocalPut(
  key: string,
  contentType: string,
  origin: string,
): LocalPresign {
  const exp = Date.now() + 3600 * 1000;
  const sig = sign(key, exp);
  const base = origin.replace(/\/$/, '');
  const uploadUrl = `${base}/uploads/local?key=${encodeURIComponent(key)}&exp=${exp}&sig=${encodeURIComponent(sig)}`;
  return {
    driver: 'local',
    method: 'PUT',
    uploadUrl,
    key,
    publicUrl: publicUrlFor(key, origin),
    contentType,
    maxBytes: MAX_BYTES,
    expiresAt: new Date(exp).toISOString(),
  };
}

/** Write bytes to MEDIA_DIR/<key> (creating parent dirs). */
export async function writeObject(key: string, data: Buffer): Promise<void> {
  const full = path.join(mediaRoot(), safeKey(key));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data, { mode: 0o644 });
}

/** Best-effort delete of a stored object by key (non-fatal). */
export async function deleteObjectLocal(key: string): Promise<void> {
  try {
    await fs.unlink(path.join(mediaRoot(), safeKey(key)));
  } catch {
    // non-fatal — already gone / archived
  }
}

export interface CompressResult {
  buffer: Buffer;
  width?: number;
  height?: number;
}

/**
 * Light-loss compression for still images (JPEG/PNG/WebP): auto-orient, cap the
 * long edge at 2200px, and re-encode the SAME format at ~82% quality. Returns
 * null for anything else (GIF/SVG/video → stored as-is), or if the result isn't
 * actually smaller. Never throws — a failure just stores the original.
 */
export async function compressImage(
  buffer: Buffer,
  contentType: string,
): Promise<CompressResult | null> {
  if (!contentType.startsWith('image/')) return null;
  try {
    const img = sharp(buffer, { failOn: 'none' }).rotate();
    const meta = await img.metadata();
    const fmt = meta.format;
    if (fmt !== 'jpeg' && fmt !== 'png' && fmt !== 'webp') return null;

    let p = img;
    if ((meta.width ?? 0) > 2200 || (meta.height ?? 0) > 2200) {
      p = p.resize({
        width: 2200,
        height: 2200,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    if (fmt === 'png') p = p.png({ quality: 82, compressionLevel: 9, palette: true });
    else if (fmt === 'webp') p = p.webp({ quality: 82 });
    else p = p.jpeg({ quality: 82, mozjpeg: true });

    const out = await p.toBuffer({ resolveWithObject: true });
    if (out.data.length >= buffer.length) {
      return { buffer, width: meta.width, height: meta.height };
    }
    return { buffer: out.data, width: out.info.width, height: out.info.height };
  } catch {
    return null;
  }
}

export { MAX_BYTES as LOCAL_MAX_BYTES };
