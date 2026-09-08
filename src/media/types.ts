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
  /**
   * Basenames of earlier library files this capture supersedes (same source,
   * different filename). Set only when the predecessor is known — a rerun or
   * a batch recapture — and written to the MP4 `replaces` tag and the
   * transcript PDF's `Replaces` field so the KB consumer can drop the old
   * files. Omitted when unknown; the source URL remains the stable identity.
   */
  replaces?: string[];
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
      /** Further videos of the same post, published as `<base>-N.mp4` (multi-video tweets). */
      extraFiles?: string[];
    }
  | {
      success: false;
      item: MediaItem;
      error: string;          // Error message
      /**
       * Terminal reasons (the worker completes the job without retrying):
       *   'no_media'        — the source genuinely has no video (text-only post)
       *   'unavailable'     — deleted / private / removed
       *   'auth_required'   — a gate our cookies could not open
       *   'unsupported'     — DRM / geo-restriction / unsupported extractor
       *   'policy_exceeded' — over the download size cap
       * Everything else is retried with the queue's backoff. "Terminal" must
       * never be inferred from a vague downloader message — see
       * classifyYtDlpFailure in ytdlp-video.ts.
       */
      reason: 'download_failed' | 'timeout' | 'file_missing' | 'no_media'
        | 'unavailable' | 'auth_required' | 'unsupported' | 'policy_exceeded';
    };
