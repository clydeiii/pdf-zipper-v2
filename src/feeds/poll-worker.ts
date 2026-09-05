import { Worker, Job } from 'bullmq';
import { workerConnection, createConnection } from '../config/redis.js';
import { parseMatterFeed, parseKarakeepFeed } from './parsers/index.js';
import { fetchKarakeepBookmarkItem } from './parsers/karakeep.js';
import { BookmarkDeduplicator } from '../urls/deduplicator.js';
import { FEED_QUEUE_NAME, metadataQueue, mediaCollectionQueue } from './monitor.js';
import { mediaJobId, needsMediaRecheck } from './media-recheck.js';
import { applyMediaRouting, acquisitionSourceOf } from '../media/routing.js';
import { env } from '../config/env.js';
import type { FeedPollJobData, MetadataJobData } from './monitor.js';
import type { BookmarkItem, FeedCacheState } from './types.js';
import type { MediaItem } from '../media/types.js';
import { isApplePodcastsUrl } from '../podcasts/apple.js';

/**
 * Late-video re-check for tweets. Karakeep runs yt-dlp on an x.com bookmark
 * AFTER the bookmark appears in the API, and the feed poll usually sees the
 * bookmark first: the tweet is processed as a plain link (PDF only) and the
 * video asset that lands a minute later is never collected. YouTube has a
 * wait loop for exactly this (the item is left GUID-unseen); tweets can't
 * use it because their PDF must not wait. Instead the GUID is parked here,
 * and each poll looks it up by id for up to MAX_MEDIA_RECHECKS polls; the
 * moment the asset exists the media job is queued directly. The coverage
 * audit found 6 such tweets in 2 days on 2026-09-05 (Karakeep held the
 * video, the library had only the PDF).
 */
const MEDIA_RECHECK_PREFIX = 'feed:media-recheck:';
const MAX_MEDIA_RECHECKS = Number(process.env.FEED_MEDIA_MAX_RECHECKS) || 8; // ≈40 min at 5-min polls


interface MediaRecheckEntry { url: string; attempts: number; since: string }

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
        // Tweets parked for a late video asset: look each up by id; queue the
        // media job as soon as Karakeep has the asset, give up after the cap.
        const recheckKey = `${MEDIA_RECHECK_PREFIX}${source}`;
        for (const [guid, raw] of Object.entries(await redis.hgetall(recheckKey))) {
          let entry: MediaRecheckEntry;
          try { entry = JSON.parse(raw); } catch { await redis.hdel(recheckKey, guid); continue; }
          const lookup = await fetchKarakeepBookmarkItem(feedUrl, guid);
          if (lookup === 'gone') {
            await redis.hdel(recheckKey, guid);
            continue;
          }
          if (lookup && lookup.enclosure && lookup.mediaType === 'video') {
            await mediaCollectionQueue.add(
              `media-${guid}`,
              { item: lookup as MediaItem },
              { jobId: mediaJobId(lookup.canonicalUrl) }
            );
            await redis.hdel(recheckKey, guid);
            console.log(JSON.stringify({
              event: 'late_video_asset_collected',
              url: lookup.url,
              guid,
              attempts: entry.attempts + 1,
              since: entry.since,
              timestamp: new Date().toISOString(),
            }));
            continue;
          }
          entry.attempts += 1;
          if (entry.attempts >= MAX_MEDIA_RECHECKS) {
            // No asset after the whole window: a text/image tweet, or a video
            // Karakeep couldn't fetch. Either way nothing more to collect.
            await redis.hdel(recheckKey, guid);
          } else {
            await redis.hset(recheckKey, guid, JSON.stringify(entry));
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

      // Acquisition routing (owner decision 2026-09-05: pdf-zipper downloads
      // every video itself). In native mode YouTube/Vimeo get a yt-dlp
      // enclosure right here, so the asset wait below never engages and the
      // metadata worker queues the download on this very poll.
      const routing = { youtube: env.MEDIA_SOURCE_YOUTUBE };
      result.items = result.items.map((item) => {
        const routed = applyMediaRouting(item, routing);
        if (routed !== item) {
          console.log(JSON.stringify({ event: 'media_routed', url: item.url, source: acquisitionSourceOf(routed), timestamp: new Date().toISOString() }));
        }
        return routed;
      });

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

        // Tweet with no video asset (yet): park it for the late-video re-check
        // while the PDF capture proceeds normally below.
        if (source === 'karakeep' && needsMediaRecheck(item)) {
          const entry: MediaRecheckEntry = { url: item.url, attempts: 0, since: new Date().toISOString() };
          await redis.hset(`${MEDIA_RECHECK_PREFIX}${source}`, item.guid, JSON.stringify(entry));
        }

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
