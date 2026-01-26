import { Worker, Job } from 'bullmq';
import { workerConnection, createConnection } from '../config/redis.js';
import { parseMatterFeed, parseKarakeepFeed } from './parsers/index.js';
import { BookmarkDeduplicator } from '../urls/deduplicator.js';
import { FEED_QUEUE_NAME, metadataQueue } from './monitor.js';
import type { FeedPollJobData, MetadataJobData } from './monitor.js';
import type { BookmarkItem, FeedCacheState } from './types.js';

// Redis keys for feed cache state
const FEED_CACHE_PREFIX = 'feed:cache:';

/**
 * Feed polling worker
 *
 * Processes feed poll jobs:
 * 1. Fetches feed with conditional request (ETag/If-Modified-Since)
 * 2. Filters out already-seen items (GUID dedup per feed)
 * 3. Filters out duplicate URLs (cross-feed dedup)
 * 4. Queues new items for metadata extraction
 */
export const feedPollWorker = new Worker<FeedPollJobData>(
  FEED_QUEUE_NAME,
  async (job: Job<FeedPollJobData>) => {
    const { feedUrl, source } = job.data;
    const startTime = Date.now();

    const redis = createConnection({ maxRetriesPerRequest: null });
    const deduplicator = new BookmarkDeduplicator(redis);

    try {
      // Load cached ETag/Last-Modified
      const cacheKey = `${FEED_CACHE_PREFIX}${source}`;
      const cachedEtag = await redis.hget(cacheKey, 'etag');
      const cachedLastMod = await redis.hget(cacheKey, 'lastModified');

      const cache: FeedCacheState = {
        etag: cachedEtag || undefined,
        lastModified: cachedLastMod || undefined,
      };

      // Parse feed - Karakeep gets pagination support with GUID checker
      let result;
      if (source === 'karakeep') {
        // Create GUID checker callback for pagination catchup
        const isGuidSeen = async (guid: string) => deduplicator.isGuidSeen(source, guid);
        result = await parseKarakeepFeed(feedUrl, cache, isGuidSeen);
      } else {
        result = await parseMatterFeed(feedUrl, cache);
      }

      // Update cache
      if (result.cache.etag) {
        await redis.hset(cacheKey, 'etag', result.cache.etag);
      }
      if (result.cache.lastModified) {
        await redis.hset(cacheKey, 'lastModified', result.cache.lastModified);
      }

      // Handle 304 Not Modified
      if (!result.wasModified) {
        await job.log(`Feed ${source} unchanged (304), skipping`);
        return {
          source,
          wasModified: false,
          newItems: 0,
          duration: Date.now() - startTime,
        };
      }

      // Process items with deduplication
      let newItems = 0;
      const metadataJobs: { name: string; data: MetadataJobData }[] = [];

      for (const item of result.items) {
        // Skip if GUID already seen in this feed
        if (await deduplicator.isGuidSeen(source, item.guid)) {
          continue;
        }

        // Mark GUID as seen
        await deduplicator.markGuidSeen(source, item.guid);

        // Skip if URL already seen (cross-feed dedup)
        if (await deduplicator.isUrlSeen(item.url)) {
          await job.log(`Duplicate URL skipped: ${item.canonicalUrl}`);
          continue;
        }

        // Mark URL as seen
        await deduplicator.markUrlSeen(item.url, source);

        // Queue for metadata extraction
        metadataJobs.push({
          name: 'extract-metadata',
          data: {
            url: item.url,
            canonicalUrl: item.canonicalUrl,
            source,
            feedMetadata: {
              title: item.title,
              creator: item.creator,
              bookmarkedAt: item.bookmarkedAt,
              guid: item.guid,
              enclosure: item.enclosure,
              mediaType: item.mediaType,
            },
          },
        });

        newItems++;
      }

      // Bulk add metadata jobs
      if (metadataJobs.length > 0) {
        await metadataQueue.addBulk(metadataJobs);
        await job.log(`Queued ${metadataJobs.length} items for metadata extraction`);
      }

      const duration = Date.now() - startTime;

      console.log(JSON.stringify({
        event: 'feed_poll_complete',
        source,
        totalItems: result.items.length,
        newItems,
        duration,
        timestamp: new Date().toISOString(),
      }));

      return {
        source,
        wasModified: true,
        totalItems: result.items.length,
        newItems,
        duration,
      };

    } finally {
      await redis.quit();
    }
  },
  {
    connection: workerConnection,
    concurrency: 1, // Process one feed at a time
  }
);

feedPollWorker.on('completed', (job) => {
  console.log(`Feed poll completed: ${job.data.source}`);
});

feedPollWorker.on('failed', (job, err) => {
  console.error(`Feed poll failed: ${job?.data.source}`, err.message);
});

console.log(`Feed poll worker started for queue '${FEED_QUEUE_NAME}'`);
