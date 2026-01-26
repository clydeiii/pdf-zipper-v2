/**
 * Podcast transcription queue
 *
 * Handles Apple Podcasts URLs:
 * - Fetch metadata from iTunes API
 * - Download audio
 * - Transcribe with Whisper ASR
 * - Generate PDF with metadata + transcript
 */

import { Queue } from 'bullmq';
import { queueConnection } from '../config/redis.js';
import type { PodcastJobData, PodcastJobResult } from './types.js';

export const PODCAST_QUEUE_NAME = 'podcast-transcription';

/**
 * BullMQ queue for podcast transcription jobs
 *
 * Long timeouts due to:
 * - Large audio downloads (50-200MB)
 * - Long transcription times (can be 30+ min for hour-long podcasts)
 */
export const podcastQueue = new Queue<PodcastJobData, PodcastJobResult>(
  PODCAST_QUEUE_NAME,
  {
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 2,  // Fewer retries since transcription is expensive
      backoff: {
        type: 'exponential',
        delay: 30000,  // 30s base delay (transcription failures often need time)
      },
      removeOnComplete: {
        count: 500,     // Keep fewer completed jobs (these are larger operations)
        age: 1209600,   // 14 days
      },
      removeOnFail: false,  // Keep failed jobs for debugging
    },
  }
);

console.log(`Podcast queue '${PODCAST_QUEUE_NAME}' initialized`);
