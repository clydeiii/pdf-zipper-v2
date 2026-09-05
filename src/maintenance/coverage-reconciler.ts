/**
 * Reconcile bookmarks against files, including the ones that produced NOTHING.
 * The 385-bookmark evening on 2026-09-01 stranded video waits beyond page one;
 * scanning existing captures alone could never have reported those losses.
 */
import { readdir, readFile, stat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { buildKarakeepItem, type KarakeepBookmark } from '../feeds/parsers/karakeep.js';
import type { BookmarkItem } from '../feeds/types.js';
import { normalizeBookmarkUrl, canonicalizeYouTubeUrl } from '../urls/normalizer.js';
import { BookmarkDeduplicator } from '../urls/deduplicator.js';
import { parseSubstackPubPost } from '../urls/substack-canonical.js';
import { stripUrlQuery } from '../twitter/pdf-index.js';
import { isApplePodcastsUrl } from '../podcasts/apple.js';
import { isPatreonPostUrl } from '../media/patreon.js';
import { classifyFailureMessage } from '../fix/failure.js';
import { readAudioMetadata, readVideoMetadata } from '../metadata/media-tags-reader.js';
import { sendDiscordNotification } from '../notifications/discord.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INPUT_BUDGET_MS = 300_000; // first run parses every artifact cold (~7k files); warm runs take seconds
const INDEX_KEY = 'coverage:artifact-index';
const REPORT_KEY = 'coverage:last-report';
export const COVERAGE_STATUSES = ['archived', 'partial', 'pending', 'stale_pending', 'failed', 'manual', 'manual_missing', 'skipped', 'unaccounted'] as const;
export type CoverageStatus = typeof COVERAGE_STATUSES[number];
export type ArtifactRole = 'pdf' | 'mp4' | 'mp3' | 'transcript';
export type MatchKind = 'exact' | 'no-query' | 'youtube-id' | 'substack' | 'substack-slug';
export interface UrlKey { key: string; matchedBy: MatchKind }
export interface CoverageArtifact { file: string; role: ArtifactRole; keys: UrlKey[] }
export interface CoverageJob {
  keys: UrlKey[];
  queue: string;
  roles: ArtifactRole[];
  state: 'waiting' | 'active' | 'delayed' | 'failed' | 'completed';
  timestamp: number;
  failedReason?: string;
}
export interface CoverageBookmark {
  bookmarkId: string;
  createdAt: string;
  url: string;
  title?: string;
  item: BookmarkItem | null;
  skipPolicy?: string;
}
export interface CoverageLookups {
  now: number;
  keys: UrlKey[];
  artifacts: CoverageArtifact[];
  jobs: CoverageJob[];
  videoRetry?: boolean;
  source?: string | null;
  /** Only set with evidence of an earlier URL capture and a processed GUID. */
  mediaRebookmark?: boolean;
}
export interface CoverageItem {
  bookmarkId: string;
  createdAt: string;
  url: string;
  title: string;
  expectedRoles: ArtifactRole[];
  foundRoles: ArtifactRole[];
  status: CoverageStatus;
  detail: string;
  matchedBy: MatchKind[];
  artifacts: string[];
}
export interface CoverageReport {
  startedAt: string;
  windowDays: number;
  cutoff: string;
  totals: Record<CoverageStatus | 'shared_artifact', number>;
  items: CoverageItem[];
  sharedArtifacts: Array<{ file: string; bookmarkIds: string[] }>;
  /** An interrupted enumeration must never be presented as a clean audit. */
  complete: boolean;
  errors: string[];
}

/** Pure identity expansion; candidates come from the deduplicator, outside I/O-free classification. */
export function coverageUrlKeys(url: string, candidates: string[] = []): UrlKey[] {
  const keys = new Map<string, MatchKind>();
  const add = (value: string, kind: MatchKind) => { if (!keys.has(value)) keys.set(value, kind); };
  try {
    const normalized = normalizeBookmarkUrl(url);
    const youtube = canonicalizeYouTubeUrl(url);
    const raw = new URL(url);
    const isTweet = /(^|\.)(x|twitter)\.com$/.test(raw.hostname);
    const shareTweet = isTweet && (raw.searchParams.has('s') || raw.searchParams.has('t'));
    add(normalized, youtube && url !== youtube ? 'youtube-id' : shareTweet ? 'no-query' : 'exact');
    // X handles are case-insensitive and the same tweet arrives as
    // x.com/Reuters/… from the web and x.com/reuters/… from the iOS share
    // sheet; the status id is the identity. Lowercase the path on both sides.
    if (isTweet) {
      try {
        const lowered = new URL(normalized);
        lowered.pathname = lowered.pathname.toLowerCase();
        add(lowered.toString(), 'exact');
      } catch { /* normalized is a URL already */ }
    }
    if (youtube) add(youtube, 'youtube-id');
    // Weakest key: the post slug alone for `/p/<slug>` paths. Substack's
    // pub→custom-domain mapping needs a network lookup the audit may not get
    // (429 after a restart burst); slugs are long and distinctive, and a
    // cross-publication collision surfaces as a shared artifact with this
    // match kind, never as a silent loss.
    const slugPost = parseSubstackPubPost(url);
    const slug = slugPost?.slug ?? raw.pathname.match(/^\/p\/([^/?#]+)\/?$/)?.[1];
    if (slug && slug.length >= 8) add(`substack-slug:${slug.toLowerCase()}`, 'substack-slug');
    for (const candidate of candidates) {
      add(normalizeBookmarkUrl(candidate), parseSubstackPubPost(url) || parseSubstackPubPost(candidate) ? 'substack' : 'exact');
    }
    // Query stripping must not collapse all /watch?v= videos or every episode
    // of one Apple show. These query parameters ARE identity, not share tokens.
    if (!youtube && !(isApplePodcastsUrl(url) && raw.searchParams.has('i'))) {
      const stripped = stripUrlQuery(normalized);
      if (stripped) {
        const key = normalizeBookmarkUrl(stripped);
        add(key, 'no-query');
        if (isTweet) {
          try { const l = new URL(key); l.pathname = l.pathname.toLowerCase(); add(l.toString(), 'no-query'); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* Malformed provenance cannot prove a capture exists. */ }
  return [...keys].map(([key, matchedBy]) => ({ key, matchedBy }));
}

export function matchCoverageKeys(left: UrlKey[], right: UrlKey[]): MatchKind | null {
  const priority: MatchKind[] = ['exact', 'youtube-id', 'substack', 'no-query', 'substack-slug'];
  let best: MatchKind | null = null;
  for (const a of left) for (const b of right) {
    if (a.key !== b.key) continue;
    const kind = priority[Math.max(priority.indexOf(a.matchedBy), priority.indexOf(b.matchedBy))];
    if (best === null || priority.indexOf(kind) < priority.indexOf(best)) best = kind;
  }
  return best;
}

export function expectedCoverageRoles(item: BookmarkItem): ArtifactRole[] {
  if (item.mediaType === 'pdf') return ['pdf'];
  if (isApplePodcastsUrl(item.url)) return ['mp3', 'transcript'];
  if (isPatreonPostUrl(item.url)) return ['pdf']; // Text-only Patreon posts are normal.
  const host = new URL(item.url).hostname.replace(/^www\./, '');
  // The poller eventually supplies a yt-dlp enclosure for YouTube/Vimeo even
  // when Karakeep never produces an asset. Expecting a PDF hides that incident.
  if (['youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com'].includes(host)) return ['mp4'];
  if (item.enclosure && item.mediaType === 'video') {
    return ['x.com', 'twitter.com'].includes(host) ? ['pdf', 'mp4'] : ['mp4'];
  }
  return ['pdf'];
}

/** Exactly one status, with artifact completeness taking precedence over old jobs. */
export function classifyBookmark(bookmark: CoverageBookmark, lookups: CoverageLookups): CoverageItem {
  const result: CoverageItem = {
    bookmarkId: bookmark.bookmarkId, createdAt: bookmark.createdAt, url: bookmark.url,
    title: bookmark.title || '', expectedRoles: [], foundRoles: [], status: 'unaccounted',
    detail: 'No artifact, pending work, or known failure', matchedBy: [], artifacts: [],
  };
  const finish = (status: CoverageStatus, detail: string): CoverageItem => ({ ...result, status, detail });
  if (!bookmark.item) return finish('skipped', bookmark.skipPolicy || 'unsupported_content: poller produces no item');
  result.expectedRoles = expectedCoverageRoles(bookmark.item);
  for (const artifact of lookups.artifacts) {
    const kind = matchCoverageKeys(lookups.keys, artifact.keys);
    if (!kind) continue;
    if (!result.artifacts.includes(artifact.file)) result.artifacts.push(artifact.file);
    if (!result.foundRoles.includes(artifact.role)) result.foundRoles.push(artifact.role);
    if (!result.matchedBy.includes(kind)) result.matchedBy.push(kind);
  }
  const missing = result.expectedRoles.filter(role => !result.foundRoles.includes(role));
  const manual = lookups.source === 'manual';
  if (!missing.length) return finish(manual ? 'manual' : 'archived', `${manual ? 'Manual capture; ' : ''}found ${result.foundRoles.join(', ')}`);
  if (manual && !result.artifacts.length) return finish('manual_missing', 'Manual-source URL has no artifact');
  // A manual capture of a VIDEO-ONLY page (YouTube/Vimeo) is a PDF on
  // purpose — the user printed it with the extension — not a missing MP4.
  // A manual tweet PDF with its video still missing stays `partial`: the
  // media job may yet run, and its absence is real.
  if (manual && result.foundRoles.includes('pdf') && !result.expectedRoles.includes('pdf')) {
    return finish('manual', `Manual capture; found ${result.foundRoles.join(', ')} (an automated capture would expect ${result.expectedRoles.join(', ')})`);
  }

  const jobs = lookups.jobs.filter(job => matchCoverageKeys(lookups.keys, job.keys));
  const pending = jobs.filter(job => ['waiting', 'active', 'delayed'].includes(job.state) &&
    (!result.artifacts.length || job.roles.some(role => missing.includes(role))));
  const waits = pending.map(job => ({
    stale: lookups.now - job.timestamp > 6 * HOUR,
    detail: `${job.queue} ${job.state}, age ${Math.max(0, (lookups.now - job.timestamp) / HOUR).toFixed(1)}h (deadline 6h)`,
    roles: job.roles,
  }));
  if (lookups.videoRetry && (!result.artifacts.length || missing.includes('mp4'))) {
    const age = lookups.now - Date.parse(bookmark.createdAt);
    waits.push({ stale: age > 3 * HOUR, detail: `Karakeep video wait, bookmark age ${Math.max(0, age / HOUR).toFixed(1)}h (deadline 3h)`, roles: ['mp4'] });
  }
  const stale = waits.filter(wait => wait.stale);
  if (stale.length) return finish('stale_pending', stale.map(wait => wait.detail).join('; '));
  const uncovered = missing.filter(role => !waits.some(wait => wait.roles.includes(role)));
  if (result.artifacts.length && uncovered.length) {
    return finish('partial', `${manual ? 'Manual capture; ' : ''}missing ${uncovered.join(', ')}; found ${result.foundRoles.join(', ')}`);
  }
  if (waits.length) return finish('pending', waits.map(wait => wait.detail).join('; '));
  const newest = [...jobs].sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!result.artifacts.length && newest?.state === 'failed') {
    return finish('failed', `${newest.queue}: ${classifyFailureMessage(newest.failedReason)} — ${(newest.failedReason || 'No failure reason').slice(0, 300)}`);
  }
  if (lookups.mediaRebookmark) return finish('skipped', 'media_rebookmark_dedup: processed GUID and URL seen before this bookmark; media hard-skip policy');
  return result;
}

export function summarizeCoverage(items: CoverageItem[]): Pick<CoverageReport, 'totals' | 'sharedArtifacts'> {
  const totals = Object.fromEntries(COVERAGE_STATUSES.map(status => [status, 0])) as CoverageReport['totals'];
  const files = new Map<string, Set<string>>();
  for (const item of items) {
    totals[item.status]++;
    for (const file of item.artifacts) {
      if (!files.has(file)) files.set(file, new Set());
      files.get(file)!.add(item.bookmarkId);
    }
  }
  const sharedArtifacts = [...files].filter(([, ids]) => ids.size > 1).map(([file, ids]) => ({ file, bookmarkIds: [...ids] }));
  totals.shared_artifact = new Set(sharedArtifacts.flatMap(shared => shared.bookmarkIds)).size;
  return { totals, sharedArtifacts };
}

function logError(errors: string[], scope: string, error: unknown): void {
  const message = `${scope}: ${error instanceof Error ? error.message : String(error)}`;
  errors.push(message);
  console.error(JSON.stringify({ event: 'coverage_audit_error', error: message, timestamp: new Date().toISOString() }));
}

/** BullMQ can wait for Redis readiness indefinitely; an audit must finish. */
async function boundedRead<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Redis operation exceeded 10s')), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Newest-first pagination; never use the feed's GUID-seen stopping rule here. */
export async function fetchCoverageBookmarks(base: string, token: string, cutoff: number, errors: string[], fetcher: typeof fetch = fetch, deadline = Date.now() + INPUT_BUDGET_MS): Promise<KarakeepBookmark[]> {
  const found = new Map<string, KarakeepBookmark>();
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 40; page++) {
    try {
      if (Date.now() >= deadline) throw new Error('Bookmark enumeration exceeded the input time budget');
      const url = new URL(`${base.replace(/\/$/, '')}/api/v1/bookmarks`);
      url.searchParams.set('limit', '50');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetcher(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))), redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { bookmarks: KarakeepBookmark[]; nextCursor?: string };
      if (!Array.isArray(data.bookmarks)) throw new Error('Invalid bookmarks response');
      let crossedCutoff = false;
      for (const bookmark of data.bookmarks) {
        const created = Date.parse(bookmark.createdAt);
        if (!bookmark.id || !Number.isFinite(created)) { logError(errors, 'Karakeep record', 'Missing id or invalid createdAt'); continue; }
        if (created < cutoff) crossedCutoff = true;
        else found.set(bookmark.id, bookmark);
      }
      if (crossedCutoff || !data.nextCursor) break;
      if (cursors.has(data.nextCursor) || page === 39) throw new Error('Pagination incomplete: repeated cursor or 40-page cap');
      cursor = data.nextCursor;
      cursors.add(cursor);
    } catch (error) { logError(errors, `Karakeep page ${page + 1}`, error); break; }
  }
  return [...found.values()];
}

async function mapBounded<T, R>(values: T[], fn: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await fn(values[index]); }
  }));
  return results;
}

