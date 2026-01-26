/**
 * REST API routes for job submission and status checking
 *
 * POST /api/jobs - Submit URL for conversion
 * GET /api/jobs/:jobId - Check job status
 */

import { Router, Request, Response } from 'express';
import { conversionQueue, getJobStatus } from '../../queues/conversion.queue.js';
import type { ConversionJobData } from '../../jobs/types.js';

export const jobsRouter = Router();

/**
 * Validate that a string is a valid URL
 */
function isValidUrl(urlString: string): boolean {
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
}

/**
 * POST / - Submit a URL for conversion
 *
 * Request body: { url: string, userId?: string, priority?: number }
 * Response: { jobId: string, status: 'queued', message: string }
 *
 * Returns:
 * - 202 Accepted on success
 * - 400 Bad Request if url missing or invalid
 * - 500 Internal Server Error on queue failure
 */
jobsRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const { url, userId, priority } = req.body as Partial<ConversionJobData>;

  // Validate url is present
  if (!url) {
    res.status(400).json({
      error: 'url is required',
    });
    return;
  }

  // Validate url is a valid URL format
  if (!isValidUrl(url)) {
    res.status(400).json({
      error: 'Invalid URL format',
    });
    return;
  }

  try {
    // Add job to queue
    // For direct API submissions, url is not normalized so originalUrl = url
    const job = await conversionQueue.add(
      'convert-url',
      { url, originalUrl: url, userId, priority },
      { priority }
    );

    res.status(202).json({
      jobId: job.id,
      status: 'queued',
      message: 'Job submitted for processing',
    });
  } catch (error) {
    console.error('Failed to queue job:', {
      url,
      userId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to queue conversion job',
    });
  }
});

/**
 * GET /:jobId - Check job status
 *
 * Response varies by status:
 * - complete: { jobId, status: 'complete', result: {...} }
 * - failed: { jobId, status: 'failed', error: string, attemptsMade: number, maxAttempts: number }
 * - processing: { jobId, status: 'processing', progress: number }
 * - queued: { jobId, status: 'queued' }
 *
 * Returns:
 * - 200 OK with status
 * - 404 Not Found if job doesn't exist
 * - 500 Internal Server Error on retrieval failure
 */
jobsRouter.get('/:jobId', async (req: Request, res: Response): Promise<void> => {
  const jobId = req.params.jobId as string;

  try {
    const job = await conversionQueue.getJob(jobId);

    if (!job) {
      res.status(404).json({
        error: 'Job not found',
      });
      return;
    }

    const status = await getJobStatus(job);

    switch (status) {
      case 'complete':
        res.json({
          jobId: job.id,
          status: 'complete',
          result: job.returnvalue,
        });
        break;

      case 'failed':
        res.json({
          jobId: job.id,
          status: 'failed',
          error: job.failedReason || 'Unknown error',
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts || 3,
        });
        break;

      case 'processing':
        res.json({
          jobId: job.id,
          status: 'processing',
          progress: job.progress || 0,
        });
        break;

      case 'queued':
      default:
        res.json({
          jobId: job.id,
          status: 'queued',
        });
        break;
    }
  } catch (error) {
    console.error('Failed to get job status:', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to retrieve job status',
    });
  }
});
