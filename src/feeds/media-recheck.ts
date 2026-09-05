/**
 * Dependency-free helpers for the tweet late-video re-check (see
 * poll-worker.ts for the mechanism). Kept apart from poll-worker/monitor so
 * they can be unit-tested without instantiating BullMQ queues — importing
 * monitor.js opens Redis connections and keeps `node --test` alive forever.
 */
import type { BookmarkItem } from './types.js';

export function isTweetUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|mobile|m)\./, '');
    return host === 'x.com' || host === 'twitter.com';
  } catch { return false; }
}

/** A tweet link with no video asset yet — the only case worth re-checking. */
export function needsMediaRecheck(item: BookmarkItem): boolean {
  return isTweetUrl(item.url) && !item.enclosure && !item.mediaType;
}

/**
 * Job id for a media-collection job: dedupes by canonical URL. BullMQ job
 * ids cannot contain ':'; everything non-alphanumeric becomes '_'. Shared by
 * the metadata worker and the poll worker's late-video re-check so both
 * paths collapse onto the same job.
 */
export function mediaJobId(canonicalUrl: string): string {
  return `media-${canonicalUrl.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
