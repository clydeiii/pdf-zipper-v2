/**
 * Media collection worker
 * Downloads media files with retry logic for async transcript availability
 */

import { Worker, Job } from 'bullmq';
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { workerConnection } from '../config/redis.js';
import { downloadMedia } from './collector.js';
import { enrichVideo } from './video-enrichment.js';
import { maybeCompressVideo } from './video-compress.js';
import { findDuplicateVideo, appendVideoCrossRef, removeDuplicateDownload } from './video-dedup.js';
import { analyzePdfContent } from '../quality/pdf-content.js';
import { enrichDocumentMetadata } from '../metadata/enrichment.js';
import { setInfoDictFields } from '../utils/pdf-info-dict.js';
import { isGenericPdfBasename, slugifyTitle } from '../utils/save-pdf.js';
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
      const { item, existingFilePath } = job.data;

      // Rerun path: skip download, synthesize a successful-download result
      // from the on-disk file so the shared enrichment branches below run.
      let result: MediaCollectionResult;
      if (existingFilePath) {
        console.log(JSON.stringify({
          event: 'media_reenrich_start',
          mediaType: item.mediaType,
          existingFilePath,
          timestamp: new Date().toISOString(),
        }));
        const { statSync } = await import('node:fs');
        let fileSize = 0;
        try { fileSize = statSync(existingFilePath).size; } catch { /* ignore */ }
        result = {
          success: true,
          item,
          filePath: existingFilePath,
          fileSize,
          downloadDuration: 0,
        };
      } else {
        console.log(JSON.stringify({
          event: 'media_download_start',
          mediaType: item.mediaType,
          url: item.url,
          enclosureUrl: item.enclosure.url,
          attempt: job.attemptsMade + 1,
          timestamp: new Date().toISOString(),
        }));
        result = await downloadMedia(item);
      }

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
          // Duplicate check BEFORE the expensive compress/transcribe steps.
          // Bookmarking both a tweet and a quote-tweet of it delivers the
          // SAME embedded video twice; keep the first copy as canonical,
          // record this bookmark's URL on it, and drop the fresh download.
          // Fresh downloads only — a re-enrich of a library file would match
          // other copies and delete the file it is meant to refresh.
          if (!existingFilePath) {
            const dup = await findDuplicateVideo(result.filePath);
            if (dup) {
              const crossRefOk = await appendVideoCrossRef(dup.existingPath, item.url);
              await removeDuplicateDownload(result.filePath);
              console.log(JSON.stringify({
                event: 'video_dedup',
                duplicateOf: dup.existingPath,
                droppedDownload: result.filePath,
                bookmarkUrl: item.url,
                crossRefRecorded: crossRefOk,
                timestamp: new Date().toISOString(),
              }));
              result.filePath = dup.existingPath;
              return result;
            }
          }
          // Compress BEFORE enrichment so metadata/VTT are embedded into the
          // final file. Bitrate-gated: lean YouTube grabs skip, fat X grabs
          // re-encode. Never throws — failure keeps the original file.
          const compressResult = await maybeCompressVideo(result.filePath);
          if (compressResult.compressed && compressResult.newSizeBytes) {
            result.fileSize = compressResult.newSizeBytes;
          }
          try {
            const enrichResult = await enrichVideo(result.filePath, item);
            // enrichVideo may rename the file to {channel}-{title}.mp4; reflect
            // the final path in the event log + downstream result.
            const finalFilePath = enrichResult.filePath || result.filePath;
            if (enrichResult.filePath) result.filePath = enrichResult.filePath;
            console.log(JSON.stringify({
              event: 'video_enrichment_complete',
              filePath: finalFilePath,
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

              // Karakeep PDF assets are typically uploaded papers/reports.
              // Default to 'research' since we have no URL to classify by.
              setInfoDictFields(pdfDoc, {
                Summary: metadata.summary,
                Language: metadata.language,
                Publication: metadata.publication,
                PublishDate: metadata.publishDate,
                Tags: metadata.tags.length > 0 ? metadata.tags.join(', ') : undefined,
                Translation: metadata.translation,
                DocType: 'research',
                EnrichedAt: new Date().toISOString(),
              });

              const enrichedPdf = await pdfDoc.save();
              await writeFile(result.filePath, Buffer.from(enrichedPdf));

              // Karakeep PDF assets are named from the uploaded filename, which
              // is often generic ("report.pdf" → saved as "report.pdf.pdf").
              // Now that enrichment has the real document title, rename the file
              // to a content-derived name. Only for generic names so descriptive
              // uploads (e.g. "frontiermath-batch-2.pdf") are left alone.
              if (metadata.title && isGenericPdfBasename(path.basename(result.filePath))) {
                const titleSlug = slugifyTitle(metadata.title).slice(0, 100);
                if (titleSlug) {
                  const dir = path.dirname(result.filePath);
                  let candidate = path.join(dir, `${titleSlug}.pdf`);
                  // Avoid clobbering a different file with the same title.
                  for (let n = 2; n <= 20; n++) {
                    if (path.resolve(candidate) === path.resolve(result.filePath)) break;
                    try { await access(candidate); candidate = path.join(dir, `${titleSlug}-${n}.pdf`); }
                    catch { break; } // ENOENT → free to use
                  }
                  if (path.resolve(candidate) !== path.resolve(result.filePath)) {
                    await rename(result.filePath, candidate);
                    console.log(JSON.stringify({
                      event: 'pdf_asset_renamed',
                      from: path.basename(result.filePath),
                      to: path.basename(candidate),
                      timestamp: new Date().toISOString(),
                    }));
                    result.filePath = candidate;
                  }
                }
              }

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
