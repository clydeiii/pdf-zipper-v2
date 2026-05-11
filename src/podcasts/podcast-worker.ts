/**
 * Podcast transcription worker
 *
 * Processes Apple Podcasts URLs through the full pipeline:
 * 1. Fetch metadata from iTunes API
 * 2. Download audio file
 * 3. Transcribe with Whisper ASR
 * 4. Format transcript with LLM (readable paragraphs)
 * 5. Generate PDF with metadata + transcript
 * 6. Save to weekly bin
 */

import { Worker, Job } from 'bullmq';
import * as path from 'node:path';
import { writeFile, mkdir, copyFile, unlink } from 'node:fs/promises';
import { workerConnection } from '../config/redis.js';
import { PODCAST_QUEUE_NAME } from './podcast.queue.js';
import { getPodcastMetadata } from './apple.js';
import { transcribePodcast } from './transcriber.js';
import { formatTranscriptWithLLM } from './transcript-formatter.js';
import { generateTranscriptPdf } from './pdf-generator.js';
import { getWeeklyBinPath, ensureWeeklyBinExists } from '../media/organization.js';
import { env } from '../config/env.js';
import { sendDiscordNotification } from '../notifications/discord.js';
import type { PodcastJobData, PodcastJobResult, PodcastMetadata } from './types.js';
import { writeAudioMetadata } from '../metadata/audio-tags.js';
import { enrichDocumentMetadata } from '../metadata/enrichment.js';

// Sanitize filename helper
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sanitizeFilename = require('sanitize-filename') as (input: string) => string;

let worker: Worker<PodcastJobData, PodcastJobResult> | null = null;

/**
 * Build initial_prompt for Whisper from metadata
 * Helps Whisper recognize proper nouns, product names, etc.
 *
 * Format: "This podcast episode is titled '{title}' and discusses: {link texts}"
 */
function buildWhisperHints(metadata: PodcastMetadata): string | null {
  const hints: string[] = [];

  // Episode title often contains key proper nouns
  if (metadata.episodeTitle) {
    hints.push(metadata.episodeTitle);
  }

  // Extract proper nouns from show notes links
  if (metadata.showNotes?.links && metadata.showNotes.links.length > 0) {
    for (const link of metadata.showNotes.links.slice(0, 10)) {  // Limit to first 10
      // Extract likely brand names (mixed case, abbreviations)
      const brandMatches = link.text.match(/[A-Z][a-z]+[A-Z][a-z]+|[A-Z]{2,}|[a-z]+[A-Z]/g) || [];
      hints.push(...brandMatches);

      // Also include known tech terms from link text
      const techTerms = link.text.match(/\b(AI|GPT|LLM|API|SDK|ML|AR|VR|IoT|NFT|DeFi|Web3)\b/gi) || [];
      hints.push(...techTerms);
    }
  }

  if (hints.length === 0) return null;

  // Dedupe and format
  const uniqueHints = [...new Set(hints)];
  return `This podcast discusses: ${uniqueHints.join(', ')}`;
}

/**
 * Generate base filename for podcast files (without extension)
 * Format: {podcast-slug}-{episode-slug}
 */
function getPodcastBaseFilename(metadata: PodcastMetadata): string {
  const podcastSlug = sanitizeFilename(metadata.podcastName)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);

  const episodeSlug = sanitizeFilename(metadata.episodeTitle)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  return `${podcastSlug}-${episodeSlug}`;
}

/**
 * Save debug PDF for failed podcast jobs
 */
async function saveDebugInfo(jobId: string, info: object): Promise<void> {
  try {
    const dataDir = env.DATA_DIR || './data';
    const debugDir = path.join(dataDir, 'debug');
    await mkdir(debugDir, { recursive: true });

    const filename = `podcast-${jobId}.json`;
    const filePath = path.join(debugDir, filename);
    await writeFile(filePath, JSON.stringify(info, null, 2));

    console.log(`Debug info saved: ${filePath}`);
  } catch (error) {
    console.error(`Failed to save debug info for job ${jobId}:`, error);
  }
}

/**
 * Start the podcast transcription worker
 */
