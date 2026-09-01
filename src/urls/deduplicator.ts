/**
 * Redis-based URL deduplication for BOOK-04
 *
 * Two-level deduplication:
 * 1. GUID per feed - tracks items seen in each feed
 * 2. Normalized URL global - detects same URL across feeds
 */
import { Redis } from 'ioredis';
import { normalizeBookmarkUrl } from './normalizer.js';
import { substackDedupCandidates } from './substack-canonical.js';
import { declaredCanonicalCandidates } from './canonical-declaration.js';
import type { FeedSource } from '../feeds/types.js';

const SEEN_URLS_KEY = 'bookmarks:seen-urls';
const SEEN_GUIDS_PREFIX = 'feed:guids:';

export class BookmarkDeduplicator {
  constructor(private redis: Redis) {}

  /**
   * Check if GUID has been seen in this feed
   * GUID is unique per-feed, not globally unique (per RSS spec)
   */
  async isGuidSeen(source: FeedSource, guid: string): Promise<boolean> {
    return await this.redis.sismember(`${SEEN_GUIDS_PREFIX}${source}`, guid) === 1;
  }

  /**
   * Mark GUID as seen for this feed
   */
  async markGuidSeen(source: FeedSource, guid: string): Promise<void> {
    await this.redis.sadd(`${SEEN_GUIDS_PREFIX}${source}`, guid);
  }

  /**
   * All dedup keys a URL answers to. Substack-hosted post URLs expand to the
   * spellings the same post takes across the iOS share sheet, the pub
   * subdomain, and the custom domain (substack-canonical.ts). Everything
   * else gets the normalized URL plus, for the long tail, whatever the page
   * itself declares via rel=canonical / og:url (canonical-declaration.ts) —
   * dedup keys only, guarded, and a failed fetch just means no extra key.
   */
  private async dedupCandidates(url: string): Promise<string[]> {
    const substack = await substackDedupCandidates(url).catch(() => null);
    if (substack) return substack;
    const candidates = new Set([normalizeBookmarkUrl(url)]);
    const declared = await declaredCanonicalCandidates(url).catch(() => null);
    for (const c of declared ?? []) candidates.add(c);
    return [...candidates];
  }

  /**
   * Check if normalized URL has been seen across any feed
   */
  async isUrlSeen(url: string): Promise<boolean> {
    const candidates = await this.dedupCandidates(url);
    const hits = await Promise.all(
      candidates.map((c) => this.redis.sismember(SEEN_URLS_KEY, c))
    );
    return hits.some((h) => h === 1);
  }

  /**
   * Mark URL as seen and store which source provided it
   * Returns the canonical URL for reference
   * 'manual' = manual capture via the Chrome extension — marks the URL so a
   * later Karakeep bookmark of the same URL is skipped by the feed poll
   * instead of re-converting and overwriting the manual capture.
   */
  async markUrlSeen(url: string, source: FeedSource | 'manual'): Promise<string> {
    const candidates = await this.dedupCandidates(url);
    await this.redis.sadd(SEEN_URLS_KEY, ...candidates);
    // Store source in hash for debugging/analytics (primary key only)
    const canonical = candidates[0];
    await this.redis.hset(`bookmark:${canonical}`, 'source', source, 'seenAt', new Date().toISOString());
    return canonical;
  }

  /**
   * Get which source first provided this URL. Checks every candidate
   * spelling so a manual capture recorded under one Substack form is still
   * found when the query arrives as another — the re-bookmark refresh in the
   * poll worker relies on this to avoid clobbering manual captures.
   */
  async getUrlSource(url: string): Promise<FeedSource | 'manual' | null> {
    const candidates = await this.dedupCandidates(url);
    for (const candidate of candidates) {
      const source = await this.redis.hget(`bookmark:${candidate}`, 'source');
      if (source) return source as FeedSource | 'manual';
    }
    return null;
  }

  /**
   * Get deduplication stats for monitoring
   */
  async getStats(): Promise<{ totalUrls: number; matterGuids: number; karakeepGuids: number }> {
    const [totalUrls, matterGuids, karakeepGuids] = await Promise.all([
      this.redis.scard(SEEN_URLS_KEY),
      this.redis.scard(`${SEEN_GUIDS_PREFIX}matter`),
      this.redis.scard(`${SEEN_GUIDS_PREFIX}karakeep`),
    ]);
    return { totalUrls, matterGuids, karakeepGuids };
  }
}
