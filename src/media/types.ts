/**
 * Type definitions for media collection
 * Supports collecting mp4 files from Karakeep and PDF transcripts from Matter
 */

export type MediaType = 'video' | 'transcript' | 'podcast' | 'pdf';

export interface MediaEnclosure {
  url: string;           // Direct download URL from RSS enclosure
  type: string;          // MIME type like 'video/mp4' or 'application/pdf'
  length?: number;       // File size in bytes (optional, from RSS)
  /**
   * How to fetch `url`. Default 'http' streams it directly (Karakeep assets,
   * RSS enclosures). 'yt-dlp' means `url` is a *page* to extract from rather
   * than a file to download — used where the host streams HLS behind a login
   * (Patreon), so there is no single URL to GET.
   */
  downloadVia?: 'http' | 'yt-dlp';
}

export interface MediaItem {
  // Core identity (extends BookmarkItem pattern)
  url: string;           // Original bookmark URL
  canonicalUrl: string;  // Normalized URL for deduplication
  guid: string;          // RSS GUID
  source: 'matter' | 'karakeep';

  // Media-specific
  mediaType: MediaType;
  enclosure: MediaEnclosure;

  // Optional metadata
  title?: string;
  bookmarkedAt?: string; // ISO date
}

/**
 * Result of media collection operation
 * Discriminated union by success boolean
 */
export type MediaCollectionResult =
  | {
      success: true;
      item: MediaItem;
      filePath: string;       // Local file path where media was saved
      fileSize: number;       // Actual file size in bytes
      downloadDuration: number; // Milliseconds
    }
  | {
      success: false;
      item: MediaItem;
      error: string;          // Error message
      /**
       * 'no_media' means the source genuinely has nothing to download (a
       * text-only Patreon post). It is terminal, not transient — the worker
       * must not retry it.
       */
      reason: 'download_failed' | 'timeout' | 'file_missing' | 'no_media';
    };
