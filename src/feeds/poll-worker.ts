import { Worker, Job } from 'bullmq';
import { workerConnection, createConnection } from '../config/redis.js';
import { parseMatterFeed, parseKarakeepFeed } from './parsers/index.js';
import { fetchKarakeepBookmarkItem } from './parsers/karakeep.js';
import { BookmarkDeduplicator } from '../urls/deduplicator.js';
import { FEED_QUEUE_NAME, metadataQueue } from './monitor.js';
import type { FeedPollJobData, MetadataJobData } from './monitor.js';
import type { BookmarkItem, FeedCacheState } from './types.js';
import { isApplePodcastsUrl } from '../podcasts/apple.js';

// Redis keys for feed cache state
const FEED_CACHE_PREFIX = 'feed:cache:';
// Retry counter for video URLs waiting on Karakeep yt-dlp. After MAX_VIDEO_RETRIES
// polls (real 5-min cadence → ~2h at default 24; outlasts Karakeep's 1h video
// timeout so large/slow videos are not dropped early) we give up and mark the GUID seen
// unsupported videos don't re-log on every cycle forever.
const VIDEO_RETRY_PREFIX = 'feed:video-retries:';
const MAX_VIDEO_RETRIES = Number(process.env.FEED_VIDEO_MAX_RETRIES) || 24;

/** Check if URL is a video-only platform (YouTube, Vimeo) that needs a media enclosure */
function isVideoOnlyUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'youtube.com' || host === 'www.youtube.com' || host === 'youtu.be' ||
      host === 'm.youtube.com' || host === 'vimeo.com' || host === 'www.vimeo.com';
  } catch { return false; }
}

/**
 * Feed polling worker
 *
 * Processes feed poll jobs:
 * 1. Fetches feed with conditional request (ETag/If-Modified-Since)
 * 2. Filters out already-seen items (GUID dedup per feed)
 * 3. Filters out duplicate URLs (cross-feed dedup)
 * 4. Queues new items for metadata extraction
 */
let feedPollWorker: Worker<FeedPollJobData> | null = null;

function createFeedPollWorker(): Worker<FeedPollJobData> {
  const worker = new Worker<FeedPollJobData>(
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

        // Videos still waiting on a Karakeep asset are GUID-unseen on
        // purpose, but pagination stops at the first seen bookmark — so once
        // newer bookmarks push a waiting video off the first page the feed
        // never surfaces it again and its retry counter freezes (45 stranded
        // on 2026-09-02). Look each pending video up directly by id instead;
        // one cheap request per pending video, independent of feed position.
        const videoRetryKey = `${VIDEO_RETRY_PREFIX}${source}`;
        const inFeed = new Set(result.items.map((i) => i.guid));
        for (const guid of await redis.hkeys(videoRetryKey)) {
          if (inFeed.has(guid)) continue;
          const lookup = await fetchKarakeepBookmarkItem(feedUrl, guid);
          if (lookup === 'gone') {
            // Deleted in Karakeep (or swept by its retention cleaner): stop waiting.
            await redis.hdel(videoRetryKey, guid);
            console.log(JSON.stringify({
              event: 'video_wait_abandoned',
              guid,
              source,
              reason: 'bookmark_gone',
              timestamp: new Date().toISOString(),
            }));
          } else if (lookup) {
            result.items.push(lookup);
          }
        }
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

        // For video URLs without an enclosure, DON'T mark as seen yet.
        // Karakeep's yt-dlp download may still be in progress — the video asset
        // will appear on a later poll. If we mark the GUID seen now, we'll never
        // pick up the enclosure when it's ready.
        // Bounded: after MAX_VIDEO_RETRIES polls the video is presumed permanently
        // unsupported (private/geo-blocked/deleted), and we mark it seen to stop
        // the log spam.
        const isVideoWithoutEnclosure = isVideoOnlyUrl(item.url) && !item.enclosure;
        if (isVideoWithoutEnclosure) {
          const retryKey = `${VIDEO_RETRY_PREFIX}${source}`;
          const retries = await redis.hincrby(retryKey, item.guid, 1);
          if (retries < MAX_VIDEO_RETRIES) {
            await job.log(`Video URL without enclosure (retry ${retries}/${MAX_VIDEO_RETRIES}): ${item.url}`);
            continue;
          }
          // Karakeep never delivered a video asset in the whole wait window.
          // That is no longer presumed to mean the video is undownloadable —
          // Karakeep's bundled yt-dlp goes stale and was observed 403-blocked
          // by YouTube for days (2026-08-18..20), silently dropping every
          // bookmarked video. Self-download instead: point the enclosure at
          // the watch URL itself, exactly like the Patreon path, and let the
          // collector run our own yt-dlp. Falls through to normal processing.
          await job.log(`Video URL without enclosure after ${retries} polls — self-download fallback: ${item.url}`);
          console.log(JSON.stringify({
            event: 'video_selfdownload_fallback',
            url: item.url,
            source,
            timestamp: new Date().toISOString(),
          }));
          await redis.hdel(retryKey, item.guid);
          item.enclosure = {
            url: item.url,
            type: 'video/mp4',
            length: undefined,
            downloadVia: 'yt-dlp',
          };
          item.mediaType = 'video';
        }

        // Mark GUID as seen; drop any pending video-retry counter for this GUID
        // since we're now proceeding normally (enclosure arrived).
        await deduplicator.markGuidSeen(source, item.guid);
        await redis.hdel(`${VIDEO_RETRY_PREFIX}${source}`, item.guid);

        // URL already seen (cross-feed dedup). Media items stay hard-skipped:
        // re-downloading a video/podcast was the exact duplicate-work problem
        // the YouTube share-token fix closed. Articles are different — a
        // deliberate re-bookmark means "capture this again", and canonical
        // filenames make the refresh overwrite in place rather than pile up
        // copies. One exception: a URL whose first capture was MANUAL (the
        // Chrome-extension paywall rescue) must never be clobbered by an
        // automated re-capture that would hit the same paywall.
        if (await deduplicator.isUrlSeen(item.url)) {
          const isMediaItem =
            Boolean(item.enclosure) ||
            item.mediaType === 'video' ||
            isApplePodcastsUrl(item.url);
          const firstSource = await deduplicator.getUrlSource(item.url);
          if (isMediaItem || firstSource === 'manual') {
            await job.log(`Duplicate URL skipped: ${item.canonicalUrl}`);
            continue;
          }
          console.log(JSON.stringify({
            event: 'rebookmark_refresh',
            url: item.url,
            source,
            timestamp: new Date().toISOString(),
          }));
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

  worker.on('completed', (job) => {
    console.log(`Feed poll completed: ${job.data.source}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Feed poll failed: ${job?.data.source}`, err.message);
  });

  return worker;
}

export async function startFeedPollWorker(): Promise<void> {
  if (feedPollWorker) {
    console.log(`Feed poll worker already started for queue '${FEED_QUEUE_NAME}'`);
    return;
  }
  feedPollWorker = createFeedPollWorker();
  console.log(`Feed poll worker started for queue '${FEED_QUEUE_NAME}'`);
}

export async function stopFeedPollWorker(): Promise<void> {
  if (!feedPollWorker) return;
  await feedPollWorker.close();
  feedPollWorker = null;
  console.log('Feed poll worker stopped');
}
