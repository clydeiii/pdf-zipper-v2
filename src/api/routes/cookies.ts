/**
 * REST API routes for cookies management
 *
 * POST /upload - Upload a new cookies.txt file
 * GET /status - Check if cookies file exists and get stats
 */

import { Router, Request, Response } from 'express';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { env } from '../../config/env.js';
import { requireApiToken } from '../auth.js';

export const cookiesRouter = Router();

/**
 * Cookie identity in Netscape format = (domain, path, name).
 * Two cookies with the same triple are the same cookie; the new value wins
 * on collision so re-exporting a refreshed session updates rather than
 * duplicates the entry.
 */
function cookieKey(line: string): string | null {
  const parts = line.split('\t');
  if (parts.length < 7) return null;
  const [domain, , path, , , name] = parts;
  return `${domain}\t${path || '/'}\t${name}`;
}

/**
 * Merge uploaded cookies.txt content into the existing file, deduping by
 * (domain, path, name). Existing entries keep their position in the file;
 * new cookies are appended; collisions get the uploaded value.
 *
 * Returns counts and the merged content (with a single header block).
 */
function mergeNetscapeCookies(existing: string, uploaded: string): {
  merged: string;
  added: number;
  updated: number;
  total: number;
} {
  // Insertion-ordered Map: existing entries keep position; new ones append.
  const byKey = new Map<string, string>();

  for (const line of existing.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const key = cookieKey(trimmed);
    if (key) byKey.set(key, trimmed);
  }

  let added = 0;
  let updated = 0;
  for (const line of uploaded.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const key = cookieKey(trimmed);
    if (!key) continue;
    if (byKey.has(key)) updated++;
    else added++;
    byKey.set(key, trimmed);
  }

  const header = '# Netscape HTTP Cookie File\n# Maintained by pdf-zipper-v2 (merged on upload)\n\n';
  const body = Array.from(byKey.values()).join('\n');
  return {
    merged: header + body + '\n',
    added,
    updated,
    total: byKey.size,
  };
}

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
cookiesRouter.post('/upload', requireApiToken, async (req: Request, res: Response): Promise<void> => {
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

    // Merge with existing cookies (preserves still-valid sessions across
    // partial re-exports — e.g., user exports cookies for ft.com only, NYT
    // session cookies should stay intact).
    const cookiesPath = env.COOKIES_FILE;
    const existing = existsSync(cookiesPath) ? await readFile(cookiesPath, 'utf-8') : '';
    const { merged, added, updated, total } = mergeNetscapeCookies(existing, content);
    await writeFile(cookiesPath, merged, 'utf-8');

    console.log(
      `Cookies file merged: +${added} new, ${updated} updated, ${total} total → ${cookiesPath}`
    );

    res.json({
      success: true,
      cookieCount: total,
      added,
      updated,
      message: `Merged ${validLines.length} uploaded cookies: ${added} new, ${updated} updated, ${total} total`,
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
