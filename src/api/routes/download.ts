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
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { env } from '../../config/env.js';
import { resolveWithinRoot } from '../../utils/paths.js';

export const downloadRouter = Router();

/** Where persisted export ZIPs live (served via /api/file/exports/<name>). */
const EXPORTS_SUBDIR = 'exports';
/** Keep only the few newest export ZIPs — each can be GBs. */
const KEEP_EXPORTS = 3;

/** Prune data/exports/ to the KEEP_EXPORTS newest .zip files (best-effort). */
async function pruneExports(exportsDir: string): Promise<void> {
  try {
    const names = (await readdir(exportsDir)).filter((n) => n.toLowerCase().endsWith('.zip'));
    const withTimes = await Promise.all(
      names.map(async (n) => ({ n, m: (await stat(path.join(exportsDir, n))).mtimeMs }))
    );
    withTimes.sort((a, b) => b.m - a.m);
    for (const { n } of withTimes.slice(KEEP_EXPORTS)) {
      await unlink(path.join(exportsDir, n)).catch(() => {});
    }
  } catch { /* best-effort */ }
}

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

  const dataDir = path.resolve(env.DATA_DIR);

  // Validate each file path resolves within DATA_DIR (path traversal prevention)
  for (const filePath of files) {
    if (!resolveWithinRoot(dataDir, filePath)) {
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

  // Persist the ZIP to disk WHILE streaming it to the client (tee). If the
  // browser download dies mid-transfer (a 2.5GB stream can crash Chrome), the
  // on-disk copy still finalizes independently and stays downloadable at
  // /api/file/exports/<filename> — and a download manager can resume it.
  const exportsDir = path.join(dataDir, EXPORTS_SUBDIR);
  let diskOut: fs.WriteStream | undefined;
  try {
    await mkdir(exportsDir, { recursive: true });
    diskOut = fs.createWriteStream(path.join(exportsDir, filename));
    diskOut.on('error', (err) => {
      console.warn('Export disk-copy write failed (non-fatal):', err instanceof Error ? err.message : err);
    });
    archive.pipe(diskOut); // disk copy — survives a client abort
  } catch (err) {
    console.warn('Could not open export disk copy (streaming only):', err instanceof Error ? err.message : err);
  }

  // Pipe archive to response (client stream — starts immediately)
  archive.pipe(res);

  // Add each file to the archive
  for (const filePath of files) {
    const fullPath = resolveWithinRoot(dataDir, filePath);
    const basename = path.basename(filePath);

    if (!fullPath) {
      console.warn('File path rejected (outside DATA_DIR), skipping:', {
        path: filePath,
        timestamp: new Date().toISOString(),
      });
      continue;
    }

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

  // Finalize the archive (triggers streaming to both client and disk)
  await archive.finalize();

  // Once the disk copy is fully flushed, prune old exports. Don't block the
  // client response on this.
  if (diskOut) {
    diskOut.on('close', () => {
      console.log(JSON.stringify({
        event: 'zip_export_persisted',
        file: `${EXPORTS_SUBDIR}/${filename}`,
        fileCount: files.length,
        timestamp: new Date().toISOString(),
      }));
      void pruneExports(exportsDir);
    });
  }
}

/**
 * GET /latest - Redirect to the newest persisted export ZIP (resumable static
 * download via /api/file/exports/...). The UI links here so a crashed download
 * is always one click from recovery.
 */
downloadRouter.get('/latest', async (_req: Request, res: Response): Promise<void> => {
  const exportsDir = path.join(path.resolve(env.DATA_DIR), EXPORTS_SUBDIR);
  try {
    const names = (await readdir(exportsDir)).filter((n) => n.toLowerCase().endsWith('.zip'));
    if (names.length === 0) {
      res.status(404).json({ error: 'No export ZIPs available yet' });
      return;
    }
    const withTimes = await Promise.all(
      names.map(async (n) => ({ n, m: (await stat(path.join(exportsDir, n))).mtimeMs }))
    );
    withTimes.sort((a, b) => b.m - a.m);
    res.redirect(302, `/api/file/${EXPORTS_SUBDIR}/${encodeURIComponent(withTimes[0].n)}`);
  } catch {
    res.status(404).json({ error: 'No exports directory' });
  }
});

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
