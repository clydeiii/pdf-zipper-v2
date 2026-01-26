/**
 * Media collection worker
 * Downloads media files with retry logic for async transcript availability
 */

import { Worker, Job } from 'bullmq';
import { workerConnection } from '../config/redis.js';
import { downloadMedia } from './collector.js';
import type { MediaItem, MediaCollectionResult } from './types.js';
import type { MediaCollectionJobData } from '../feeds/monitor.js';

let worker: Worker | null = null;

/**
 * Start media collection worker
 * Processes media downloads with exponential backoff for transcript polling
 */
export async function startMediaWorker(): Promise<void> {
  worker = new Worker<MediaCollectionJobData, MediaCollectionResult>(
    'media-collection',
    async (job: Job<MediaCollectionJobData>) => {
      const { item } = job.data;

      console.log(JSON.stringify({
        event: 'media_download_start',
        mediaType: item.mediaType,
        url: item.url,
        enclosureUrl: item.enclosure.url,
        attempt: job.attemptsMade + 1,
        timestamp: new Date().toISOString(),
      }));

      const result = await downloadMedia(item);

      if (result.success === true) {
        console.log(JSON.stringify({
          event: 'media_download_complete',
          mediaType: item.mediaType,
          filePath: result.filePath,
          fileSize: result.fileSize,
          downloadDuration: result.downloadDuration,
          timestamp: new Date().toISOString(),
        }));
        return result;
      }

      // Download failed - result.success is false
      // Check if this is a "file not yet available" error for transcripts
      // Matter transcripts are async - may not be ready immediately
      if (item.mediaType === 'transcript' && result.reason === 'file_missing') {
        console.log(JSON.stringify({
          event: 'transcript_not_ready',
          url: item.url,
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts,
          timestamp: new Date().toISOString(),
        }));
        // Throw to trigger retry with exponential backoff
        throw new Error(`Transcript not yet available: ${item.url}`);
      }

      // For other failures, also throw to trigger retry
      throw new Error(`Media download failed: ${result.error}`);
    },
    {
      connection: workerConnection,
      concurrency: 2,  // Limit concurrent downloads
    }
  );

  worker.on('failed', (job, err) => {
    console.error(JSON.stringify({
      event: 'media_download_failed',
      jobId: job?.id,
      error: err.message,
      attemptsMade: job?.attemptsMade,
      timestamp: new Date().toISOString(),
    }));
  });

  console.log('Media collection worker started');
}

/**
 * Stop media collection worker
 * Closes worker and waits for in-flight downloads to complete
 */
export async function stopMediaWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('Media collection worker stopped');
  }
}
