/**
 * Type definitions for media collection
 * Supports collecting mp4 files from Karakeep and PDF transcripts from Matter
 */

export type MediaType = 'video' | 'transcript' | 'podcast' | 'pdf';

export interface MediaEnclosure {
  url: string;           // Direct download URL from RSS enclosure
  type: string;          // MIME type like 'video/mp4' or 'application/pdf'
  length?: number;       // File size in bytes (optional, from RSS)
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
      reason: 'download_failed' | 'timeout' | 'file_missing';
    };
