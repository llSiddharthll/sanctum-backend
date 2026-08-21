import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import * as cloudinary from './cloudinary.js';
import * as r2 from './r2.js';
import * as local from './local-storage.js';

/**
 * Upload-storage abstraction. `STORAGE_DRIVER` selects Cloudinary (legacy) or
 * Cloudflare R2. New uploads follow the driver; deletes route by the stored URL
 * so old Cloudinary assets and new R2 assets both clean up correctly during a
 * transition.
 */

export const MAX_UPLOAD_BYTES = 104_857_600; // 100 MB
const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'pdf'];

/** Lower-cased file extension WITH a leading dot, or '' when unknown. */
function extOf(filename?: string): string {
  if (!filename) return '';
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(filename.trim());
  return m ? `.${m[1].toLowerCase()}` : '';
}

const cleanCt = (ct?: string) => (ct && ct.trim() ? ct.trim() : 'application/octet-stream');

export interface MediaSignInput {
  agencyId: string;
  clientId: string;
  postId?: string;
  resourceType: 'image' | 'video';
  filename?: string;
  contentType?: string;
  /** Origin the browser reaches the local upload endpoint at (STORAGE_DRIVER=local). */
  uploadBase?: string;
}

/** Sign a content-post media upload (Clients module). */
export async function signMediaUpload(input: MediaSignInput) {
  const base = `agency/${input.agencyId}/client/${input.clientId}/post`;
  const folder = input.postId ? `${base}/${input.postId}` : `${base}/_staging`;

  if (env.STORAGE_DRIVER === 'local') {
    const key = `${folder}/${newId('media')}${extOf(input.filename)}`;
    return {
      ...local.presignLocalPut(
        key,
        cleanCt(input.contentType),
        input.uploadBase ?? '',
      ),
      resourceType: input.resourceType,
    };
  }
  if (env.STORAGE_DRIVER === 'r2') {
    const key = `${folder}/${newId('media')}${extOf(input.filename)}`;
    const presigned = await r2.presignPut(
      key,
      cleanCt(input.contentType),
      MAX_UPLOAD_BYTES,
    );
    return { ...presigned, resourceType: input.resourceType };
  }
  return {
    driver: 'cloudinary' as const,
    ...cloudinary.signUpload({
      agencyId: input.agencyId,
      clientId: input.clientId,
      postId: input.postId,
      resourceType: input.resourceType,
    }),
  };
}

export interface DocSignInput {
  agencyId: string;
  folder: string;
  filename?: string;
  contentType?: string;
  /** Origin the browser reaches the local upload endpoint at (STORAGE_DRIVER=local). */
  uploadBase?: string;
}

/** Sign a Documents-hub / message-attachment upload (agency-scoped). */
export async function signDocumentUpload(input: DocSignInput) {
  if (env.STORAGE_DRIVER === 'local') {
    const key = `${input.folder}/${newId('doc')}${extOf(input.filename)}`;
    return local.presignLocalPut(
      key,
      cleanCt(input.contentType),
      input.uploadBase ?? '',
    );
  }
  if (env.STORAGE_DRIVER === 'r2') {
    const key = `${input.folder}/${newId('doc')}${extOf(input.filename)}`;
    const presigned = await r2.presignPut(
      key,
      cleanCt(input.contentType),
      MAX_UPLOAD_BYTES,
    );
    return presigned;
  }
  return {
    driver: 'cloudinary' as const,
    ...cloudinary.signDocumentUpload({
      agencyId: input.agencyId,
      folder: input.folder,
    }),
  };
}

/**
 * Delete a stored asset. Routes by the asset's URL so a mixed store (old
 * Cloudinary + new R2) cleans up correctly regardless of the current driver.
 * `publicId` is the Cloudinary public_id or the R2 object key.
 */
export async function deleteAsset(opts: {
  publicId: string;
  secureUrl?: string | null;
  resourceType?: 'image' | 'video' | 'raw';
}): Promise<void> {
  const url = opts.secureUrl ?? '';
  if (url.includes('cloudinary.com')) {
    await cloudinary.destroyAsset(opts.publicId, opts.resourceType ?? 'image');
    return;
  }
  if (url.includes('.r2.dev') || url.includes('r2.cloudflarestorage.com')) {
    await r2.deleteObject(opts.publicId);
    return;
  }
  // Otherwise a self-hosted object (publicId is the on-disk key). Falls through
  // here for local URLs and any non-cloud URL.
  await local.deleteObjectLocal(opts.publicId);
}

export { ALLOWED_FORMATS };
