import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';

/**
 * Storage + backup health for the Settings → Storage & Backups panel. Only
 * meaningful when STORAGE_DRIVER=local (self-hosted): reports disk usage, the
 * last weekly-backup result (written by backup-media.sh), and derived alerts.
 */

export interface StorageAlert {
  level: 'warn' | 'error';
  code: string;
  message: string;
}

export interface BackupStatus {
  lastRun: string | null;
  status: string; // ok | failed | skipped
  bytes?: number;
  reason?: string;
}

export interface StorageStatus {
  driver: string;
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPct: number;
  } | null;
  backup: BackupStatus | null;
  retentionDays: number;
  alerts: StorageAlert[];
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const driver = env.STORAGE_DRIVER;
  const alerts: StorageAlert[] = [];
  let disk: StorageStatus['disk'] = null;
  let backup: BackupStatus | null = null;

  if (driver !== 'local') {
    return { driver, disk, backup, retentionDays: env.MEDIA_RETENTION_DAYS, alerts };
  }

  const dir = path.resolve(env.MEDIA_DIR);

  // --- disk usage (df-style: capacity vs. space usable by non-root) ---
  try {
    const s = await fs.statfs(dir);
    const total = s.blocks * s.bsize;
    const free = s.bfree * s.bsize;
    const avail = s.bavail * s.bsize;
    const used = total - free;
    const usedPct =
      used + avail > 0 ? Math.round((used / (used + avail)) * 100) : 0;
    disk = { totalBytes: total, usedBytes: used, freeBytes: avail, usedPct };
    if (usedPct >= 92) {
      alerts.push({
        level: 'error',
        code: 'disk-critical',
        message: `Disk almost full (${usedPct}%). Free space, or archive/delete old media.`,
      });
    } else if (usedPct >= 80) {
      alerts.push({
        level: 'warn',
        code: 'disk-high',
        message: `Disk is ${usedPct}% full.`,
      });
    }
  } catch {
    // statfs not available on this platform — leave disk null
  }

  // --- last backup result (written by the weekly backup script) ---
  try {
    const raw = await fs.readFile(path.join(dir, '.backup-status.json'), 'utf8');
    backup = JSON.parse(raw) as BackupStatus;
  } catch {
    backup = null;
  }

  if (!backup || backup.status === 'skipped' || backup.reason === 'drive-not-configured') {
    alerts.push({
      level: 'warn',
      code: 'backup-not-configured',
      message:
        'Off-site backups are not connected yet. Connect Google Drive to enable weekly media backups.',
    });
  } else if (backup.status === 'failed') {
    alerts.push({
      level: 'error',
      code: 'backup-failed',
      message: 'The last backup failed. Check the backup logs on the server.',
    });
  } else if (backup.status === 'ok' && backup.lastRun) {
    const ageDays = (Date.now() - new Date(backup.lastRun).getTime()) / 86_400_000;
    if (ageDays > 8) {
      alerts.push({
        level: 'warn',
        code: 'backup-overdue',
        message: `The last successful backup was ${Math.floor(ageDays)} days ago.`,
      });
    }
  }

  return { driver, disk, backup, retentionDays: env.MEDIA_RETENTION_DAYS, alerts };
}
