/**
 * Conversion queue for URL-to-PDF jobs
 *
 * Configured with:
 * - 3 retry attempts with exponential backoff (CONV-03)
 * - Failed jobs retained for debugging (removeOnFail: false)
 * - Completed jobs retained for 14 days or last 2000 (for rerun feature)
 */

import { Queue, Job } from 'bullmq';
import { queueConnection } from '../config/redis.js';
import type { ConversionJobData, ConversionJobResult, JobStatus } from '../jobs/types.js';

/**
 * Queue name constant - must match worker configuration
 */
export const QUEUE_NAME = 'url-conversion';

/**
 * BullMQ queue for URL conversion jobs
 *
 * Default job options enforce retry policy:
 * - attempts: 3 (jobs retry up to 3 times)
 * - backoff: exponential starting at 1 second (1s, 2s, 4s)
 * - removeOnFail: false (keep failed jobs for Bull Board inspection)
 */
export const conversionQueue = new Queue<ConversionJobData, ConversionJobResult>(
  QUEUE_NAME,
  {
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000, // 1s base -> 2s -> 4s
      },
      removeOnComplete: {
        count: 2000, // Keep last 2000 completed jobs
        age: 1209600,  // Or jobs younger than 14 days (for rerun feature)
      },
      removeOnFail: false, // Keep all failed jobs for debugging
    },
  }
);

/**
 * Map BullMQ job state to API-friendly JobStatus
 *
 * BullMQ states: 'completed' | 'failed' | 'active' | 'delayed' | 'waiting' | 'waiting-children' | 'prioritized' | 'unknown'
 * API states: 'queued' | 'processing' | 'complete' | 'failed'
 */
export async function getJobStatus(job: Job<ConversionJobData, ConversionJobResult>): Promise<JobStatus> {
  const state = await job.getState();

  switch (state) {
    case 'completed':
      return 'complete';
    case 'failed':
      return 'failed';
    case 'active':
      return 'processing';
    default:
      // 'delayed', 'waiting', 'waiting-children', 'prioritized', 'unknown'
      return 'queued';
  }
}

console.log(`Conversion queue '${QUEUE_NAME}' initialized with 3 attempts, exponential backoff`);
