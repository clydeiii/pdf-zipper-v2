import { normalizeBookmarkUrl } from '../../urls/normalizer.js';
import type { BookmarkItem } from '../types.js';

/**
 * Karakeep API bookmark structure
 */
interface KarakeepBookmark {
  id: string;
  createdAt: string;
  modifiedAt?: string;
  title?: string | null;
  content?: {
    type: string;  // 'link', 'asset', 'text', etc.
    url?: string;
    title?: string;
    description?: string;
    author?: string;
    videoAssetId?: string;
    // For asset type (uploaded files like PDFs)
    assetType?: string;  // 'pdf', 'image', etc.
    assetId?: string;
    fileName?: string;
  };
  assets?: Array<{
    id: string;
    assetType: string;
    fileName?: string;
  }>;
}

interface KarakeepApiResponse {
  bookmarks: KarakeepBookmark[];
  nextCursor?: string;
}

/**
 * Callback to check if a GUID has been seen before
 * Used for pagination - stop fetching when we hit seen items
 */
export type GuidSeenChecker = (guid: string) => Promise<boolean>;

/**
 * Parse Karakeep API and extract bookmark items with pagination support
 *
 * Karakeep uses a JSON API with Bearer token authentication.
 * The feedUrl should be the base URL (e.g., http://localhost:3001)
 * and the token is extracted from the query string.
 *
 * PAGINATION: If isGuidSeen callback is provided, the parser will fetch
 * multiple pages until it encounters a GUID that has already been seen.
 * This ensures we catch up on ALL missed bookmarks after an outage.
 *
 * @param feedUrl - Karakeep API URL with token (e.g., http://localhost:3001/api/v1/bookmarks?token=...)
 * @param cache - Previous state for tracking seen bookmarks (etag/lastModified)
 * @param isGuidSeen - Optional callback to check if GUID already processed (enables pagination catchup)
 */
export async function parseKarakeepFeed(
  feedUrl: string,
  cache?: { etag?: string; lastModified?: string },
  isGuidSeen?: GuidSeenChecker
): Promise<{
  items: BookmarkItem[];
  cache: { etag?: string; lastModified?: string };
  wasModified: boolean;
}> {
  // Parse the feedUrl to extract base URL and token
  const url = new URL(feedUrl);
  const token = url.searchParams.get('token');

  if (!token) {
    throw new Error('Karakeep feed URL must include token parameter');
  }

  // Build the API endpoint URL
  const baseUrl = `${url.protocol}//${url.host}`;

  const allItems: BookmarkItem[] = [];
  let nextCursor: string | undefined;
  let pageCount = 0;
  const MAX_PAGES = 20; // Safety limit to prevent infinite loops

  // Paginate through Karakeep API until we hit seen items or run out of pages
  do {
    pageCount++;

    // Build URL with optional cursor for pagination
    let apiUrl = `${baseUrl}/api/v1/bookmarks?limit=50`;
    if (nextCursor) {
      apiUrl += `&cursor=${encodeURIComponent(nextCursor)}`;
    }

    const response = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Karakeep API fetch failed: HTTP ${response.status}`);
    }

    const data: KarakeepApiResponse = await response.json();

    // Track if we found any seen items on this page
    let foundSeenItem = false;
    let newItemsOnPage = 0;

    for (const bookmark of data.bookmarks) {
      // Check if we've already processed this GUID (if checker provided)
      if (isGuidSeen && await isGuidSeen(bookmark.id)) {
        foundSeenItem = true;
        // Don't break - continue to count but don't add duplicates
        continue;
      }

      // Handle different bookmark content types
      const contentType = bookmark.content?.type;

      // Skip bookmarks without content
      if (!bookmark.content) {
        continue;
      }

      let bookmarkItem: BookmarkItem | null = null;
      const guid = bookmark.id;

      if (contentType === 'link' && bookmark.content.url) {
        // Standard link bookmark
        const bookmarkUrl = bookmark.content.url;
        bookmarkItem = {
          url: bookmarkUrl,
          canonicalUrl: normalizeBookmarkUrl(bookmarkUrl),
          guid,
          source: 'karakeep',
          title: bookmark.content.title || bookmark.title || undefined,
          creator: bookmark.content.author,
          bookmarkedAt: bookmark.createdAt,
        };

        // Check for video asset
        const videoAsset = bookmark.assets?.find(a => a.assetType === 'video');
        if (videoAsset && bookmark.content.videoAssetId) {
          // Karakeep serves assets at /api/assets/{assetId}
          bookmarkItem.enclosure = {
            url: `${baseUrl}/api/assets/${bookmark.content.videoAssetId}`,
            type: 'video/mp4',
            length: undefined,
          };
          bookmarkItem.mediaType = 'video';
        }
      } else if (contentType === 'asset' && bookmark.content.assetType === 'pdf' && bookmark.content.assetId) {
        // Uploaded PDF file - create a direct URL to the asset
        const pdfUrl = `${baseUrl}/api/assets/${bookmark.content.assetId}`;
        // Filename may be in content.fileName OR in the assets array
        const assetId = bookmark.content!.assetId;
        const assetInfo = bookmark.assets?.find(a => a.id === assetId);
        const fileName = bookmark.content.fileName || assetInfo?.fileName || `pdf-${bookmark.content.assetId.slice(0, 8)}.pdf`;

        bookmarkItem = {
          url: pdfUrl,
          canonicalUrl: pdfUrl,  // Use asset URL as canonical (no normalization needed)
          guid,
          source: 'karakeep',
          title: bookmark.title || fileName.replace(/\.pdf$/i, ''),
          bookmarkedAt: bookmark.createdAt,
          mediaType: 'pdf',
          enclosure: {
            url: pdfUrl,
            type: 'application/pdf',
            length: undefined,
          },
        };

        console.log(`Karakeep PDF asset: ${fileName} -> ${pdfUrl}`);
      }

      // Skip if we couldn't create a bookmark item
      if (!bookmarkItem) {
        continue;
      }

      allItems.push(bookmarkItem);
      newItemsOnPage++;
    }

    // Log pagination progress
    if (pageCount > 1 || newItemsOnPage > 0) {
      console.log(`Karakeep page ${pageCount}: ${newItemsOnPage} new items, ${data.bookmarks.length} total on page`);
    }

    // Stop pagination if:
    // 1. We found a seen item (caught up to where we left off)
    // 2. No more pages (nextCursor is empty)
    // 3. Hit max pages safety limit
    if (foundSeenItem) {
      console.log(`Karakeep catchup complete: found previously seen item on page ${pageCount}`);
      break;
    }

    nextCursor = data.nextCursor;

    if (pageCount >= MAX_PAGES) {
      console.warn(`Karakeep pagination hit safety limit of ${MAX_PAGES} pages`);
      break;
    }

  } while (nextCursor);

  if (pageCount > 1) {
    console.log(`Karakeep pagination: fetched ${pageCount} pages, ${allItems.length} total new items`);
  }

  return {
    items: allItems,
    cache: {
      etag: cache?.etag,
      lastModified: cache?.lastModified,
    },
    wasModified: allItems.length > 0,
  };
}
