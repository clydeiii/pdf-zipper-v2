/**
 * Retention sweeper for pdf-zipper-v2's data/media directory.
 *
 * Once a day, deletes whole `data/media/YYYY-WWW/` directories whose ISO
 * week-ending Sunday is older than RETENTION_DAYS (default 90). We use the
 * week-ID date — not file mtime — because reruns touch mtime and would
 * indefinitely defer deletion.
 *
 * Karakeep's data is owned by Karakeep and must be cleaned via its API,
 * not the filesystem — see karakeep-cleaner.ts for that path.
 */

import { readdir, stat, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { env } from '../config/env.js';
import { sendDiscordNotification } from '../notifications/discord.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '90', 10);
const SWEEP_INTERVAL_MS = ONE_DAY_MS;
/** Wait after startup before the first sweep so we don't slow boot. */
const STARTUP_DELAY_MS = 60_000;

let sweepTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

/**
 * Compute the Sunday (UTC, end-of-week) date for an ISO week.
 * ISO week 1 is the week containing the first Thursday of the year, so
 * Monday of week 1 = Jan 4 minus (Jan 4's weekday - 1) days.
 */
function getWeekSundayDate(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7; // 1 (Mon) .. 7 (Sun)
  const week1MondayMs = jan4.getTime() - (jan4Weekday - 1) * ONE_DAY_MS;
  const targetMondayMs = week1MondayMs + (week - 1) * 7 * ONE_DAY_MS;
  return new Date(targetMondayMs + 6 * ONE_DAY_MS);
}

function parseWeekDirName(name: string): { year: number; week: number } | null {
  const m = name.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), week: parseInt(m[2], 10) };
}

/**
 * Recursively sum the byte size of every file under a directory.
 * Best-effort — errors on individual entries are swallowed so a partial
 * count is still useful for the Discord summary.
 */
async function dirSize(dirPath: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry);
    try {
      const s = await stat(entryPath);
      if (s.isDirectory()) {
        total += await dirSize(entryPath);
      } else if (s.isFile()) {
        total += s.size;
      }
    } catch { /* ignore unreadable entries */ }
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export interface SweepResult {
  retentionDays: number;
  cutoffDate: string;
  weeksDeleted: string[];
  weeksKept: number;
  bytesFreed: number;
  /** Debug artifacts (data/debug/*.pdf|*.json) older than the cutoff, removed. */
  debugFilesDeleted: number;
  errors: Array<{ week: string; error: string }>;
}

/**
 * Prune failed-job debug artifacts older than the cutoff. They exist so a
 * failure can be inspected from the UI's failure badge; a debug PDF for a job
 * BullMQ pruned weeks ago serves nothing and nothing else ever deleted them
 * (769 files / 1.1GB by 2026-09-04, 424 past 30 days). Same policy as the
 * week bins: RETENTION_DAYS. Best-effort; returns {count, bytes}.
 */
async function pruneDebugArtifacts(cutoffMs: number): Promise<{ count: number; bytes: number }> {
  const debugDir = path.join(env.DATA_DIR, 'debug');
  let entries: string[];
  try {
    entries = await readdir(debugDir);
  } catch {
    return { count: 0, bytes: 0 };
  }
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!/\.(pdf|json|png)$/i.test(entry)) continue;
    const filePath = path.join(debugDir, entry);
    try {
      const s = await stat(filePath);
      if (!s.isFile() || s.mtimeMs >= cutoffMs) continue;
      await rm(filePath, { force: true });
      count++;
      bytes += s.size;
    } catch { /* unreadable or already gone */ }
  }
  return { count, bytes };
}

/**
 * Run a single sweep pass. Idempotent — safe to invoke at any time.
 */
