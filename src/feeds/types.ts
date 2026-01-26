/**
 * Type definitions for bookmark integration
 * Supports META-01 (enriched metadata) and META-02 (feed-provided metadata)
 */

import type { MediaEnclosure, MediaType } from '../media/types.js';

export type FeedSource = 'matter' | 'karakeep';

export interface BookmarkItem {
  // Core identity
  url: string;              // Original URL from feed
  canonicalUrl: string;     // Normalized URL for deduplication
  guid: string;             // RSS GUID (unique per-feed, not globally unique)
  source: FeedSource;

  // Feed-provided metadata (META-02)
  title?: string;
  creator?: string;         // dc:creator or author
  bookmarkedAt?: string;    // ISO date from feed

  // Enriched metadata (META-01) - added later by metadata worker
  author?: string;
  publishedAt?: string;
  description?: string;
  image?: string;
  publisher?: string;

  // Media enclosure (optional - only set when RSS feed includes media files)
  enclosure?: MediaEnclosure;
  mediaType?: MediaType;
}

export interface FeedPollResult {
  source: FeedSource;
  feedUrl: string;
  newItems: BookmarkItem[];
  totalItemsInFeed: number;
  pollDuration: number;     // milliseconds
  wasModified: boolean;     // false if 304 Not Modified
}

export interface FeedCacheState {
  etag?: string;
  lastModified?: string;
}
