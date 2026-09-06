/**
 * Dead-URL detection and pruning.
 *
 * A URL that no longer exists at its origin is not a capture problem: a 404
 * page renders as a ~100-char shell, fails the content gate as "truncated",
 * gets queued for AI self-healing, and the fix batch then replays it every
 * 12h as a "verification" — forever (observed 2026-09-05 with a mis-pathed
 * anthropic.com/news/… bookmark, and a deleted tweet reported by Nitter as
 * 404 but classified "rate_limited"). Nothing to fix, nothing to retry,
 * nothing worth keeping bookmarked.
 *
 * Detection is deliberately narrow: only an origin 404/410 (or Nitter's 404
 * for a tweet) counts as dead. 401/403/429/5xx are bot walls and outages —
 * "unknown", never pruned. x.com itself blocks plain fetches, so tweets are
 * probed through Nitter, which returns a real 404 for deleted statuses.
 */
import { env } from '../config/env.js';
import { normalizeBookmarkUrl } from '../urls/normalizer.js';
// fix/pending.js opens a Redis connection at import; loaded lazily inside
// pruneDeadUrl so the probe stays unit-testable without a broker.

export type OriginStatus = 'dead' | 'alive' | 'unknown';
export type StatusFetcher = (url: string) => Promise<number>;

const PROBE_TIMEOUT_MS = 8_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchStatus(url: string): Promise<number> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return res.status;
}

/** The URL to probe: tweets go through Nitter (x.com blocks plain fetches). Exported for testing. */
export function probeUrlFor(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^(www|mobile)\./, '');
    const m = parsed.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    if ((host === 'x.com' || host === 'twitter.com') && m && env.NITTER_HOST) {
      return `${env.NITTER_HOST.replace(/\/$/, '')}/${m[1]}/status/${m[2]}`;
    }
  } catch {
    /* fall through */
  }
  return url;
}

/** Exported for testing (inject a status fetcher). */
export async function probeOriginStatus(
  url: string,
  fetcher: StatusFetcher = fetchStatus
): Promise<OriginStatus> {
  try {
    const status = await fetcher(probeUrlFor(url));
    if (status === 404 || status === 410) return 'dead';
    if (status >= 200 && status < 400) return 'alive';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Remove every trace that would make a dead URL come back: pending self-heal
 * items and the Karakeep bookmark(s) behind it. Non-fatal — returns counts.
 */
export async function pruneDeadUrl(
  url: string,
  context: { jobId?: string } = {}
): Promise<{ pendingFixes: number; karakeepBookmarks: number }> {
  const result = { pendingFixes: 0, karakeepBookmarks: 0 };
  const [{ removePendingFixesByUrl }, { deleteKarakeepBookmarksByUrl }] = await Promise.all([
    import('../fix/pending.js'),
    import('../feeds/karakeep-api.js'),
  ]);
  try {
    result.pendingFixes = await removePendingFixesByUrl(url);
  } catch (error) {
    console.warn(`[dead-url] pending-fix removal failed for ${url}: ${error instanceof Error ? error.message : error}`);
  }
  try {
    result.karakeepBookmarks = await deleteKarakeepBookmarksByUrl(url);
  } catch (error) {
    console.warn(`[dead-url] Karakeep removal failed for ${url}: ${error instanceof Error ? error.message : error}`);
  }
  console.log(JSON.stringify({
    event: 'dead_url_pruned',
    url,
    canonical: normalizeBookmarkUrl(url),
    jobId: context.jobId,
    ...result,
    timestamp: new Date().toISOString(),
  }));
  return result;
}
