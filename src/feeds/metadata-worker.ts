import { Worker, Job } from 'bullmq';
import { workerConnection } from '../config/redis.js';
import { METADATA_QUEUE_NAME, mediaCollectionQueue } from './monitor.js';
import { extractUrlMetadata } from '../urls/metadata.js';
import { conversionQueue } from '../queues/conversion.queue.js';
import { podcastQueue } from '../podcasts/podcast.queue.js';
import { isApplePodcastsUrl } from '../podcasts/apple.js';
import type { MetadataJobData } from './monitor.js';
import type { ConversionJobData } from '../jobs/types.js';
import type { PodcastJobData } from '../podcasts/types.js';
import type { BookmarkItem } from './types.js';
import type { MediaItem } from '../media/types.js';

/**
 * Sanitize a URL for use as a BullMQ job ID
 * BullMQ doesn't allow colons in job IDs
 */
function sanitizeJobId(prefix: string, url: string): string {
  // Replace problematic characters with underscores
  const sanitized = url.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${prefix}-${sanitized}`;
}

/**
 * Type guard to check if a BookmarkItem has media enclosure
 */
function hasMediaEnclosure(item: BookmarkItem): item is MediaItem {
  return !!item.enclosure && !!item.mediaType;
}

/**
 * Check if a URL is a YouTube/video URL that should only be processed via media collection
 * These URLs should not be PDF-captured - they need to come through with a video enclosure
 */
function isVideoOnlyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'youtu.be' ||
      host === 'm.youtube.com' ||
      host === 'vimeo.com' ||
      host === 'www.vimeo.com'
    );
  } catch {
    return false;
  }
}

/**
 * Metadata extraction worker
 *
 * Extracts rich metadata from URLs and queues for PDF conversion.
 * Merges feed metadata with extracted metadata (web takes precedence).
 * Items with media enclosures are also queued for media collection.
 */
/**
 * Check if URL is a Karakeep asset URL (not a web page)
 */
function isKarakeepAssetUrl(url: string): boolean {
  return url.includes('/api/assets/');
}

export const metadataWorker = new Worker<MetadataJobData>(
  METADATA_QUEUE_NAME,
  async (job: Job<MetadataJobData>) => {
    const { url, canonicalUrl, source, feedMetadata } = job.data;

    // Skip web metadata extraction for Karakeep asset URLs (they're not web pages)
    let webMetadata: { title?: string; author?: string; date?: string; description?: string; image?: string; publisher?: string } = {};

    if (isKarakeepAssetUrl(url)) {
      await job.log(`Skipping metadata extraction for asset URL: ${url}`);
    } else {
      await job.log(`Extracting metadata from ${url}`);
      webMetadata = await extractUrlMetadata(url);
    }

    // Merge: web metadata preferred, feed metadata as fallback
    // Include media fields if present
    const enrichedItem: BookmarkItem = {
      url: canonicalUrl,
      canonicalUrl,
      guid: feedMetadata.guid,
      source,
      title: webMetadata.title || feedMetadata.title || 'Untitled',
      author: webMetadata.author || feedMetadata.creator,
      creator: feedMetadata.creator,
      publishedAt: webMetadata.date,
      description: webMetadata.description,
      image: webMetadata.image,
      publisher: webMetadata.publisher,
      bookmarkedAt: feedMetadata.bookmarkedAt || new Date().toISOString(),
      // Media fields (optional)
      enclosure: feedMetadata.enclosure,
      mediaType: feedMetadata.mediaType,
    };

    await job.log(`Metadata extracted: ${enrichedItem.title}`);

    // Queue for media collection if item has enclosure
    if (hasMediaEnclosure(enrichedItem)) {
      await mediaCollectionQueue.add(
        `media-${enrichedItem.guid}`,
        { item: enrichedItem },
        { jobId: sanitizeJobId('media', enrichedItem.canonicalUrl) }  // Dedupe by canonical URL
      );

      console.log(JSON.stringify({
        event: 'media_queued',
        mediaType: enrichedItem.mediaType,
        url: enrichedItem.url,
        enclosureUrl: enrichedItem.enclosure.url,
        timestamp: new Date().toISOString(),
      }));

      await job.log(`Queued for media collection: ${enrichedItem.mediaType}`);

      // For uploaded PDF assets, skip web metadata extraction and PDF conversion
      // The PDF file is already complete - just download it via media collection
      if (enrichedItem.mediaType === 'pdf') {
        console.log(JSON.stringify({
          event: 'pdf_asset_handled',
          url: enrichedItem.url,
          title: enrichedItem.title,
          timestamp: new Date().toISOString(),
        }));

        return {
          url: canonicalUrl,
          metadata: enrichedItem,
          mediaOnly: true,
        };
      }
    }

    // Check if this is an Apple Podcasts URL - route to podcast transcription
    if (isApplePodcastsUrl(url)) {
      const podcastJobData: PodcastJobData = {
        url: url,
        originalUrl: url,
        bookmarkedAt: enrichedItem.bookmarkedAt,
        source,
      };

      const podcastJob = await podcastQueue.add('transcribe-podcast', podcastJobData);

      await job.log(`Apple Podcasts URL detected - queued for transcription: job ${podcastJob.id}`);

      console.log(JSON.stringify({
        event: 'podcast_queued',
        url: url,
        source,
        title: enrichedItem.title,
        podcastJobId: podcastJob.id,
        timestamp: new Date().toISOString(),
      }));

      return {
        url: canonicalUrl,
        metadata: enrichedItem,
        podcastJobId: podcastJob.id,
      };
    }

    // Skip PDF conversion for video-only URLs (YouTube, Vimeo, etc.)
    // These should only be processed via media collection with a video enclosure from Karakeep
    if (isVideoOnlyUrl(url)) {
      console.log(JSON.stringify({
        event: 'video_url_skipped',
        url: url,
        reason: 'Video URLs are processed via media collection, not PDF conversion',
        timestamp: new Date().toISOString(),
      }));

      await job.log(`Skipped video URL (no enclosure): ${url}`);

      return {
        url: canonicalUrl,
        metadata: enrichedItem,
        skipped: true,
        reason: 'video_url_without_enclosure',
      };
    }

    // Queue for PDF conversion with metadata for file organization
    // Use original URL for conversion (some sites require www.), preserve for archive.is too
    const conversionJobData: ConversionJobData = {
      url: url,  // Original URL (may have www.) - used for actual HTTP request
      originalUrl: url,  // Preserved for archive.is links and PDF metadata
      title: enrichedItem.title,
      bookmarkedAt: enrichedItem.bookmarkedAt,
    };

    const conversionJob = await conversionQueue.add('convert-url', conversionJobData);

    await job.log(`Queued for conversion: job ${conversionJob.id}`);

    console.log(JSON.stringify({
      event: 'bookmark_queued',
      url: url,
      source,
      title: enrichedItem.title,
      conversionJobId: conversionJob.id,
      timestamp: new Date().toISOString(),
    }));

    return {
      url: canonicalUrl,
      metadata: enrichedItem,
      conversionJobId: conversionJob.id,
    };
  },
  {
    connection: workerConnection,
    concurrency: 2, // Limit parallel extractions to reduce CPU load
  }
);

metadataWorker.on('completed', (job) => {
  console.log(`Metadata extraction completed: ${job.data.url}`);
});

metadataWorker.on('failed', (job, err) => {
  console.error(`Metadata extraction failed: ${job?.data.url}`, err.message);
});

console.log(`Metadata worker started for queue '${METADATA_QUEUE_NAME}'`);
