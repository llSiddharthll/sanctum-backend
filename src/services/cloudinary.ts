import { v2 as cloudinary } from 'cloudinary';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov'];
const MAX_BYTES = 104_857_600; // 100 MB

export interface SignParams {
  agencyId: string;
  clientId: string;
  postId?: string;
  resourceType: 'image' | 'video';
}

export interface SignedUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  publicId: string;
  resourceType: 'image' | 'video';
  uploadUrl: string;
  allowedFormats: string[];
  maxBytes: number;
  expiresAt: string;
}

/**
 * Build a Cloudinary signed-upload payload. The folder is forced server-side
 * to a tenant path so a client cannot overwrite another tenant's assets.
 * The browser POSTs the file + these params directly to Cloudinary.
 */
export function signUpload(params: SignParams): SignedUpload {
  const timestamp = Math.floor(Date.now() / 1000);
  const base = `agency/${params.agencyId}/client/${params.clientId}/post`;
  const folder = params.postId
    ? `${base}/${params.postId}`
    : `${base}/_staging`;
  // Server-assigned asset id (stored at `folder/publicId`). The browser sends
  // it back as `public_id`, so it MUST be part of the signed param set below —
  // otherwise Cloudinary rejects the upload with "Invalid Signature".
  const publicId = newId('media');

  // Parameters that are signed must match exactly what the client sends.
  const paramsToSign: Record<string, string | number> = {
    folder,
    public_id: publicId,
    timestamp,
  };

  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    env.CLOUDINARY_API_SECRET,
  );

  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder,
    publicId,
    resourceType: params.resourceType,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${params.resourceType}/upload`,
    allowedFormats: ALLOWED_FORMATS,
    maxBytes: MAX_BYTES,
    expiresAt: new Date((timestamp + 3600) * 1000).toISOString(),
  };
}

/** Best-effort delete of an asset (used on media/post removal). */
export async function destroyAsset(
  publicId: string,
  resourceType: 'image' | 'raw' | 'video',
): Promise<void> {
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });
  } catch {
    // non-fatal — reconciliation can clean up later
  }
}

export interface DocumentSignParams {
  agencyId: string;
  folder: string;
}

export interface SignedDocumentUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
}

/**
 * Build a Cloudinary signed-upload payload for the Documents hub. The folder is
 * supplied by the caller (forced server-side to a tenant path) and signed
 * together with the timestamp — EXACTLY the same scheme as signUpload() above.
 * The browser POSTs the file + these params directly to Cloudinary's
 * /auto/upload endpoint.
 */
export function signDocumentUpload(
  params: DocumentSignParams,
): SignedDocumentUpload {
  const timestamp = Math.floor(Date.now() / 1000);

  // Parameters that are signed must match exactly what the client sends.
  const paramsToSign: Record<string, string | number> = {
    folder: params.folder,
    timestamp,
  };

  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    env.CLOUDINARY_API_SECRET,
  );

  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder: params.folder,
  };
}

export { cloudinary };
