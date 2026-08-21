import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';

/**
 * Cloudflare R2 storage driver (S3-compatible). Files are uploaded directly
 * from the browser via a presigned PUT URL, and served from the bucket's public
 * base URL. Cheap bulk storage with zero egress — the replacement for Cloudinary
 * as the upload store.
 */

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) {
    if (
      !env.R2_ACCOUNT_ID ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY ||
      !env.R2_BUCKET ||
      !env.R2_PUBLIC_BASE_URL
    ) {
      throw new Error(
        'R2 storage is not configured (set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL).',
      );
    }
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

/** Public URL an object with the given key is served from. */
export function publicUrlFor(key: string): string {
  const base = (env.R2_PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  return `${base}/${key}`;
}

export interface PresignedPut {
  driver: 'r2';
  method: 'PUT';
  uploadUrl: string;
  key: string;
  publicUrl: string;
  contentType: string;
  maxBytes: number;
  expiresAt: string;
}

/**
 * Presign a direct browser PUT upload. The browser must send the SAME
 * `Content-Type` header it was signed with. The object is public-read via the
 * bucket's public base URL (set up in the Cloudflare dashboard).
 */
export async function presignPut(
  key: string,
  contentType: string,
  maxBytes: number,
): Promise<PresignedPut> {
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(s3(), cmd, { expiresIn: 3600 });
  return {
    driver: 'r2',
    method: 'PUT',
    uploadUrl,
    key,
    publicUrl: publicUrlFor(key),
    contentType,
    maxBytes,
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  };
}

/** Best-effort delete of an object by key (non-fatal on failure). */
export async function deleteObject(key: string): Promise<void> {
  try {
    await s3().send(
      new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
    );
  } catch {
    // non-fatal — reconciliation can clean up later
  }
}
