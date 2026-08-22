/**
 * URL normalization for deduplication (BOOK-03)
 *
 * Handles:
 * - Strips www subdomain
 * - Removes tracking params (utm_*, fbclid, ref, source)
 * - Strips hash fragments
 * - Removes trailing slashes
 * - Sorts query parameters for consistent comparison
 */
import normalizeUrl from 'normalize-url';

/**
 * Collapse every URL spelling of a YouTube video to one canonical dedup key.
 *
 * The phone share sheet mints a FRESH `is=` (and historically `si=`) token on
 * every share, so sharing the same video twice creates two Karakeep bookmarks
 * with different URL strings — observed live 2026-08-22: three bookmarks of
 * one video, three distinct `is=` tokens, each sailing past string-level
 * dedup and costing a full duplicate download. youtu.be short links are the
 * same video as youtube.com/watch. Identity is the video id, nothing else —
 * timestamps (`t=`) are deliberately dropped here because this canonical form
 * is ONLY a dedup key; the item's `url` field keeps the original string.
 *
 * Returns null for non-video YouTube URLs (channels, playlists, search),
 * which fall through to generic normalization. Exported for testing.
 */
export function canonicalizeYouTubeUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] || null;
  } else if (host === 'youtube.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/);
      id = m ? m[1] : null;
    }
  }
  if (!id || !/^[\w-]{8,16}$/.test(id)) return null;
  return `https://youtube.com/watch?v=${id}`;
}

/**
 * Normalize URL to canonical form for deduplication (BOOK-03)
 */
export function normalizeBookmarkUrl(rawUrl: string): string {
  const youtube = canonicalizeYouTubeUrl(rawUrl);
  if (youtube) return youtube;
  return normalizeUrl(rawUrl, {
    stripWWW: true,
    removeQueryParameters: [
      /^utm_\w+/i,     // UTM tracking
      'ref',
      'source',
      'fbclid',
      'gclid',
      'msclkid',
    ],
    stripHash: true,
    stripTextFragment: true,
    removeTrailingSlash: true,
    removeSingleSlash: true,
    sortQueryParameters: true,
  });
}
