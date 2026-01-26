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
 * Normalize URL to canonical form for deduplication (BOOK-03)
 */
export function normalizeBookmarkUrl(rawUrl: string): string {
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