export async function startPodcastWorker(): Promise<void> {
  worker = new Worker<PodcastJobData, PodcastJobResult>(
    PODCAST_QUEUE_NAME,
    async (job: Job<PodcastJobData, PodcastJobResult>) => {
      const { url, bookmarkedAt, source } = job.data;
      const startTime = Date.now();

      console.log(JSON.stringify({
        event: 'podcast_job_start',
        jobId: job.id,
        url,
        source,
        timestamp: new Date().toISOString(),
      }));

      try {
        // Step 1: Fetch metadata from iTunes API
        await job.updateProgress(10);
        await job.log('Fetching podcast metadata from iTunes...');

        const metadata = await getPodcastMetadata(url);

        await job.log(`Found: "${metadata.episodeTitle}" from "${metadata.podcastName}"`);
        await job.log(`Duration: ${Math.round(metadata.duration / 60000)} minutes`);
        await job.log(`Audio URL: ${metadata.audioUrl.substring(0, 80)}...`);

        // Step 2: Download and transcribe audio
        await job.updateProgress(20);
        await job.log('Downloading audio and transcribing with Parakeet...');

        const durationMin = Math.round(metadata.duration / 60000);
        await sendDiscordNotification({
          type: 'info',
          title: '🎙️ Parakeet: transcribing',
          description: `"${metadata.episodeTitle}"`,
          fields: [
            { name: 'Show', value: metadata.podcastName, inline: true },
            { name: 'Duration', value: `${durationMin} min`, inline: true },
          ],
        });

        const transcribeStart = Date.now();
        const transcriptionResult = await transcribePodcast(
          metadata.audioUrl,
          metadata.audioExtension
        );

        const { transcript, audioPath: tempAudioPath, audioSize } = transcriptionResult;
        const transcribeElapsed = Math.round((Date.now() - transcribeStart) / 1000);

        await job.log(`Transcription complete: ${transcript.text.length.toLocaleString()} characters`);
        await job.log(`Audio file: ${Math.round(audioSize / 1024 / 1024 * 10) / 10} MB`);

        await sendDiscordNotification({
          type: 'success',
          title: '🎙️ Parakeet: done',
          description: `"${metadata.episodeTitle}"`,
          fields: [
            { name: 'Time', value: `${transcribeElapsed}s`, inline: true },
            { name: 'Speed', value: `${((durationMin * 60) / transcribeElapsed).toFixed(0)}x realtime`, inline: true },
            { name: 'Chars', value: transcript.text.length.toLocaleString(), inline: true },
          ],
        });

        // Step 3: Format transcript with LLM for readability
        await job.updateProgress(60);

        const hasHints = !!(metadata.showNotes?.links?.length || metadata.episodeTitle);
        if (hasHints) {
          await job.log('Formatting transcript with Gemma4 (proper-noun correction)...');
          await sendDiscordNotification({
            type: 'info',
            title: '🧠 Gemma4: formatting',
            description: `"${metadata.episodeTitle}"`,
            fields: [
              { name: 'Chunks', value: `~${Math.ceil(transcript.text.length / 15000)}`, inline: true },
              { name: 'Input', value: `${transcript.text.length.toLocaleString()} chars`, inline: true },
            ],
          });
        } else {
          await job.log('No spelling hints — skipping LLM formatting (Parakeet output is clean)');
        }

        const formatStart = Date.now();
        const formattedText = await formatTranscriptWithLLM(transcript.text, {
          showNotes: metadata.showNotes,
          episodeTitle: metadata.episodeTitle,
        });
        const formattedTranscript = { ...transcript, text: formattedText };
        const formatElapsed = Math.round((Date.now() - formatStart) / 1000);

        if (hasHints) {
          await sendDiscordNotification({
            type: 'success',
            title: '🧠 Gemma4: done',
            description: `"${metadata.episodeTitle}"`,
            fields: [
              { name: 'Time', value: `${formatElapsed}s`, inline: true },
              { name: 'Output', value: `${formattedText.length.toLocaleString()} chars`, inline: true },
            ],
          });
        }

        await job.log(`Formatted: ${formattedText.length.toLocaleString()} characters`);

        // Step 4: Generate PDF
        await job.updateProgress(85);
        await job.log('Generating transcript PDF...');

        const pdfBuffer = await generateTranscriptPdf(metadata, formattedTranscript);

        await job.log(`PDF generated: ${pdfBuffer.length.toLocaleString()} bytes`);

        // Step 5: Save to weekly bin (both PDF and audio)
        await job.updateProgress(90);
        await job.log('Saving to weekly bin...');

        const binPath = getWeeklyBinPath(
          bookmarkedAt || new Date().toISOString(),
          'podcast'
        );
        await ensureWeeklyBinExists(binPath);

        const baseFilename = getPodcastBaseFilename(metadata);
        const pdfFilename = `${baseFilename}.pdf`;
        const audioFilename = `${baseFilename}.${metadata.audioExtension}`;

        const pdfPath = path.join(binPath, pdfFilename);
        const audioPath = path.join(binPath, audioFilename);

        // Save PDF
        await writeFile(pdfPath, pdfBuffer);

        // Copy audio file to archive (then cleanup temp)
        await copyFile(tempAudioPath, audioPath);
        await unlink(tempAudioPath);

        // Step 6: Enrich metadata using AI + write to audio file + generate .md companion
        await job.updateProgress(95);
        await job.log('Enriching metadata and writing tags...');

        let summary: string | undefined;
        let tags: string[] | undefined;
        try {
          // Use AI to extract summary/tags from transcript
          const enriched = await enrichDocumentMetadata(
            formattedTranscript.text.slice(0, 8000),
            metadata.episodeUrl,
            metadata.episodeTitle
          );
          summary = enriched.summary;
          tags = enriched.tags;

          // Write ID3 tags to MP3 (includes full transcript in USLT lyrics frame)
          writeAudioMetadata(audioPath, {
            podcastMetadata: metadata,
            summary,
            tags,
            transcriptLength: formattedTranscript.text.length,
            transcriptText: formattedTranscript.text,
          });

          await job.log(`Metadata enriched: [${tags?.join(', ')}]`);
        } catch (error) {
          // Non-fatal: continue without enrichment
          console.warn('Podcast metadata enrichment failed:', error instanceof Error ? error.message : error);
        }

        const totalTime = Date.now() - startTime;

        await job.log(`Saved PDF: ${pdfPath}`);
        await job.log(`Saved audio: ${audioPath}`);
        await job.log(`Total time: ${Math.round(totalTime / 1000)}s`);

        console.log(JSON.stringify({
          event: 'podcast_job_complete',
          jobId: job.id,
          episodeTitle: metadata.episodeTitle,
          rawTranscriptLength: transcript.text.length,
          formattedTranscriptLength: formattedTranscript.text.length,
          pdfPath,
          audioPath,
          audioSizeMB: Math.round(audioSize / 1024 / 1024 * 10) / 10,
          totalTimeMs: totalTime,
          timestamp: new Date().toISOString(),
        }));

        // Send success notification
        await sendDiscordNotification({
          type: 'success',
          title: `Podcast Transcribed`,
          description: `"${metadata.episodeTitle}" from ${metadata.podcastName}`,
          url: metadata.episodeUrl,
          fields: [
            { name: 'Duration', value: `${Math.round(metadata.duration / 60000)} min`, inline: true },
            { name: 'Transcript', value: `${formattedTranscript.text.length.toLocaleString()} chars`, inline: true },
            { name: 'Audio', value: `${Math.round(audioSize / 1024 / 1024 * 10) / 10} MB`, inline: true },
          ],
        });

        return {
          success: true,
          pdfPath,
          metadata,
          transcriptLength: formattedTranscript.text.length,
          audioDuration: metadata.duration,
          completedAt: new Date().toISOString(),
        };

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        console.error(JSON.stringify({
          event: 'podcast_job_error',
          jobId: job.id,
          url,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        }));

        // Save debug info
        await saveDebugInfo(job.id || 'unknown', {
          url,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: new Date().toISOString(),
        });

        throw error;  // Re-throw to trigger retry/failure
      }
    },
    {
      connection: workerConnection,
      concurrency: 1,  // Only one transcription at a time (CPU/memory intensive)
    }
  );

  // Event handlers
  worker.on('completed', (job) => {
    console.log(`Podcast transcription completed: ${job.data.url}`);
  });

  worker.on('failed', async (job, err) => {
    console.error(`Podcast transcription failed: ${job?.data.url}`, err.message);

    // Send failure notification
    if (job) {
      await sendDiscordNotification({
        type: 'failure',
        title: 'Podcast Transcription Failed',
        description: job.data.url,
        fields: [
          { name: 'Error', value: err.message.substring(0, 200), inline: false },
          { name: 'Attempts', value: `${job.attemptsMade}/${job.opts.attempts || 2}`, inline: true },
        ],
      });
    }
  });

  worker.on('progress', (job, progress) => {
    console.log(`Podcast job ${job.id} progress: ${progress}%`);
  });

  console.log(`Podcast worker started for queue '${PODCAST_QUEUE_NAME}'`);
}

/**
 * Stop the podcast worker gracefully
 */
export async function stopPodcastWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('Podcast worker stopped');
  }
}