export async function sweepOldWeeks(retentionDays: number = RETENTION_DAYS): Promise<SweepResult> {
  const cutoff = new Date(Date.now() - retentionDays * ONE_DAY_MS);
  const result: SweepResult = {
    retentionDays,
    cutoffDate: cutoff.toISOString().slice(0, 10),
    weeksDeleted: [],
    weeksKept: 0,
    bytesFreed: 0,
    debugFilesDeleted: 0,
    errors: [],
  };

  if (retentionDays <= 0) {
    console.log(JSON.stringify({
      event: 'retention_sweep_disabled',
      retentionDays,
      timestamp: new Date().toISOString(),
    }));
    return result;
  }

  const debug = await pruneDebugArtifacts(cutoff.getTime());
  result.debugFilesDeleted = debug.count;
  result.bytesFreed += debug.bytes;
  if (debug.count > 0) {
    console.log(JSON.stringify({
      event: 'retention_debug_pruned',
      files: debug.count,
      bytesFreed: debug.bytes,
      cutoffDate: result.cutoffDate,
      timestamp: new Date().toISOString(),
    }));
  }

  const mediaDir = path.join(env.DATA_DIR, 'media');
  let entries: string[];
  try {
    entries = await readdir(mediaDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw err;
  }

  for (const entry of entries) {
    const parsed = parseWeekDirName(entry);
    if (!parsed) continue;

    const sunday = getWeekSundayDate(parsed.year, parsed.week);
    if (sunday >= cutoff) {
      result.weeksKept++;
      continue;
    }

    const dirPath = path.join(mediaDir, entry);
    try {
      const size = await dirSize(dirPath);
      await rm(dirPath, { recursive: true, force: true });
      result.weeksDeleted.push(entry);
      result.bytesFreed += size;
      console.log(JSON.stringify({
        event: 'retention_week_deleted',
        weekId: entry,
        weekEnded: sunday.toISOString().slice(0, 10),
        bytesFreed: size,
        timestamp: new Date().toISOString(),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ week: entry, error: msg });
      console.error(JSON.stringify({
        event: 'retention_week_delete_failed',
        weekId: entry,
        error: msg,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  return result;
}

/**
 * Run a sweep and post a Discord summary. Errors are logged but never thrown
 * — sweeper failures must not crash the process.
 */
async function runSweepWithNotify(): Promise<void> {
  try {
    console.log(JSON.stringify({
      event: 'retention_sweep_start',
      retentionDays: RETENTION_DAYS,
      timestamp: new Date().toISOString(),
    }));

    const result = await sweepOldWeeks();

    console.log(JSON.stringify({
      event: 'retention_sweep_done',
      ...result,
      timestamp: new Date().toISOString(),
    }));

    // Only notify when we actually did something (or hit errors). A daily
    // "0 weeks deleted" message would be noise; routine debug pruning is
    // logged above but not worth a ping on its own.
    if (result.weeksDeleted.length === 0 && result.errors.length === 0) return;

    await sendDiscordNotification({
      type: result.errors.length > 0 ? 'warning' : 'info',
      title: '🧹 Retention Sweep',
      description: `Deleted ${result.weeksDeleted.length} week(s) older than ${result.retentionDays} days (cutoff ${result.cutoffDate})`,
      fields: [
        { name: 'Freed', value: formatBytes(result.bytesFreed), inline: true },
        { name: 'Kept', value: `${result.weeksKept} weeks`, inline: true },
        ...(result.weeksDeleted.length > 0
          ? [{ name: 'Deleted', value: result.weeksDeleted.join(', '), inline: false }]
          : []),
        ...(result.errors.length > 0
          ? [{ name: 'Errors', value: result.errors.map(e => `${e.week}: ${e.error}`).join('\n').slice(0, 1024), inline: false }]
          : []),
      ],
    });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'retention_sweep_error',
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
  }
}

/**
 * Schedule the sweeper: one run shortly after startup, then every 24 hours.
 * Set RETENTION_DAYS=0 to disable.
 */
export function startRetentionSweeper(): void {
  if (RETENTION_DAYS <= 0) {
    console.log(`Retention sweeper disabled (RETENTION_DAYS=${RETENTION_DAYS})`);
    return;
  }

  startupTimer = setTimeout(() => { void runSweepWithNotify(); }, STARTUP_DELAY_MS);
  sweepTimer = setInterval(() => { void runSweepWithNotify(); }, SWEEP_INTERVAL_MS);
  console.log(`Retention sweeper scheduled: every 24h, retain ${RETENTION_DAYS} days`);
}

export function stopRetentionSweeper(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
