import { Queue } from 'bullmq';
import { queueConnection } from '../config/redis.js';
import { env } from '../config/env.js';
import type { FeedSource } from './types.js';
import type { MediaItem } from '../media/types.js';

export const FEED_QUEUE_NAME = 'feed-monitor';
export const METADATA_QUEUE_NAME = 'metadata-extraction';
export const MEDIA_COLLECTION_QUEUE_NAME = 'media-collection';

/**
 * Job data for feed polling
 */
export interface FeedPollJobData {
  feedUrl: string;
  source: FeedSource;
}

/**
 * Job data for metadata extraction
 */
export interface MetadataJobData {
  url: string;
  canonicalUrl: string;
  source: FeedSource;
  feedMetadata: {
    title?: string;
    creator?: string;
    bookmarkedAt?: string;
    guid: string;
    enclosure?: MediaItem['enclosure'];
    mediaType?: MediaItem['mediaType'];
  };
}

/**
 * Job data for media collection
 */
export interface MediaCollectionJobData {
  item: MediaItem;
  retryCount?: number;  // Track retries for transcript polling
}

/**
 * Feed polling queue with Job Schedulers
 */
export const feedQueue = new Queue<FeedPollJobData>(FEED_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 1000 },
  },
});

/**
 * Metadata extraction queue
 */
export const metadataQueue = new Queue<MetadataJobData>(METADATA_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});

/**
 * Media collection queue with exponential backoff for transcript polling
 *
 * Matter transcripts are generated asynchronously - may not be ready immediately.
 * Exponential backoff: 1min -> 2min -> 4min -> 8min -> 16min total ~31min.
 */
export const mediaCollectionQueue = new Queue<MediaCollectionJobData>(MEDIA_COLLECTION_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 5,  // More retries for transcript availability
    backoff: {
      type: 'exponential',
      delay: 60000,  // Start with 1 minute, grows to ~16 min
    },
    removeOnComplete: { count: 500 },
    removeOnFail: false,
  },
});

/**
 * Initialize feed monitoring with Job Schedulers
 *
 * Uses BullMQ Job Schedulers (v5.16+) instead of deprecated repeatable jobs.
 * Polls configured feeds at FEED_POLL_INTERVAL_MINUTES interval.
 */
export async function initializeFeedMonitor(): Promise<void> {
  const intervalMs = env.FEED_POLL_INTERVAL_MINUTES * 60 * 1000;

  // Set up Matter feed polling if configured
  if (env.MATTER_FEED_URL) {
    await feedQueue.upsertJobScheduler(
      'matter-feed-poll',
      { every: intervalMs },
      {
        name: 'poll-feed',
        data: {
          feedUrl: env.MATTER_FEED_URL,
          source: 'matter' as FeedSource,
        },
      }
    );
    console.log(`Matter feed monitor scheduled: every ${env.FEED_POLL_INTERVAL_MINUTES} minutes`);
  } else {
    console.log('MATTER_FEED_URL not configured, skipping Matter feed monitoring');
  }

  // Set up Karakeep feed polling if configured
  if (env.KARAKEEP_FEED_URL) {
    await feedQueue.upsertJobScheduler(
      'karakeep-feed-poll',
      { every: intervalMs },
      {
        name: 'poll-feed',
        data: {
          feedUrl: env.KARAKEEP_FEED_URL,
          source: 'karakeep' as FeedSource,
        },
      }
    );
    console.log(`Karakeep feed monitor scheduled: every ${env.FEED_POLL_INTERVAL_MINUTES} minutes`);
  } else {
    console.log('KARAKEEP_FEED_URL not configured, skipping Karakeep feed monitoring');
  }

  // Trigger immediate poll if both feeds configured
  if (env.MATTER_FEED_URL || env.KARAKEEP_FEED_URL) {
    console.log('Feed monitoring initialized. First poll will run on schedule.');
  }
}
