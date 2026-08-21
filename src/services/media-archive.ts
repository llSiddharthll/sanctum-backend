import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, postMedia, clients } from '../db/schema.js';
import { env } from '../env.js';
import { deleteObjectLocal } from './local-storage.js';

/**
 * Media retention / archival. Self-hosted files older than MEDIA_RETENTION_DAYS
 * are COPIED to a permanent, month-wise + client-organised archive on the backup
 * remote (Drive, else GCS), then removed from the local disk and flagged
 * `archived` (the UI then shows a "contact us to restore" state). The local file
 * is only deleted AFTER the archive copy succeeds — so nothing is ever lost.
 */

const execFileAsync = promisify(execFile);
const GCS_BUCKET = 'sanctum-media-backup-701ed07f';

function sanitize(s: string): string {
  return (s || '').replace(/[^\w.\- ]+/g, '_').trim().slice(0, 80) || '_';
}
function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** Self-hosted objects are served from /files/… and are not Cloudinary URLs. */
function isSelfHosted(url: string): boolean {
  return /\/files\//.test(url) && !/cloudinary\.com/.test(url);
}

let cachedRemote: string | null | undefined;
async function backupRemote(): Promise<string | null> {
  if (cachedRemote !== undefined) return cachedRemote;
  try {
    const { stdout } = await execFileAsync('rclone', ['listremotes']);
    cachedRemote = /^gdrive:/m.test(stdout)
      ? 'gdrive'
      : /^gcs:/m.test(stdout)
        ? 'gcs'
        : null;
  } catch {
    cachedRemote = null;
  }
  return cachedRemote;
}
function archiveBase(remote: string): string {
  return remote === 'gcs'
    ? `gcs:${GCS_BUCKET}/SanctumArchive`
    : 'gdrive:SanctumArchive';
}

/** Copy a local object to the permanent archive. Returns false on any failure. */
async function copyToArchive(localKey: string, destRel: string): Promise<boolean> {
  const remote = await backupRemote();
  if (!remote) return false;
  const localPath = path.join(path.resolve(env.MEDIA_DIR), localKey);
  const dest = `${archiveBase(remote)}/${destRel}`;
  try {
    await execFileAsync('rclone', ['copyto', localPath, dest], {
      timeout: 120_000,
    });
    return true;
  } catch {
    return false;
  }
}

const nameCache = new Map<string, string>();
async function clientNameOf(clientId: string): Promise<string> {
  const hit = nameCache.get(clientId);
  if (hit) return hit;
  const [c] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  const name = c?.name ?? clientId;
  nameCache.set(clientId, name);
  return name;
}

export interface ArchiveResult {
  scanned: number;
  archived: number;
  skipped: number;
  errors: number;
  dryRun: boolean;
}

export async function runMediaArchive(
  opts: { retentionDays?: number; dryRun?: boolean } = {},
): Promise<ArchiveResult> {
  const res: ArchiveResult = {
    scanned: 0,
    archived: 0,
    skipped: 0,
    errors: 0,
    dryRun: !!opts.dryRun,
  };
  if (env.STORAGE_DRIVER !== 'local') return res;

  const retentionDays = opts.retentionDays ?? env.MEDIA_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

  // Don't delete anything unless there's an archive destination to copy to.
  if (!opts.dryRun && !(await backupRemote())) return res;

  // --- Documents ---
  const docs = await db
    .select()
    .from(documents)
    .where(and(eq(documents.archived, false), lt(documents.createdAt, cutoff)));
  for (const d of docs) {
    if (!isSelfHosted(d.fileUrl) || !d.publicId) {
      res.skipped++;
      continue;
    }
    res.scanned++;
    const clientName = d.clientId ? await clientNameOf(d.clientId) : '_agency';
    const destRel = `${monthOf(d.createdAt)}/${sanitize(clientName)}/documents/${path.basename(d.publicId)}`;
    if (opts.dryRun) {
      res.archived++;
      continue;
    }
    if (await copyToArchive(d.publicId, destRel)) {
      await deleteObjectLocal(d.publicId);
      await db
        .update(documents)
        .set({ archived: true, archivedAt: new Date() })
        .where(eq(documents.id, d.id));
      res.archived++;
    } else {
      res.errors++;
    }
  }

  // --- Post media ---
  const media = await db
    .select()
    .from(postMedia)
    .where(and(eq(postMedia.archived, false), lt(postMedia.createdAt, cutoff)));
  for (const m of media) {
    if (!isSelfHosted(m.secureUrl)) {
      res.skipped++;
      continue;
    }
    res.scanned++;
    const clientName = await clientNameOf(m.clientId);
    const destRel = `${monthOf(m.createdAt)}/${sanitize(clientName)}/posts/${path.basename(m.cloudinaryPublicId)}`;
    if (opts.dryRun) {
      res.archived++;
      continue;
    }
    if (await copyToArchive(m.cloudinaryPublicId, destRel)) {
      await deleteObjectLocal(m.cloudinaryPublicId);
      await db
        .update(postMedia)
        .set({ archived: true, archivedAt: new Date() })
        .where(eq(postMedia.id, m.id));
      res.archived++;
    } else {
      res.errors++;
    }
  }

  return res;
}
