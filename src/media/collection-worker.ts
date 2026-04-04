/**
 * Media collection worker
 * Downloads media files with retry logic for async transcript availability
 */

import { Worker, Job } from 'bullmq';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { workerConnection } from '../config/redis.js';
import { downloadMedia } from './collector.js';
import { enrichVideo } from './video-enrichment.js';
import { analyzePdfContent } from '../quality/pdf-content.js';
import { enrichDocumentMetadata } from '../metadata/enrichment.js';
import { setInfoDictFields } from '../utils/pdf-info-dict.js';
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

        // Post-download enrichment for video files
        if (item.mediaType === 'video' && result.filePath.endsWith('.mp4')) {
          try {
            const enrichResult = await enrichVideo(result.filePath, item);
            console.log(JSON.stringify({
              event: 'video_enrichment_complete',
              filePath: result.filePath,
              transcriptLength: enrichResult.transcriptLength,
              vttEmbedded: enrichResult.vttEmbedded,
              metadataWritten: enrichResult.metadataWritten,
              tags: enrichResult.tags,
              timestamp: new Date().toISOString(),
            }));
          } catch (err) {
            // Non-fatal: video was still downloaded successfully
            console.warn('Video enrichment failed (non-fatal):', err instanceof Error ? err.message : err);
          }
        }

        // Post-download enrichment for PDF assets (Karpathify)
        if (item.mediaType === 'pdf' && result.filePath.endsWith('.pdf')) {
          try {
            const pdfBuffer = await readFile(result.filePath);
            const contentResult = await analyzePdfContent(pdfBuffer);

            if (contentResult.extractedText && contentResult.extractedText.length > 100) {
              const metadata = await enrichDocumentMetadata(contentResult.extractedText, item.url, item.title);

              // Embed metadata into the PDF Info Dict
              const pdfDoc = await PDFDocument.load(pdfBuffer);
              if (metadata.title) pdfDoc.setTitle(metadata.title);
              if (metadata.author) pdfDoc.setAuthor(metadata.author);
              if (metadata.tags.length > 0) pdfDoc.setKeywords(metadata.tags);
              if (metadata.publication) pdfDoc.setCreator(`${metadata.publication} via pdf-zipper v2`);
              pdfDoc.setSubject(item.url);
              pdfDoc.setProducer(`pdf-zipper v2 - captured ${new Date().toISOString()}`);

              setInfoDictFields(pdfDoc, {
                Summary: metadata.summary,
                Language: metadata.language,
                Publication: metadata.publication,
                PublishDate: metadata.publishDate,
                Tags: metadata.tags.length > 0 ? metadata.tags.join(', ') : undefined,
                Translation: metadata.translation,
                EnrichedAt: new Date().toISOString(),
              });

              const enrichedPdf = await pdfDoc.save();
              await writeFile(result.filePath, Buffer.from(enrichedPdf));

              console.log(JSON.stringify({
                event: 'pdf_asset_enrichment_complete',
                filePath: result.filePath,
                title: metadata.title,
                language: metadata.language,
                tags: metadata.tags,
                timestamp: new Date().toISOString(),
              }));
            }
          } catch (err) {
            // Non-fatal: PDF was still downloaded successfully
            console.warn('PDF asset enrichment failed (non-fatal):', err instanceof Error ? err.message : err);
          }
        }

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
