/**
 * Karakeep retention sweeper.
 *
 * Karakeep stores bookmarks (and their assets — PDFs, screenshots, video
 * downloads) in a SQLite DB plus a Docker volume. Deleting the asset files
 * directly leaves dangling DB rows, broken thumbnails, and "asset not found"
 * pages in the UI; the only safe way to free space is to call Karakeep's
 * own DELETE /api/v1/bookmarks/{id} which removes the row + its assets.
 *
 * Default policy: delete bookmarks whose `createdAt` is older than
 * KARAKEEP_RETENTION_DAYS (90), preserving anything the user explicitly
 * favourited.
 */

import { sendDiscordNotification } from '../notifications/discord.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const KARAKEEP_RETENTION_DAYS = parseInt(process.env.KARAKEEP_RETENTION_DAYS || '90', 10);
const KARAKEEP_API_BASE = process.env.KARAKEEP_API_BASE;
const KARAKEEP_API_TOKEN = process.env.KARAKEEP_API_TOKEN;
const SWEEP_INTERVAL_MS = ONE_DAY_MS;
/** Stagger Karakeep sweep against pdf-zipper sweep to avoid overlapping deletes. */
const STARTUP_DELAY_MS = 5 * 60 * 1000; // 5 min after boot
/** Throttle deletes so we don't hammer Karakeep. */
const DELETE_THROTTLE_MS = 200;
/** Don't walk forever if pagination is broken. */
const MAX_PAGES = 200;
/** Page size for /bookmarks listing. */
const PAGE_LIMIT = 100;

let sweepTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

interface KarakeepBookmark {
  id: string;
  createdAt: string;
  archived?: boolean;
  favourited?: boolean;
  title?: string;
}

