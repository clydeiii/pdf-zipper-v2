/**
 * Redis-based URL deduplication for BOOK-04
 *
 * Two-level deduplication:
 * 1. GUID per feed - tracks items seen in each feed
 * 2. Normalized URL global - detects same URL across feeds
 */
import { Redis } from 'ioredis';
import { normalizeBookmarkUrl } from './normalizer.js';
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
   * Check if normalized URL has been seen across any feed
   */
  async isUrlSeen(url: string): Promise<boolean> {
    const canonical = normalizeBookmarkUrl(url);
    return await this.redis.sismember(SEEN_URLS_KEY, canonical) === 1;
  }

  /**
   * Mark URL as seen and store which source provided it
   * Returns the canonical URL for reference
   */
  async markUrlSeen(url: string, source: FeedSource): Promise<string> {
    const canonical = normalizeBookmarkUrl(url);
    await this.redis.sadd(SEEN_URLS_KEY, canonical);
    // Store source in hash for debugging/analytics
    await this.redis.hset(`bookmark:${canonical}`, 'source', source, 'seenAt', new Date().toISOString());
    return canonical;
  }

  /**
   * Get which source first provided this URL
   */
  async getUrlSource(url: string): Promise<FeedSource | null> {
    const canonical = normalizeBookmarkUrl(url);
    const source = await this.redis.hget(`bookmark:${canonical}`, 'source');
    return source as FeedSource | null;
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
