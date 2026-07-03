/**
 * Nightly "captures" bundler for pdf-zipper-v2.
 *
 * Once a day, packs every file captured in the last CAPTURES_WINDOW_HOURS
 * (default 24h) — PDFs, MP3s, MP4s, transcript sidecars — into a single
 * `data/captures/captures-YYYY-MM-DD.zip`, then copies it to
 * `captures-latest.zip`. Because it lives under DATA_DIR it is served
 * automatically (no new route) at:
 *
 *     /api/file/captures/captures-latest.zip
 *
 * This mirrors the externally-built `benchmarks-latest.zip` static download,
 * but is built in-process because the source files already live in
 * `data/media/{ISO-week}/{pdfs,podcasts,videos}/`.
 *
 * "Captured in the last 24h" is keyed on file mtime — the same freshness
 * signal the UI's "Select New" uses. Reruns touch mtime, which is correct:
 * a re-captured file is a fresh capture and belongs in tonight's bundle.
 *
 * Retention: keep the newest CAPTURES_ZIP_RETENTION_DAYS dated bundles
 * (default 7); `captures-latest.zip` is never pruned.
 */

import archiver from 'archiver';
import * as fs from 'node:fs';
import { mkdir, readdir, stat, unlink, rename, copyFile, link } from 'node:fs/promises';
import * as path from 'node:path';
import { env } from '../config/env.js';
import { sendDiscordNotification } from '../notifications/discord.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/** Subdir under DATA_DIR where the bundles live (served via /api/file/captures/). */
const CAPTURES_SUBDIR = 'captures';
/** Only files modified within this many hours are bundled. */
const WINDOW_HOURS = parseInt(process.env.CAPTURES_WINDOW_HOURS || '24', 10);
/** Keep this many newest dated bundles; the rest are pruned. */
const RETENTION_DAYS = parseInt(process.env.CAPTURES_ZIP_RETENTION_DAYS || '7', 10);
/**
 * Local hour (0-23) at which the nightly run fires. Default midnight so the
 * "latest" bundle is a clean as-of-midnight snapshot, aligned with the
 * benchmarks harvester (host cron, also midnight). Container TZ is pinned in
 * docker-compose (TZ=America/New_York) so "midnight" matches the host.
 */
const RUN_HOUR = parseInt(process.env.CAPTURES_ZIP_HOUR || '0', 10);
/** Set CAPTURES_ZIP_ENABLED=false to disable. */
const ENABLED = process.env.CAPTURES_ZIP_ENABLED !== 'false';
/**
 * Captures are mostly incompressible media (MP3/MP4); PDFs are the only real
 * win. Level 1 keeps the nightly run fast on multi-GB bundles.
 */
const ZLIB_LEVEL = 1;

let runTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

function parseWeekDirName(name: string): boolean {
  return /^\d{4}-W\d{2}$/.test(name);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface RecentFile {
  /** Absolute path on disk. */
  fullPath: string;
  /** Path inside the zip, relative to the media dir (collision-free, e.g. 2026-W27/pdfs/foo.pdf). */
  zipPath: string;
  size: number;
}

/**
 * Collect every capture file modified at or after `cutoffMs`, walking each
 * `media/{week}/{type}/` directory. Best-effort: unreadable entries are skipped.
 */
async function collectRecentFiles(mediaDir: string, cutoffMs: number): Promise<RecentFile[]> {
  const files: RecentFile[] = [];

  let weeks: string[];
  try {
    weeks = await readdir(mediaDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw err;
  }

  for (const week of weeks) {
    if (!parseWeekDirName(week)) continue;
    const weekDir = path.join(mediaDir, week);

    let typeDirs: string[];
    try {
      typeDirs = await readdir(weekDir);
    } catch { continue; }

    for (const typeDir of typeDirs) {
      const dir = path.join(weekDir, typeDir);
      let entries: string[];
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) continue;
        entries = await readdir(dir);
      } catch { continue; }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        try {
          const s = await stat(fullPath);
          if (!s.isFile()) continue;
          if (s.mtimeMs < cutoffMs) continue;
          files.push({
            fullPath,
            zipPath: path.join(week, typeDir, entry),
            size: s.size,
          });
        } catch { /* ignore unreadable entries */ }
      }
    }
  }

  return files;
}

/** Prune dated bundles to the RETENTION_DAYS newest. Never touches -latest.zip. */
async function pruneOldBundles(capturesDir: string): Promise<void> {
  try {
    const names = (await readdir(capturesDir)).filter((n) => /^captures-\d{4}-\d{2}-\d{2}\.zip$/.test(n));
    names.sort(); // ISO dates sort chronologically
    for (const n of names.slice(0, Math.max(0, names.length - RETENTION_DAYS))) {
      await unlink(path.join(capturesDir, n)).catch(() => {});
      console.log(JSON.stringify({ event: 'captures_bundle_pruned', file: n, timestamp: new Date().toISOString() }));
    }
  } catch { /* best-effort */ }
}

export interface BundleResult {
  windowHours: number;
  fileCount: number;
  bytesUncompressed: number;
  bytesZip: number;
  zipFile: string;
}

/**
 * Build one bundle. Writes to a `.tmp`, renames to the dated name (atomic),
 * then copies to `captures-latest.zip`. Returns metadata for logging/notify.
 */
