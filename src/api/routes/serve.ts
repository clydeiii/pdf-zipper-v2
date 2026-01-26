/**
 * File serving route for viewing PDFs and media files
 *
 * GET /file/* - Serve a file from the data directory
 */

import { Router, Request, Response } from 'express';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { env } from '../../config/env.js';

export const serveRouter = Router();

/**
 * GET /file/* - Serve a file from the data directory
 *
 * Path is relative to DATA_DIR (e.g., /file/media/2026-W05/pdfs/example.pdf)
 *
 * Security: Only serves files within DATA_DIR to prevent directory traversal
 *
 * Status codes:
 * - 200 OK with file content
 * - 400 Bad Request if path tries to escape DATA_DIR
 * - 404 Not Found if file doesn't exist
 * - 500 Internal Server Error on failure
 */
serveRouter.get('/file/*', async (req: Request, res: Response): Promise<void> => {
  // Get the path after /file/
  const relativePath = req.params[0];

  if (!relativePath) {
    res.status(400).json({ error: 'File path required' });
    return;
  }

  try {
    // Resolve the full path and ensure it's within DATA_DIR
    const dataDir = path.resolve(env.DATA_DIR);
    const filePath = path.resolve(dataDir, relativePath);

    // Security check: ensure path is within DATA_DIR (prevent directory traversal)
    if (!filePath.startsWith(dataDir)) {
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }

    // Check if file exists
    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      throw error;
    }

    // Serve the file
    res.sendFile(filePath);
  } catch (error) {
    console.error('Failed to serve file:', {
      path: relativePath,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({ error: 'Failed to serve file' });
  }
});
