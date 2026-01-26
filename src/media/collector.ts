/**
 * Streaming media collector
 * Downloads media files efficiently without loading into memory
 */

import { createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import * as https from 'node:https';
import * as http from 'node:http';
import * as path from 'node:path';
import { getWeeklyBinPath, ensureWeeklyBinExists, getMediaFilename } from './organization.js';
import { env } from '../config/env.js';
import type { MediaItem, MediaCollectionResult } from './types.js';

/**
 * Get authorization header for Karakeep asset downloads
 * Returns auth headers if URL is a Karakeep asset endpoint
 */
function getAuthHeaders(url: string): Record<string, string> {
  // Check if this is a Karakeep asset URL
  if (env.KARAKEEP_FEED_URL && url.includes('/api/assets/')) {
    try {
      const karakeepUrl = new URL(env.KARAKEEP_FEED_URL);
      const assetUrl = new URL(url);

      // Check if asset URL matches Karakeep host
      if (assetUrl.host === karakeepUrl.host || assetUrl.host === 'localhost:3001') {
        const token = karakeepUrl.searchParams.get('token');
        if (token) {
          return { 'Authorization': `Bearer ${token}` };
        }
      }
    } catch {
      // URL parsing failed, return empty headers
    }
  }
  return {};
}

/**
 * Download timeout for large video files (5 minutes)
 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Download media file to weekly bin with streaming
 * Skips download if file already exists and has content
 *
 * @param item - Media item with enclosure URL
 * @returns Collection result with success/failure details
 */
export async function downloadMedia(item: MediaItem): Promise<MediaCollectionResult> {
  const startTime = Date.now();

  try {
    // Calculate destination path
    const binPath = getWeeklyBinPath(
      item.bookmarkedAt || new Date().toISOString(),
      item.mediaType
    );
    await ensureWeeklyBinExists(binPath);

    const filename = getMediaFilename(item);
    const filePath = path.join(binPath, filename);

    // Skip if file already exists and has content (idempotent)
    if (existsSync(filePath)) {
      const stats = statSync(filePath);
      if (stats.size > 0) {
        const duration = Date.now() - startTime;
        return {
          success: true,
          item,
          filePath,
          fileSize: stats.size,
          downloadDuration: duration,
        };
      }
      // File exists but is empty - delete and re-download
      unlinkSync(filePath);
    }

    // Determine protocol from URL
    const enclosureUrl = new URL(item.enclosure.url);
    const protocol = enclosureUrl.protocol === 'https:' ? https : http;

    // Download with streaming using AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      // Get auth headers for protected endpoints (e.g., Karakeep assets)
      const authHeaders = getAuthHeaders(item.enclosure.url);

      // Fetch media with streaming
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const request = protocol.get(
          item.enclosure.url,
          {
            signal: controller.signal as any,
            headers: authHeaders,
          },
          (res) => {
            if (res.statusCode === 200) {
              resolve(res);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
          }
        );

        request.on('error', reject);
      });

      // Stream to file using pipeline (handles backpressure)
      const fileStream = createWriteStream(filePath);
      await pipeline(response, fileStream);

      clearTimeout(timeoutId);

      // Verify download
      if (!existsSync(filePath)) {
        return {
          success: false,
          item,
          error: 'File not found after download',
          reason: 'file_missing',
        };
      }

      const stats = statSync(filePath);
      if (stats.size === 0) {
        unlinkSync(filePath);
        return {
          success: false,
          item,
          error: 'Downloaded file is empty',
          reason: 'download_failed',
        };
      }

      // Optional: Verify against Content-Length if available
      const contentLength = response.headers['content-length'];
      if (contentLength && parseInt(contentLength, 10) !== stats.size) {
        // Size mismatch - might be incomplete download
        // Log warning but don't fail (some servers don't send accurate Content-Length)
        console.warn(
          `Size mismatch for ${filename}: expected ${contentLength}, got ${stats.size}`
        );
      }

      const duration = Date.now() - startTime;

      return {
        success: true,
        item,
        filePath,
        fileSize: stats.size,
        downloadDuration: duration,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    // Clean up partial file on error
    const binPath = getWeeklyBinPath(
      item.bookmarkedAt || new Date().toISOString(),
      item.mediaType
    );
    const filename = getMediaFilename(item);
    const filePath = path.join(binPath, filename);

    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Determine error reason
    let reason: 'download_failed' | 'timeout' | 'file_missing' = 'download_failed';
    let errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('abort') || errorMessage.includes('timeout')) {
      reason = 'timeout';
    }

    return {
      success: false,
      item,
      error: errorMessage,
      reason,
    };
  }
}
