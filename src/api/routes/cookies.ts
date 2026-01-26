/**
 * REST API routes for cookies management
 *
 * POST /upload - Upload a new cookies.txt file
 * GET /status - Check if cookies file exists and get stats
 */

import { Router, Request, Response } from 'express';
import { writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { env } from '../../config/env.js';

export const cookiesRouter = Router();

/**
 * POST /upload - Upload a new cookies.txt file
 *
 * Accepts raw text body containing Netscape cookies.txt content.
 * Validates format before saving.
 *
 * Status codes:
 * - 200 OK with cookie count
 * - 400 Bad Request if content is empty or invalid format
 * - 500 Internal Server Error on write failure
 */
cookiesRouter.post('/upload', async (req: Request, res: Response): Promise<void> => {
  try {
    // Get raw body content
    const content = req.body?.content;

    if (!content || typeof content !== 'string') {
      res.status(400).json({
        error: 'Missing cookies content. Send JSON with { "content": "..." }',
      });
      return;
    }

    // Basic validation: check for Netscape format markers
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));

    if (lines.length === 0) {
      res.status(400).json({
        error: 'No cookies found in uploaded content',
      });
      return;
    }

    // Validate at least some lines have correct format (7 tab-separated fields)
    const validLines = lines.filter(line => {
      const parts = line.split('\t');
      return parts.length >= 7;
    });

    if (validLines.length === 0) {
      res.status(400).json({
        error: 'Invalid cookies.txt format. Expected Netscape format with tab-separated fields.',
      });
      return;
    }

    // Write to cookies file
    const cookiesPath = env.COOKIES_FILE;
    await writeFile(cookiesPath, content, 'utf-8');

    console.log(`Cookies file updated: ${validLines.length} cookies saved to ${cookiesPath}`);

    res.json({
      success: true,
      cookieCount: validLines.length,
      message: `Successfully uploaded ${validLines.length} cookies`,
    });

  } catch (error) {
    console.error('Failed to upload cookies:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to save cookies file',
    });
  }
});

/**
 * GET /status - Get cookies file status
 *
 * Returns information about the current cookies file.
 *
 * Status codes:
 * - 200 OK with status info
 * - 500 Internal Server Error on failure
 */
cookiesRouter.get('/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const cookiesPath = env.COOKIES_FILE;
    const exists = existsSync(cookiesPath);

    if (!exists) {
      res.json({
        exists: false,
        path: cookiesPath,
        message: 'No cookies file configured',
      });
      return;
    }

    const stats = await stat(cookiesPath);

    res.json({
      exists: true,
      path: cookiesPath,
      size: stats.size,
      modified: stats.mtime.toISOString(),
    });

  } catch (error) {
    console.error('Failed to get cookies status:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to get cookies status',
    });
  }
});