type KeyResolver = (url: string) => Promise<UrlKey[]>;
interface CachedArtifact { urls: string[]; error?: string; retryAfter?: number }

/** One hash read per scan, zero Redis round trips per warm file; eight parsers at most. */
export async function scanCoverageArtifacts(dataDir: string, redis: Redis, keysFor: KeyResolver, errors: string[], deadline = Date.now() + INPUT_BUDGET_MS): Promise<CoverageArtifact[]> {
  const cache = await boundedRead(redis.hgetall(INDEX_KEY)).catch(error => { logError(errors, 'artifact cache read', error); return {} as Record<string, string>; });
  const files: Array<{ file: string; fullPath: string; role: ArtifactRole }> = [];
  const root = path.join(dataDir, 'media');
  try {
    for (const week of await readdir(root, { withFileTypes: true })) {
      if (!week.isDirectory() || !/^\d{4}-W\d{2}$/.test(week.name)) continue;
      for (const type of ['pdfs', 'videos', 'podcasts']) {
        try {
          for (const entry of await readdir(path.join(root, week.name, type), { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const lower = entry.name.toLowerCase();
            const role = lower.endsWith('.transcript.pdf') ? 'transcript' : lower.endsWith('.pdf') ? 'pdf' : lower.endsWith('.mp4') ? 'mp4' : lower.endsWith('.mp3') ? 'mp3' : null;
            if (!role) continue;
            const file = path.posix.join('media', week.name, type, entry.name);
            files.push({ file, fullPath: path.join(dataDir, file), role });
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logError(errors, `scan ${week.name}/${type}`, error); }
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logError(errors, 'media scan', error); }
  const present = new Set<string>();
  const updates: Array<[string, string]> = [];
  let budgetExceeded = false;
  const artifacts = await mapBounded(files, async file => {
    if (Date.now() >= deadline) {
      if (!budgetExceeded) logError(errors, 'artifact scan', 'Input time budget exceeded; remaining files were not indexed');
      budgetExceeded = true;
      return null;
    }
    try {
      const metadata = await stat(file.fullPath);
      const cacheKey = `${file.fullPath}:${metadata.mtimeMs}`;
      present.add(cacheKey);
      let record: CachedArtifact | undefined;
      try {
        const parsed = cache[cacheKey] ? JSON.parse(cache[cacheKey]) : undefined;
        if (parsed && Array.isArray(parsed.urls) && parsed.urls.every((url: unknown) => typeof url === 'string') &&
          (!parsed.error || parsed.retryAfter > Date.now())) record = parsed;
      } catch { /* Rebuild a malformed cache entry from the file. */ }
      if (!record) {
        try {
          let urls: string[];
          if (file.role === 'pdf' || file.role === 'transcript') {
            const doc = await PDFDocument.load(await readFile(file.fullPath), { updateMetadata: false });
            urls = [doc.getSubject() || ''];
          } else {
            const tags = file.role === 'mp4' ? await readVideoMetadata(file.fullPath) : await readAudioMetadata(file.fullPath);
            urls = [tags?.sourceUrl || '', ...(tags?.alsoBookmarkedAs || [])];
          }
          urls = [...new Set(urls.map(url => url.trim()).filter(url => /^https?:\/\//i.test(url)))];
          record = { urls, ...(!urls.length ? { error: 'Unreadable metadata or missing source URL' } : {}) };
        } catch (error) { record = { urls: [], error: error instanceof Error ? error.message : String(error) }; }
        // A transient ffprobe failure must not become a permanent negative
        // cache entry for an otherwise unchanged video. Retry next night.
        if (record.error) record.retryAfter = Date.now() + 6 * HOUR;
        updates.push([cacheKey, JSON.stringify(record)]);
      }
      if (record.error) logError(errors, file.file, record.error);
      const keys = (await Promise.all(record.urls.map(keysFor))).flat();
      return { file: file.file, role: file.role, keys };
    } catch (error) { logError(errors, file.file, error); return null; }
  });
  // Never use cached paths as proof of existence. Deleted files cannot satisfy
  // a bookmark just because yesterday's metadata remains in Redis.
  try {
    const pipeline = redis.pipeline();
    for (const [key, value] of updates) pipeline.hset(INDEX_KEY, key, value);
    const obsolete = budgetExceeded ? [] : Object.keys(cache).filter(key => !present.has(key));
    for (let offset = 0; offset < obsolete.length; offset += 500) pipeline.hdel(INDEX_KEY, ...obsolete.slice(offset, offset + 500));
    const replies = await boundedRead(pipeline.exec());
    for (const [error] of replies || []) if (error) throw error;
  } catch (error) { logError(errors, 'artifact cache update', error); }
  return artifacts.filter((artifact): artifact is CoverageArtifact => artifact !== null);
}

async function readQueueJobs(keysFor: KeyResolver, errors: string[]): Promise<CoverageJob[]> {
  // Lazy imports keep the pure classifier usable without opening Redis sockets.
  const [{ conversionQueue }, { mediaCollectionQueue }, { podcastQueue }] = await Promise.all([
    import('../queues/conversion.queue.js'), import('../feeds/monitor.js'), import('../podcasts/podcast.queue.js'),
  ]);
  const results = await Promise.all([conversionQueue, mediaCollectionQueue, podcastQueue].flatMap(queue =>
    (['waiting', 'active', 'delayed', 'failed', 'completed'] as const).map(async state => {
      try {
        // Fetch by set: avoids a getState Redis round trip for every retained job.
        const jobs = await boundedRead<Awaited<ReturnType<typeof queue.getJobs>>>(queue.getJobs([state]));
        return await Promise.all(jobs.map(async job => {
          const data = job.data as { url?: string; originalUrl?: string; item?: BookmarkItem };
          const urls = [data.url, data.originalUrl, data.item?.url].filter((url): url is string => Boolean(url));
          const roles: ArtifactRole[] = queue.name === 'url-conversion' ? ['pdf'] : queue.name === 'podcast-transcription' ? ['mp3', 'transcript'] :
            data.item?.mediaType === 'pdf' ? ['pdf'] : data.item?.mediaType === 'transcript' ? ['transcript'] :
              data.item?.mediaType === 'podcast' ? ['mp3'] : ['mp4', 'transcript'];
          return { keys: (await Promise.all(urls.map(keysFor))).flat(), queue: queue.name, roles, state, timestamp: job.timestamp, failedReason: job.failedReason };
        }));
      } catch (error) { logError(errors, `${queue.name}/${state}`, error); return []; }
    })
  ));
  return results.flat();
}

/** Index once rather than compare every bookmark against all 7k artifacts. */
function indexByKeys<T extends { keys: UrlKey[] }>(values: T[]): (keys: UrlKey[]) => T[] {
  const index = new Map<string, Set<T>>();
  for (const value of values) for (const { key } of value.keys) {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key)!.add(value);
  }
  return keys => [...new Set(keys.flatMap(({ key }) => [...(index.get(key) || [])]))];
}

function configuredNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
export function coverageDisabledReason(): string | null {
  if (process.env.COVERAGE_AUDIT_ENABLED === 'false') return 'COVERAGE_AUDIT_ENABLED=false';
  if (!process.env.KARAKEEP_API_BASE || !process.env.KARAKEEP_API_TOKEN) return 'KARAKEEP_API_BASE or KARAKEEP_API_TOKEN unset';
  return null;
}

export async function getLatestCoverageReport(): Promise<CoverageReport | null> {
  const { queueConnection } = await import('../config/redis.js');
  const json = await boundedRead(queueConnection.get(REPORT_KEY));
  return json ? JSON.parse(json) as CoverageReport : null;
}

export async function persistCoverageReport(report: CoverageReport, dataDir: string, redis: Redis): Promise<void> {
  const directory = path.join(dataDir, 'audit');
  const date = new Date(report.startedAt);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const destination = path.join(directory, `coverage-${day}.json`);
  const failure = (scope: string, error: unknown) => {
    logError(report.errors, scope, error);
    report.complete = false;
  };
  const saveFile = async () => {
    await writeFile(`${destination}.tmp`, JSON.stringify(report, null, 2));
    await rename(`${destination}.tmp`, destination);
  };
  let fileSaved = false;
  try {
    await mkdir(directory, { recursive: true });
    // Include today's destination before pruning so exactly 14 remain even
    // on the first run of a new day. Other auditors' files are never touched.
    const reports = [...new Set([path.basename(destination), ...(await readdir(directory))])]
      .filter(name => /^coverage-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
    for (const old of reports.slice(14)) await unlink(path.join(directory, old));
    await saveFile();
    fileSaved = true;
  } catch (error) { failure('report file persistence', error); }
  // Independent destinations: disk trouble must not prevent latest/API from
  // carrying the report, and Redis trouble must still be visible in the file.
  try { await boundedRead(redis.set(REPORT_KEY, JSON.stringify(report, null, 2))); }
  catch (error) {
    failure('report Redis persistence', error);
    if (fileSaved) {
      try { await saveFile(); }
      catch (fileError) { failure('report file error update', fileError); }
    }
  }
}

const problemStatuses = new Set<CoverageStatus>(['unaccounted', 'stale_pending', 'manual_missing', 'partial']);
export function coverageNotification(report: CoverageReport): Parameters<typeof sendDiscordNotification>[0] {
  const problems = report.items.filter(item => problemStatuses.has(item.status));
  const warning = problems.length > 0 || !report.complete;
  const line = (text: string) => text.replace(/[\r\n]+/g, ' ').slice(0, 240);
  return {
    type: warning ? 'warning' : 'info',
    timeoutMs: 10_000,
    title: `Coverage Audit (${report.windowDays}d): ${problems.length} problems${!report.complete ? ' — incomplete' : !warning ? ' — clean' : ''}`,
    description: [!report.complete ? `Audit incomplete: ${report.errors.length} input/persistence error(s); see JSON report.` : '',
      ...problems.slice(0, 15).map(item => `• ${item.status} — ${line(item.title || item.url)} — ${line(item.detail)}`),
    ].filter(Boolean).join('\n').slice(0, 3900) || 'All bookmarks accounted for; known failures are included in counts.',
    fields: Object.entries(report.totals).map(([name, count]) => ({ name, value: String(count), inline: true })),
  };
}

let running = false;
/** Scheduled and API entry point. Logs all failures and never rejects. */
export async function runCoverageAudit(windowDays = configuredNumber('COVERAGE_AUDIT_DAYS', 3, 1, 14)): Promise<CoverageReport | null> {
  const disabled = coverageDisabledReason();
  if (disabled) { console.log(JSON.stringify({ event: 'coverage_audit_disabled', detail: disabled, timestamp: new Date().toISOString() })); return null; }
  if (running) { logError([], 'run', 'Coverage audit already running'); return null; }
  running = true;
  const startedAt = new Date();
  const errors: string[] = [];
  try {
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 14) throw new Error('days must be an integer from 1 to 14');
    const cutoff = startedAt.getTime() - windowDays * DAY;
    console.log(JSON.stringify({ event: 'coverage_audit_start', windowDays, cutoff: new Date(cutoff).toISOString(), timestamp: startedAt.toISOString() }));
    const { queueConnection: redis } = await import('../config/redis.js');
    const dedup = new BookmarkDeduplicator(redis);
    const candidateCache = new Map<string, Promise<string[]>>();
    const candidatesFor = (url: string) => {
      if (!candidateCache.has(url)) candidateCache.set(url, dedup.dedupCandidates(url, { allowNetwork: false, allowSubstackResolve: true }).catch(error => { logError(errors, 'URL candidates', error); return []; }));
      return candidateCache.get(url)!;
    };
    const keysFor: KeyResolver = async url => coverageUrlKeys(url, await candidatesFor(url));
    const base = process.env.KARAKEEP_API_BASE!.replace(/\/$/, '');
    const [bookmarks, artifacts, jobs, retries, rechecks] = await Promise.all([
      fetchCoverageBookmarks(base, process.env.KARAKEEP_API_TOKEN!, cutoff, errors),
      scanCoverageArtifacts(path.resolve(env.DATA_DIR), redis, keysFor, errors),
      readQueueJobs(keysFor, errors),
      boundedRead(redis.hgetall('feed:video-retries:karakeep')).catch(error => { logError(errors, 'video retries', error); return {} as Record<string, string>; }),
      // Tweets waiting for a late Karakeep video asset (poll-worker's
      // media re-check) are pending MP4 work, not partial captures.
      boundedRead(redis.hgetall('feed:media-recheck:karakeep')).catch(error => { logError(errors, 'media recheck', error); return {} as Record<string, string>; }),
    ]);
    const artifactsFor = indexByKeys(artifacts);
    const jobsFor = indexByKeys(jobs);
    let dedupUnavailable = false;
    const items = await mapBounded(bookmarks, async bookmark => {
      const input: CoverageBookmark = { bookmarkId: bookmark.id, createdAt: bookmark.createdAt,
        url: bookmark.content?.url || '', title: bookmark.content?.title || bookmark.title || '', item: null };
      try {
        input.item = buildKarakeepItem(bookmark, base);
        input.url = input.item?.url || input.url;
        input.title = input.item?.title || input.title;
        if (!input.item) {
          input.skipPolicy = `unsupported_content: ${bookmark.content?.type || 'missing'}${bookmark.content?.assetType ? `/${bookmark.content.assetType}` : ''} (poller produces no item)`;
          return classifyBookmark(input, { now: startedAt.getTime(), keys: [], artifacts: [], jobs: [] });
        }
        const keys = await keysFor(input.url);
        const candidates = input.item ? await candidatesFor(input.url) : [];
        let source: string | null = null;
        let seenBefore = false;
        let guidSeen = false;
        if (candidates.length && !dedupUnavailable) {
          try {
            const pipeline = redis.pipeline();
            for (const candidate of candidates) pipeline.hmget(`bookmark:${candidate}`, 'source', 'seenAt');
            pipeline.sismember('feed:guids:karakeep', bookmark.id);
            const replies = await boundedRead(pipeline.exec());
            if (!replies) throw new Error('Empty dedup response');
            for (const [error] of replies) if (error) throw error;
            for (const [, value] of replies.slice(0, -1)) {
              const [candidateSource, seenAt] = value as [string | null, string | null];
              if (candidateSource === 'manual' || !source) source = candidateSource;
              if (seenAt && Date.parse(seenAt) < Date.parse(bookmark.createdAt)) seenBefore = true;
            }
            guidSeen = replies.at(-1)?.[1] === 1;
          } catch (error) {
            // Redis going away must not cost 10s for EACH remaining bookmark.
            dedupUnavailable = true;
            logError(errors, `dedup ${bookmark.id}; remaining dedup reads skipped`, error);
          }
        }
        return classifyBookmark(input, { now: startedAt.getTime(), keys, artifacts: artifactsFor(keys), jobs: jobsFor(keys),
          source, videoRetry: Object.hasOwn(retries, bookmark.id) || Object.hasOwn(rechecks, bookmark.id),
          mediaRebookmark: seenBefore && guidSeen && Boolean(input.item && (input.item.enclosure || expectedCoverageRoles(input.item).includes('mp4') || isApplePodcastsUrl(input.url))),
        });
      } catch (error) {
        logError(errors, `bookmark ${bookmark.id}`, error);
        return { bookmarkId: input.bookmarkId, createdAt: input.createdAt, url: input.url, title: input.title || '',
          expectedRoles: [], foundRoles: [], status: 'unaccounted' as const, detail: 'Bookmark could not be classified; see report errors', matchedBy: [], artifacts: [] };
      }
    });
    const report: CoverageReport = { startedAt: startedAt.toISOString(), windowDays, cutoff: new Date(cutoff).toISOString(),
      ...summarizeCoverage(items), items, complete: errors.length === 0, errors };
    try { await persistCoverageReport(report, path.resolve(env.DATA_DIR), redis); }
    catch (error) { logError(errors, 'report persistence', error); report.complete = false; }
    console.log(JSON.stringify({ event: 'coverage_audit_done', totals: report.totals, problems: items.filter(item => problemStatuses.has(item.status)),
      complete: report.complete, elapsedMs: Date.now() - startedAt.getTime(), timestamp: new Date().toISOString() }));
    await sendDiscordNotification(coverageNotification(report));
    return report;
  } catch (error) { logError(errors, 'run', error); return null; }
  finally { running = false; }
}

let startupTimer: NodeJS.Timeout | null = null;
let runTimer: NodeJS.Timeout | null = null;
function msUntilHour(hour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
export function startCoverageReconciler(): void {
  const disabled = coverageDisabledReason();
  if (disabled) { console.log(JSON.stringify({ event: 'coverage_audit_disabled', detail: disabled, timestamp: new Date().toISOString() })); return; }
  if (startupTimer || runTimer) return;
  const hour = configuredNumber('COVERAGE_AUDIT_HOUR', 23, 0, 23);
  startupTimer = setTimeout(() => {
    void runCoverageAudit();
    runTimer = setInterval(() => { void runCoverageAudit(); }, DAY);
  }, msUntilHour(hour));
  console.log(JSON.stringify({ event: 'coverage_audit_scheduled', hour, timestamp: new Date().toISOString() }));
}
export function stopCoverageReconciler(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
}
