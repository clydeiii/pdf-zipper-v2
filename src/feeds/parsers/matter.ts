import Parser from 'rss-parser';
import { normalizeBookmarkUrl } from '../../urls/normalizer.js';
import type { BookmarkItem } from '../types.js';

/**
 * Custom fields for Matter RSS feed
 * Matter may include Dublin Core extensions for creator/date
 */
type MatterFeedItem = {
  guid?: string;
  link?: string;
  title?: string;
  isoDate?: string;
  creator?: string;
  'dc:creator'?: string;
  'dc:date'?: string;
  enclosure?: {
    url?: string;
    type?: string;
    length?: string;
  };
};

const parser = new Parser<Record<string, unknown>, MatterFeedItem>({
  customFields: {
    item: ['guid', 'dc:creator', 'dc:date', 'enclosure'],
  },
});

/**
 * Parse Matter RSS feed and extract bookmark items
 *
 * Handles conditional requests (ETag/If-Modified-Since) for efficiency.
 * Returns empty array if feed hasn't changed (304 response).
 *
 * @param feedUrl - Matter RSS feed URL
 * @param cache - Previous ETag/Last-Modified for conditional request
 */
export async function parseMatterFeed(
  feedUrl: string,
  cache?: { etag?: string; lastModified?: string }
): Promise<{
  items: BookmarkItem[];
  cache: { etag?: string; lastModified?: string };
  wasModified: boolean;
}> {
  const headers: Record<string, string> = {};

  if (cache?.etag) {
    headers['If-None-Match'] = cache.etag;
  }
  if (cache?.lastModified) {
    headers['If-Modified-Since'] = cache.lastModified;
  }

  const response = await fetch(feedUrl, { headers });

  // 304 Not Modified - feed unchanged
  if (response.status === 304) {
    return {
      items: [],
      cache: cache || {},
      wasModified: false,
    };
  }

  if (!response.ok) {
    throw new Error(`Matter feed fetch failed: HTTP ${response.status}`);
  }

  const xml = await response.text();
  const feed = await parser.parseString(xml);

  const items: BookmarkItem[] = [];

  for (const item of feed.items) {
    const url = item.link;
    if (!url) continue;

    const guid = item.guid || url;

    const bookmarkItem: BookmarkItem = {
      url,
      canonicalUrl: normalizeBookmarkUrl(url),
      guid,
      source: 'matter',
      title: item.title,
      creator: item.creator || item['dc:creator'],
      bookmarkedAt: item.isoDate || item['dc:date'],
    };

    // Extract PDF transcript enclosure if present
    if (item.enclosure?.url && item.enclosure.type === 'application/pdf') {
      bookmarkItem.enclosure = {
        url: item.enclosure.url,
        type: item.enclosure.type,
        length: item.enclosure.length ? parseInt(item.enclosure.length, 10) : undefined,
      };
      bookmarkItem.mediaType = 'transcript';
    }

    items.push(bookmarkItem);
  }

  return {
    items,
    cache: {
      etag: response.headers.get('etag') || undefined,
      lastModified: response.headers.get('last-modified') || undefined,
    },
    wasModified: true,
  };
}
