/**
 * Weekly bin organization for media collection
 * Organizes media files into weekly directories using ISO 8601 week numbers
 */

import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { env } from '../config/env.js';
import type { MediaType, MediaItem } from './types.js';

// Import CommonJS module using require
const require = createRequire(import.meta.url);
const sanitizeFilename = require('sanitize-filename') as (input: string, options?: { replacement?: string | ((substring: string) => string) }) => string;

/**
 * ISO 8601 week information
 */
interface ISOWeek {
  year: number;
  week: number;
}

/**
 * Calculate ISO 8601 week number for a given date
 * ISO week: Monday is first day, week 1 contains January 4
 *
 * @param date - Date to calculate week for
 * @returns ISO week year and number
 */
export function getISOWeekNumber(date: Date): ISOWeek {
  // Create UTC copy to avoid timezone issues
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));

  // Set to nearest Thursday (current date + 4 - current day number)
  // In ISO 8601, week belongs to year that contains the Thursday
  const dayNum = d.getUTCDay() || 7; // Sunday (0) becomes 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  // Get first day of year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));

  // Calculate full weeks to this date
  const weekNum = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

  return { year: d.getUTCFullYear(), week: weekNum };
}

/**
 * Get weekly bin path for a media item
 * Path format: {DATA_DIR}/media/{year}-W{week}/{mediaType}s/
 * Example: ./data/media/2026-W04/videos/
 *
 * @param bookmarkedAt - ISO date string when item was bookmarked
 * @param mediaType - Type of media (video or transcript)
 * @returns Directory path for this week's media
 */
export function getWeeklyBinPath(bookmarkedAt: string, mediaType: MediaType): string {
  const date = new Date(bookmarkedAt);
  const { year, week } = getISOWeekNumber(date);

  // Pad week number to 2 digits (W04 not W4)
  const weekStr = week.toString().padStart(2, '0');

  // DATA_DIR from env config (defaults to './data')
  const dataDir = env.DATA_DIR || './data';

  // Pluralize media type (video -> videos, transcript -> transcripts)
  const mediaFolder = `${mediaType}s`;

  return path.join(dataDir, 'media', `${year}-W${weekStr}`, mediaFolder);
}

/**
 * Ensure weekly bin directory exists
 * Creates directory recursively if it doesn't exist
 *
 * @param binPath - Directory path to create
 * @returns The bin path (for chaining)
 */
export async function ensureWeeklyBinExists(binPath: string): Promise<string> {
  await mkdir(binPath, { recursive: true });
  return binPath;
}

/**
 * Get sanitized filename for a media item
 * Uses title if available, otherwise falls back to URL hostname
 *
 * @param item - Media item with metadata
 * @returns Sanitized filename with appropriate extension
 */
export function getMediaFilename(item: MediaItem): string {
  // Use title if available, otherwise extract from URL
  let baseName: string;

  if (item.title) {
    baseName = item.title;
  } else {
    // Fallback to URL hostname
    try {
      const url = new URL(item.url);
      baseName = url.hostname;
    } catch {
      // If URL parsing fails, use a generic name
      baseName = 'media';
    }
  }

  // Sanitize the base name
  baseName = sanitizeFilename(baseName);

  // Determine file extension from enclosure MIME type
  let extension = '';

  if (item.enclosure.type.includes('video/mp4')) {
    extension = '.mp4';
  } else if (item.enclosure.type.includes('video/webm')) {
    extension = '.webm';
  } else if (item.enclosure.type.includes('application/pdf')) {
    extension = '.pdf';
  } else if (item.enclosure.type.includes('video/')) {
    // Generic video
    extension = '.mp4';
  } else {
    // Unknown type, try to extract from URL
    try {
      const url = new URL(item.enclosure.url);
      const urlPath = url.pathname;
      const lastDot = urlPath.lastIndexOf('.');
      if (lastDot > 0) {
        extension = urlPath.substring(lastDot);
      }
    } catch {
      // Fallback
      extension = item.mediaType === 'video' ? '.mp4' : '.pdf';
    }
  }

  return `${baseName}${extension}`;
}
