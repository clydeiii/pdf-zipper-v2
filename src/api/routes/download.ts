/**
 * REST API routes for ZIP download
 *
 * GET /api/download/zip - Download multiple files as a ZIP archive (via query params)
 * POST /api/download/zip - Download multiple files as a ZIP archive (via body)
 */

import { Router, Request, Response } from 'express';
import archiver from 'archiver';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { env } from '../../config/env.js';

export const downloadRouter = Router();

/**
 * Shared handler for ZIP download (works for both GET and POST)
 */
async function handleZipDownload(
  files: string[] | undefined,
  weekId: string | undefined,
  res: Response
): Promise<void> {
  // Validate files array is present and non-empty
  if (!files || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({
      error: 'files array is required and must be non-empty',
    });
    return;
  }

  // Validate each file path doesn't contain ".." (path traversal prevention)
  for (const filePath of files) {
    if (filePath.includes('..')) {
      res.status(400).json({
        error: 'Path traversal detected in file path',
        path: filePath,
      });
      return;
    }
  }

  // Set ZIP response headers with timestamp for unique filenames
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-01-24T13-45-30
  const filename = `${weekId || 'files'}-${timestamp}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Prevent caching issues with proxies
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Create archiver instance with zip format and compression level 6
  const archive = archiver('zip', {
    zlib: { level: 6 }, // Balanced compression
  });

  // Register error handler BEFORE finalize (critical!)
  archive.on('error', (err: Error) => {
    console.error('Archive creation error:', {
      error: err.message,
      filename,
      timestamp: new Date().toISOString(),
    });

    // If response headers not sent yet, respond with 500
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to create ZIP archive',
      });
    }
  });

  // Register warning handler for non-fatal issues
  archive.on('warning', (err: archiver.ArchiverError) => {
    if (err.code === 'ENOENT') {
      console.warn('File not found in archive:', {
        error: err.message,
        filename,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.warn('Archive warning:', {
        code: err.code,
        error: err.message,
        filename,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Pipe archive to response
  archive.pipe(res);

  // Add each file to the archive
  for (const filePath of files) {
    const fullPath = path.join(env.DATA_DIR, filePath);
    const basename = path.basename(filePath);

    if (fs.existsSync(fullPath)) {
      try {
        archive.file(fullPath, { name: basename });
      } catch (err) {
        console.warn('Failed to add file to archive:', {
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
      }
    } else {
      console.warn('File not found, skipping:', {
        path: filePath,
        fullPath,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Finalize the archive (triggers streaming)
  await archive.finalize();
}

/**
 * GET /zip - Download multiple files as a ZIP archive
 *
 * Query params:
 * - files: comma-separated list of paths relative to DATA_DIR
 * - weekId: optional, used for ZIP filename
 *
 * This endpoint is preferred for browser downloads as it works better with
 * HTTPS proxies and avoids Chrome's "insecure download blocked" warnings.
 */
downloadRouter.get('/zip', async (req: Request, res: Response): Promise<void> => {
  const filesParam = req.query.files as string | undefined;
  const weekId = req.query.weekId as string | undefined;

  // Parse comma-separated file paths
  const files = filesParam ? filesParam.split(',').map(f => decodeURIComponent(f.trim())) : undefined;

  await handleZipDownload(files, weekId, res);
});

/**
 * POST /zip - Download multiple files as a ZIP archive
 *
 * Request body: { files: string[], weekId?: string }
 * - files: array of paths relative to DATA_DIR (e.g., "media/2026-W04/videos/example.mp4")
 * - weekId: optional, used for ZIP filename (defaults to "files")
 *
 * Response: Streaming ZIP archive
 * - Content-Type: application/zip
 * - Content-Disposition: attachment; filename="{weekId || 'files'}.zip"
 *
 * Returns:
 * - 200 OK with ZIP stream on success
 * - 400 Bad Request if files array invalid or contains path traversal
 * - 500 Internal Server Error on archive creation failure
 */
downloadRouter.post('/zip', async (req: Request, res: Response): Promise<void> => {
  let { files, weekId } = req.body as { files?: string[] | string; weekId?: string };

  // Handle form-urlencoded data where files is a JSON string
  if (typeof files === 'string') {
    try {
      files = JSON.parse(files);
    } catch {
      res.status(400).json({ error: 'Invalid files format' });
      return;
    }
  }

  await handleZipDownload(files as string[] | undefined, weekId, res);
});
