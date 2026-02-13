/**
 * REST API routes for AI self-healing fix system
 *
 * POST /submit - Queue items for AI diagnosis
 * GET /history - View past diagnosis results
 * GET /pending - Get count of pending items
 */

import { Router, Request, Response } from 'express';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { env } from '../../config/env.js';
import { conversionQueue } from '../../queues/conversion.queue.js';
import { getISOWeekNumber } from '../../media/organization.js';
import { addPendingFixes, getFixHistory, getPendingCount } from '../../fix/pending.js';
import { notifyFixSubmitted } from '../../notifications/discord.js';
import type {
  FixJobContext,
  FixRequestType,
  FixSubmitRequest,
  FixSubmitResponse,
  FixHistoryResponse,
} from '../../jobs/fix-types.js';

export const fixRouter = Router();

/**
 * Extract source URL from PDF metadata
 */
async function extractUrlFromPdf(pdfPath: string): Promise<string | null> {
  try {
    const pdfBytes = await readFile(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const subject = pdfDoc.getSubject();
    if (subject && (subject.startsWith('http://') || subject.startsWith('https://'))) {
      return subject;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * POST /submit - Queue items for AI diagnosis
 *
 * Request body: { items: [{ path?, url?, jobId?, requestType? }] }
 *
 * - path: For successful PDFs, extracts URL from metadata
 * - url: For failed items, uses URL directly
 * - jobId: Optional, used to get job details from BullMQ
 * - requestType: Optional, inferred from item status
 *
 * Status codes:
 * - 200 OK with { queued: number, message: string }
 * - 400 Bad Request if items array is missing or empty
 * - 503 Service Unavailable if fix feature is disabled
 */
fixRouter.post('/submit', async (req: Request, res: Response): Promise<void> => {
  // Check if fix feature is enabled
  if (!env.FIX_ENABLED) {
    res.status(503).json({
      error: 'Fix feature is disabled. Set FIX_ENABLED=true to enable.',
    });
    return;
  }

  const { items } = req.body as FixSubmitRequest;

  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({
      error: 'items array is required and must not be empty',
    });
    return;
  }

  try {
    const dataDir = path.resolve(env.DATA_DIR);
    const fixContexts: FixJobContext[] = [];

    for (const item of items) {
      let context: FixJobContext | null = null;

      // Case 1: PDF file path provided (false positive)
      if (item.path && item.path.endsWith('.pdf')) {
        const fullPath = path.resolve(dataDir, item.path);

        // Security check - must be within DATA_DIR
        if (!fullPath.startsWith(dataDir)) {
          console.warn(`Fix rejected - path outside DATA_DIR: ${item.path}`);
          continue;
        }

        // Extract URL from PDF metadata
        const url = await extractUrlFromPdf(fullPath);
        if (!url) {
          console.warn(`Fix rejected - no URL in PDF metadata: ${item.path}`);
          continue;
        }

        // Determine week from path (e.g., media/2026-W04/pdfs/file.pdf)
        const pathParts = item.path.split('/');
        const weekId = pathParts.find(p => /^\d{4}-W\d{2}$/.test(p)) || 'unknown';

        context = {
          originalJobId: item.jobId || 'unknown',
          url,
          requestType: 'false_positive',
          status: 'complete',
          pdfPath: fullPath,
          weekId,
          requestedAt: new Date().toISOString(),
        };

        // Try to get quality info from BullMQ if job is still available
        if (item.jobId) {
          const job = await conversionQueue.getJob(item.jobId);
          if (job?.returnvalue) {
            context.qualityScore = job.returnvalue.qualityScore;
            context.qualityReasoning = job.returnvalue.qualityReasoning;
          }
        }
      }

      // Case 2: URL provided directly (failed item)
      else if (item.url) {
        // Determine week from job timestamp if available
        let weekId = 'unknown';
        let failureReason: string | undefined;
        let debugPdfPath: string | undefined;

        if (item.jobId) {
          const job = await conversionQueue.getJob(item.jobId);
          if (job) {
            const jobDate = new Date(job.timestamp);
            const week = getISOWeekNumber(jobDate);
            weekId = `${week.year}-W${week.week.toString().padStart(2, '0')}`;
            failureReason = job.failedReason || undefined;

            // Check for debug PDF
            const potentialDebugPath = path.join(env.DATA_DIR, 'debug', `${item.jobId}.pdf`);
            try {
              await readFile(potentialDebugPath);
              debugPdfPath = potentialDebugPath;
            } catch {
              // Debug PDF doesn't exist
            }
          }
        }

        context = {
          originalJobId: item.jobId || 'unknown',
          url: item.url,
          requestType: 'false_negative',
          status: 'failed',
          debugPdfPath,
          failureReason,
          weekId,
          requestedAt: new Date().toISOString(),
        };
      }

      if (context) {
        // Allow explicit override of request type
        if (item.requestType) {
          context.requestType = item.requestType;
        }
        fixContexts.push(context);
      }
    }

    if (fixContexts.length === 0) {
      res.status(400).json({
        error: 'No valid items to queue for diagnosis',
      });
      return;
    }

    // Add to pending queue
    const queued = await addPendingFixes(fixContexts);

    // Send Discord notification for successful submissions
    if (queued > 0) {
      const queuedUrls = fixContexts.slice(0, queued).map(c => c.url);
      await notifyFixSubmitted({ itemCount: queued, urls: queuedUrls });
    }

    const response: FixSubmitResponse = {
      queued,
      message: queued > 0
        ? `Submitted ${queued} item(s) for AI diagnosis. Processing runs every 5 minutes.`
        : 'All items were skipped (recently attempted or duplicates).',
    };

    console.log(JSON.stringify({
      event: 'fix_submit',
      itemsReceived: items.length,
      contextsCreated: fixContexts.length,
      queued,
      timestamp: new Date().toISOString(),
    }));

    res.json(response);
  } catch (error) {
    console.error('Failed to submit fix items:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to submit items for diagnosis',
    });
  }
});

/**
 * GET /history - View past diagnosis results
 *
 * Query params:
 * - limit: Maximum entries to return (default 20, max 100)
 *
 * Status codes:
 * - 200 OK with { batches: [...] }
 * - 503 Service Unavailable if fix feature is disabled
 */
fixRouter.get('/history', async (req: Request, res: Response): Promise<void> => {
  if (!env.FIX_ENABLED) {
    res.status(503).json({
      error: 'Fix feature is disabled',
    });
    return;
  }

  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const batches = await getFixHistory(limit);

    const response: FixHistoryResponse = { batches };
    res.json(response);
  } catch (error) {
    console.error('Failed to get fix history:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to get fix history',
    });
  }
});

/**
 * GET /pending - Get count of pending fix requests
 *
 * Status codes:
 * - 200 OK with { pending: number }
 * - 503 Service Unavailable if fix feature is disabled
 */
fixRouter.get('/pending', async (_req: Request, res: Response): Promise<void> => {
  if (!env.FIX_ENABLED) {
    res.status(503).json({
      error: 'Fix feature is disabled',
    });
    return;
  }

  try {
    const pending = await getPendingCount();
    res.json({ pending });
  } catch (error) {
    console.error('Failed to get pending count:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to get pending count',
    });
  }
});

/**
 * GET /status - Get fix system status
 *
 * Returns whether the feature is enabled and current queue state.
 */
fixRouter.get('/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const pending = env.FIX_ENABLED ? await getPendingCount() : 0;

    res.json({
      enabled: env.FIX_ENABLED,
      claudeCliPath: env.CLAUDE_CLI_PATH,
      pending,
    });
  } catch (error) {
    console.error('Failed to get fix status:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to get fix status',
    });
  }
});
