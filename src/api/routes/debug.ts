/**
 * Debug routes for viewing failed job PDFs
 *
 * GET /debug/:jobId - View the debug PDF for a failed job
 */

import { Router, Request, Response } from 'express';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { env } from '../../config/env.js';

export const debugRouter = Router();

/**
 * GET /:jobId - Serve debug PDF for a job
 *
 * Returns the PDF that was generated before the job failed quality checks.
 * Useful for debugging issues like truncation, missing content, etc.
 *
 * Status codes:
 * - 200 OK with application/pdf
 * - 404 Not Found if no debug PDF exists
 * - 500 Internal Server Error on failure
 */
debugRouter.get('/:jobId', async (req: Request, res: Response): Promise<void> => {
  const jobId = req.params.jobId;

  // Validate jobId format (should be numeric or alphanumeric)
  if (!/^[\w-]+$/.test(jobId)) {
    res.status(400).json({
      error: 'Invalid job ID format',
    });
    return;
  }

  try {
    const dataDir = env.DATA_DIR || './data';
    const pdfPath = path.join(dataDir, 'debug', `${jobId}.pdf`);

    // Check if file exists
    try {
      await stat(pdfPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({
          error: 'Debug PDF not found for this job',
        });
        return;
      }
      throw error;
    }

    // Serve the PDF
    res.sendFile(pdfPath);
  } catch (error) {
    console.error('Failed to serve debug PDF:', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to retrieve debug PDF',
    });
  }
});
