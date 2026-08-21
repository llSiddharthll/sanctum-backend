import { Router } from 'express';
import express from 'express';
import { ok } from '../lib/http.js';
import {
  verifyUploadToken,
  writeObject,
  compressImage,
  publicUrlFor,
  uploadOrigin,
  LOCAL_MAX_BYTES,
} from '../services/local-storage.js';

/**
 * Self-hosted upload endpoint (STORAGE_DRIVER=local). The browser PUTs the raw
 * file bytes here, authorised by the short-lived HMAC token in the query (bound
 * to the object key + expiry) — no session cookie/bearer needed, mirroring a
 * presigned URL. Mounted at app root (/uploads) so it isn't under the module-
 * gated /api/v1 surface. Images get light-loss compression on the way in.
 */
export const uploadsRouter = Router();

uploadsRouter.put(
  '/local',
  express.raw({ type: () => true, limit: `${LOCAL_MAX_BYTES + 5_000_000}` }),
  async (req, res) => {
    const key = String(req.query.key ?? '');
    const exp = Number(req.query.exp ?? 0);
    const sig = String(req.query.sig ?? '');
    if (!verifyUploadToken(key, exp, sig)) {
      res
        .status(403)
        .json({ error: { code: 'FORBIDDEN', message: 'Invalid or expired upload token.' } });
      return;
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res
        .status(400)
        .json({ error: { code: 'BAD_REQUEST', message: 'Empty upload body.' } });
      return;
    }

    const contentType =
      (req.headers['content-type'] as string) || 'application/octet-stream';

    // Light-loss compression for still images; everything else stored as-is.
    let bytes = body;
    let width: number | undefined;
    let height: number | undefined;
    const compressed = await compressImage(body, contentType);
    if (compressed) {
      bytes = compressed.buffer;
      width = compressed.width;
      height = compressed.height;
    }

    try {
      await writeObject(key, bytes);
    } catch {
      res
        .status(400)
        .json({ error: { code: 'BAD_REQUEST', message: 'Could not store the file.' } });
      return;
    }

    ok(res, {
      key,
      publicUrl: publicUrlFor(key, uploadOrigin(req)),
      bytes: bytes.length,
      width,
      height,
    });
  },
);