interface BookmarksPage {
  bookmarks: KarakeepBookmark[];
  nextCursor?: string;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${KARAKEEP_API_TOKEN}`,
    Accept: 'application/json',
  };
}

/**
 * Page through all bookmarks (oldest-first by createdAt, descending — Karakeep's
 * default order). Returns every page as an async-iterable generator so we can
 * stream-collect IDs without holding the full corpus in memory.
 */
async function* iterateBookmarks(): AsyncGenerator<KarakeepBookmark> {
  let cursor: string | undefined;
  let pages = 0;
  while (pages++ < MAX_PAGES) {
    const url = new URL('/api/v1/bookmarks', KARAKEEP_API_BASE);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), { headers: authHeaders() });
    if (!res.ok) {
      throw new Error(`Karakeep list failed: ${res.status} ${res.statusText}`);
    }
    const page = await res.json() as BookmarksPage;
    for (const bm of page.bookmarks ?? []) yield bm;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
  console.warn(`Karakeep pagination hit MAX_PAGES (${MAX_PAGES}); stopping early`);
}

async function deleteBookmark(id: string): Promise<boolean> {
  const url = new URL(`/api/v1/bookmarks/${encodeURIComponent(id)}`, KARAKEEP_API_BASE);
  const res = await fetch(url.toString(), { method: 'DELETE', headers: authHeaders() });
  // 204 No Content is the success response. 200 + body also accepted.
  if (res.status === 204 || res.status === 200) return true;
  if (res.status === 404) return true; // Already gone — not an error.
  console.warn(JSON.stringify({
    event: 'karakeep_delete_failed',
    bookmarkId: id,
    status: res.status,
    timestamp: new Date().toISOString(),
  }));
  return false;
}

export interface KarakeepSweepResult {
  retentionDays: number;
  cutoffDate: string;
  scanned: number;
  candidates: number;
  deleted: number;
  preservedFavourited: number;
  failed: number;
}

/**
 * One sweep pass. Two-phase: collect all old bookmark IDs first, then delete.
 * Skipping favourites preserves user-curated saves regardless of age.
 */
export async function sweepOldKarakeepBookmarks(
  retentionDays: number = KARAKEEP_RETENTION_DAYS
): Promise<KarakeepSweepResult> {
  const cutoff = new Date(Date.now() - retentionDays * ONE_DAY_MS);
  const result: KarakeepSweepResult = {
    retentionDays,
    cutoffDate: cutoff.toISOString().slice(0, 10),
    scanned: 0,
    candidates: 0,
    deleted: 0,
    preservedFavourited: 0,
    failed: 0,
  };

  if (retentionDays <= 0) {
    console.log(JSON.stringify({
      event: 'karakeep_sweep_disabled',
      retentionDays,
      timestamp: new Date().toISOString(),
    }));
    return result;
  }
  if (!KARAKEEP_API_BASE || !KARAKEEP_API_TOKEN) {
    console.log(JSON.stringify({
      event: 'karakeep_sweep_skipped',
      reason: 'KARAKEEP_API_BASE or KARAKEEP_API_TOKEN not set',
      timestamp: new Date().toISOString(),
    }));
    return result;
  }

  // Phase 1: collect IDs (don't delete while paginating — would shift the cursor)
  const toDelete: string[] = [];
  for await (const bm of iterateBookmarks()) {
    result.scanned++;
    if (!bm.createdAt) continue;
    const created = new Date(bm.createdAt);
    if (Number.isNaN(created.getTime())) continue;
    if (created >= cutoff) continue;
    if (bm.favourited) {
      result.preservedFavourited++;
      continue;
    }
    toDelete.push(bm.id);
  }
  result.candidates = toDelete.length;

  // Phase 2: throttled deletes
  for (const id of toDelete) {
    const ok = await deleteBookmark(id);
    if (ok) result.deleted++;
    else result.failed++;
    if (DELETE_THROTTLE_MS > 0) {
      await new Promise(r => setTimeout(r, DELETE_THROTTLE_MS));
    }
  }

  return result;
}

async function runSweepWithNotify(): Promise<void> {
  try {
    console.log(JSON.stringify({
      event: 'karakeep_sweep_start',
      retentionDays: KARAKEEP_RETENTION_DAYS,
      timestamp: new Date().toISOString(),
    }));

    const result = await sweepOldKarakeepBookmarks();

    console.log(JSON.stringify({
      event: 'karakeep_sweep_done',
      ...result,
      timestamp: new Date().toISOString(),
    }));

    if (result.deleted === 0 && result.failed === 0) return;

    await sendDiscordNotification({
      type: result.failed > 0 ? 'warning' : 'info',
      title: '🧹 Karakeep Retention Sweep',
      description: `Deleted ${result.deleted} bookmark(s) older than ${result.retentionDays} days (cutoff ${result.cutoffDate})`,
      fields: [
        { name: 'Scanned', value: `${result.scanned}`, inline: true },
        { name: 'Candidates', value: `${result.candidates}`, inline: true },
        { name: 'Preserved (★)', value: `${result.preservedFavourited}`, inline: true },
        ...(result.failed > 0
          ? [{ name: 'Failed', value: `${result.failed}`, inline: true }]
          : []),
      ],
    });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'karakeep_sweep_error',
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
  }
}

export function startKarakeepCleaner(): void {
  if (KARAKEEP_RETENTION_DAYS <= 0) {
    console.log(`Karakeep cleaner disabled (KARAKEEP_RETENTION_DAYS=${KARAKEEP_RETENTION_DAYS})`);
    return;
  }
  if (!KARAKEEP_API_BASE || !KARAKEEP_API_TOKEN) {
    console.log('Karakeep cleaner disabled: KARAKEEP_API_BASE or KARAKEEP_API_TOKEN not set');
    return;
  }

  startupTimer = setTimeout(() => { void runSweepWithNotify(); }, STARTUP_DELAY_MS);
  sweepTimer = setInterval(() => { void runSweepWithNotify(); }, SWEEP_INTERVAL_MS);
  console.log(`Karakeep cleaner scheduled: every 24h, retain ${KARAKEEP_RETENTION_DAYS} days, preserves favourites`);
}

export function stopKarakeepCleaner(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