export async function buildCapturesBundle(): Promise<BundleResult> {
  const dataDir = path.resolve(env.DATA_DIR);
  const mediaDir = path.join(dataDir, 'media');
  const capturesDir = path.join(dataDir, CAPTURES_SUBDIR);
  await mkdir(capturesDir, { recursive: true });

  const now = new Date();
  const cutoffMs = now.getTime() - WINDOW_HOURS * ONE_HOUR_MS;
  const files = await collectRecentFiles(mediaDir, cutoffMs);
  const bytesUncompressed = files.reduce((sum, f) => sum + f.size, 0);

  // Local calendar date (process TZ) so the dated bundle matches the day the
  // user perceives at midnight, consistent with the benchmarks harvester.
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const zipName = `captures-${today}.zip`;
  const finalPath = path.join(capturesDir, zipName);
  const tmpPath = `${finalPath}.tmp`;
  const latestPath = path.join(capturesDir, 'captures-latest.zip');

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    const archive = archiver('zip', { zlib: { level: ZLIB_LEVEL } });

    out.on('close', () => resolve());
    out.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err: archiver.ArchiverError) => {
      console.warn(JSON.stringify({
        event: 'captures_bundle_warning',
        code: err.code,
        error: err.message,
        timestamp: new Date().toISOString(),
      }));
    });

    archive.pipe(out);

    // Self-describing manifest at the zip root (mirrors the benchmarks bundle's
    // root timestamp file) so the bundle identifies itself once shipped.
    const manifest = [
      `captures bundle: ${zipName}`,
      `generated: ${now.toISOString()}`,
      `window: last ${WINDOW_HOURS}h (files modified >= ${new Date(cutoffMs).toISOString()})`,
      `files: ${files.length}`,
      `uncompressed: ${formatBytes(bytesUncompressed)}`,
      '',
      'See doex-enrichment-details.md for the full metadata contract embedded in these files.',
      '',
    ].join('\n');
    archive.append(manifest, { name: 'MANIFEST.txt' });

    // Metadata-contract doc for the consuming side (Karpathy KB rule: the
    // bundle must explain itself). Lives in public/ so it's editable without
    // a rebuild and browsable from the web UI. Best-effort: a missing doc
    // must not block the nightly bundle.
    const enrichmentDocPath = path.resolve('public/doex-enrichment-details.md');
    if (fs.existsSync(enrichmentDocPath)) {
      archive.file(enrichmentDocPath, { name: 'doex-enrichment-details.md' });
    } else {
      console.warn(JSON.stringify({
        event: 'captures_bundle_warning',
        error: `doex-enrichment-details.md not found at ${enrichmentDocPath}`,
        timestamp: now.toISOString(),
      }));
    }

    for (const f of files) {
      archive.file(f.fullPath, { name: f.zipPath });
    }

    void archive.finalize();
  });

  await rename(tmpPath, finalPath);
  // Hardlink -latest to the dated bundle (same dir, same fs) so the multi-GB
  // snapshot isn't stored twice; fall back to a copy if the fs refuses links.
  await unlink(latestPath).catch(() => {});
  try {
    await link(finalPath, latestPath);
  } catch {
    await copyFile(finalPath, latestPath);
  }

  const bytesZip = (await stat(finalPath)).size;
  await pruneOldBundles(capturesDir);

  return {
    windowHours: WINDOW_HOURS,
    fileCount: files.length,
    bytesUncompressed,
    bytesZip,
    zipFile: `${CAPTURES_SUBDIR}/${zipName}`,
  };
}

/** Run a bundle and post a Discord summary. Never throws — a failure must not crash the process. */
async function runWithNotify(): Promise<void> {
  try {
    console.log(JSON.stringify({ event: 'captures_bundle_start', windowHours: WINDOW_HOURS, timestamp: new Date().toISOString() }));

    const result = await buildCapturesBundle();

    console.log(JSON.stringify({ event: 'captures_bundle_done', ...result, timestamp: new Date().toISOString() }));

    await sendDiscordNotification({
      type: 'info',
      title: '📦 Captures Bundle',
      description: `Bundled ${result.fileCount} capture(s) from the last ${result.windowHours}h`,
      fields: [
        { name: 'Zip', value: formatBytes(result.bytesZip), inline: true },
        { name: 'Files', value: `${result.fileCount}`, inline: true },
        { name: 'Download', value: '/api/file/captures/captures-latest.zip', inline: false },
      ],
    });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'captures_bundle_error',
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
  }
}

/** Milliseconds from now until the next occurrence of local hour `hour`. */
function msUntilHour(hour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Schedule the bundler: first run at the next RUN_HOUR, then every 24h.
 * Set CAPTURES_ZIP_ENABLED=false to disable.
 */
export function startCapturesZipper(): void {
  if (!ENABLED) {
    console.log('Captures zipper disabled (CAPTURES_ZIP_ENABLED=false)');
    return;
  }

  const delay = msUntilHour(RUN_HOUR);
  startupTimer = setTimeout(() => {
    void runWithNotify();
    runTimer = setInterval(() => { void runWithNotify(); }, ONE_DAY_MS);
  }, delay);

  console.log(
    `Captures zipper scheduled: daily at ${String(RUN_HOUR).padStart(2, '0')}:00 ` +
    `(first run in ${(delay / ONE_HOUR_MS).toFixed(1)}h), window ${WINDOW_HOURS}h, retain ${RETENTION_DAYS} bundles`
  );
}

export function stopCapturesZipper(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
}
