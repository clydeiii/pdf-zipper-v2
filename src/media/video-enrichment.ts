/**
 * Post-download video enrichment pipeline
 *
 * After a video is downloaded by the media collector:
 * 1. Extract audio track via ffmpeg
 * 2. Send audio to Whisper ASR for transcription (txt + vtt)
 * 3. Use AI to extract summary/tags from transcript
 * 4. Embed VTT subtitles into MP4
 * 5. Write metadata to MP4 (title, summary, tags, etc.)
 * 6. Generate transcript PDF alongside video
 */

import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import { createRequire } from 'node:module';
import { enrichVideoFile } from '../metadata/video-tags.js';
import { enrichDocumentMetadata } from '../metadata/enrichment.js';
import { generateTranscriptPdf } from '../metadata/transcript-pdf.js';
import { formatTranscriptWithLLM } from '../podcasts/transcript-formatter.js';
import { transcribeWithRetry } from '../utils/whisper-host.js';
import { createMultipartFileBody } from '../utils/multipart.js';
import { sendDiscordNotification } from '../notifications/discord.js';
import { fetchYouTubeMetadata } from './youtube-metadata.js';
import { isTwitterUrl } from '../utils/save-pdf.js';
import { env } from '../config/env.js';
import type { MediaItem } from './types.js';

const require = createRequire(import.meta.url);
const sanitizeFilename = require('sanitize-filename') as (input: string) => string;

/**
 * Build a `{channel}-{title}` base filename for a YouTube/Vimeo video, mirroring
 * the podcast worker's `{podcast}-{episode}` convention so the KB groups
 * each creator's media together. Returns null if either piece is missing.
 *
 * Slug rules match getPodcastBaseFilename for cross-format consistency: lower
 * case, drop non-alphanumeric, collapse runs of dashes, cap at 30/50 chars.
 */
function buildVideoBaseName(channel: string | undefined, title: string | undefined): string | null {
  if (!channel || !title) return null;
  const slug = (s: string, max: number) =>
    sanitizeFilename(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, max);
  const channelSlug = slug(channel, 30);
  const titleSlug = slug(title, 50);
  if (!channelSlug || !titleSlug) return null;
  return `${channelSlug}-${titleSlug}`;
}

const execFileAsync = promisify(execFile);

const TEMP_DIR = process.env.TEMP_DIR || '/tmp/video-enrichment';

/**
 * Probe a media file's duration in minutes via ffprobe. Returns null on failure
 * so callers can fail open (transcribe) rather than silently skip.
 */
async function probeDurationMinutes(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      filePath,
    ], { timeout: 30000 });
    const seconds = parseFloat(String(stdout).trim());
    return Number.isFinite(seconds) ? seconds / 60 : null;
  } catch {
    return null;
  }
}

/**
 * Last-resort title when neither the feed item nor yt-dlp supplies one.
 * De-slugifies the on-disk filename (e.g.
 * "y-combinator-inference-diffusion-world-models-and-more-yc-paper" →
 * "Y Combinator Inference Diffusion World Models And More Yc Paper").
 * Far more useful to the downstream KB than a bare "Video Transcript"
 * placeholder, which is what a re-enrich of a metadata-less MP4 used to get.
 */
function deriveTitleFromFilename(mp4Path: string): string {
  const base = path.basename(mp4Path, path.extname(mp4Path)).replace(/\.transcript$/i, '');
  const words = base.replace(/[-_]+/g, ' ').trim();
  if (!words) return 'Video Transcript';
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Whisper agent with extended timeouts (videos can be hours long) */
const whisperAgent = new Agent({
  headersTimeout: 4 * 60 * 60 * 1000,
  bodyTimeout: 4 * 60 * 60 * 1000,
  connectTimeout: 5 * 60 * 1000,
});

/**
 * Extract audio from an MP4 file as WAV for Whisper
 * Uses ffmpeg to demux audio stream
 */
async function extractAudio(mp4Path: string): Promise<string> {
  await mkdir(TEMP_DIR, { recursive: true });
  const audioPath = path.join(TEMP_DIR, `${randomUUID()}.wav`);

  await execFileAsync('ffmpeg', [
    '-i', mp4Path,
    '-vn',                    // No video
    '-acodec', 'pcm_s16le',  // WAV format (Whisper prefers this)
    '-ar', '16000',           // 16kHz sample rate (Whisper's native rate)
    '-ac', '1',               // Mono
    '-y', audioPath,
  ], { timeout: 600000 });  // 10 min timeout for large files

  return audioPath;
}

/**
 * Send audio to Whisper ASR and get both text and VTT output
 */
async function transcribeForVideo(audioPath: string): Promise<{ text: string; vtt: string }> {
  const filename = path.basename(audioPath);

  // Retry across transient ASR failures; each attempt re-resolves the host so
  // a recovered primary is picked up. Within one attempt both /asr calls
  // (text + VTT) share the resolved host — same backend, same audio.
  return transcribeWithRetry(`video:${filename}`, async ({ host, audioFieldName }) => {
    // Request text transcript
    const textUrl = new URL('/asr', host);
    textUrl.searchParams.set('output', 'txt');

    const textForm = await createMultipartFileBody({
      filePath: audioPath,
      filename,
      fieldName: audioFieldName,
    });

    const textResp = await fetch(textUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': textForm.contentType,
        'Content-Length': String(textForm.contentLength),
      },
      body: textForm.body,
      duplex: 'half',
      dispatcher: whisperAgent,
    } as unknown as RequestInit & { duplex: 'half'; dispatcher: Agent });
    if (!textResp.ok) throw new Error(`Whisper text error: ${textResp.status}`);
    const text = await textResp.text();

    // Request VTT subtitle format
    const vttUrl = new URL('/asr', host);
    vttUrl.searchParams.set('output', 'vtt');

    const vttForm = await createMultipartFileBody({
      filePath: audioPath,
      filename,
      fieldName: audioFieldName,
    });

    const vttResp = await fetch(vttUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': vttForm.contentType,
        'Content-Length': String(vttForm.contentLength),
      },
      body: vttForm.body,
      duplex: 'half',
      dispatcher: whisperAgent,
    } as unknown as RequestInit & { duplex: 'half'; dispatcher: Agent });
    if (!vttResp.ok) throw new Error(`Whisper VTT error: ${vttResp.status}`);
    const vtt = await vttResp.text();

    return { text, vtt };
  });
}

export interface VideoEnrichmentResult {
  /** Final MP4 path — present when enrichment renamed the file (channel-prefix). */
  filePath?: string;
  transcriptPath?: string;
  transcriptLength?: number;
  vttEmbedded?: boolean;
  metadataWritten?: boolean;
  summary?: string;
  tags?: string[];
}

/**
 * Enrich a downloaded video file with transcription, subtitles, and metadata
 *
 * @param mp4Path - Path to the downloaded MP4 file
 * @param item - Media item metadata from feed
 * @returns Enrichment results
 */
export async function enrichVideo(initialMp4Path: string, item: MediaItem): Promise<VideoEnrichmentResult> {
  let mp4Path = initialMp4Path;
  const result: VideoEnrichmentResult = {};
  const startTime = Date.now();

  // Step 0: Resolve yt-dlp metadata + rename MP4 to {channel}-{title} format
  // BEFORE the long transcribe step. Mirrors the podcast worker's convention
  // (creator-prefixed) and avoids the file showing up under the Karakeep-
  // derived name for ~15 min while transcription runs. Pays a ~2-3s yt-dlp
  // latency cost up front. Best-effort: any failure keeps the original path.
  const ytMeta = await fetchYouTubeMetadata(item.url);
  const earlyBase = buildVideoBaseName(ytMeta?.channel, item.title || ytMeta?.title);
  if (earlyBase) {
    const dir = path.dirname(mp4Path);
    const newMp4Path = path.join(dir, `${earlyBase}.mp4`);
    if (newMp4Path !== mp4Path) {
      try {
        await rename(mp4Path, newMp4Path);
        result.filePath = newMp4Path;
        mp4Path = newMp4Path;
        console.log(`Renamed video to channel-prefixed filename: ${path.basename(newMp4Path)}`);
      } catch (err) {
        console.warn(`Channel-prefix rename failed (keeping original):`, err instanceof Error ? err.message : err);
      }
    }
  }

  // Skip transcription for very long videos. Gate on audio DURATION (the real
  // driver of ASR cost), not mp4 size: a short high-bitrate clip should still
  // get a transcript, while a multi-hour talk can be skipped. ffprobe the local
  // file so this works for any source, not just YouTube. Unknown duration (null)
  // fails open. sizeMB is kept for the Discord display field below.
  const { statSync } = await import('node:fs');
  const stats = statSync(mp4Path);
  const sizeMB = stats.size / (1024 * 1024);
  const durationMin = await probeDurationMinutes(mp4Path);

  if (durationMin !== null && durationMin > env.MAX_VIDEO_TRANSCRIBE_MINUTES) {
    console.log(`Skipping transcription for ${mp4Path} (${Math.round(durationMin)}min > ${env.MAX_VIDEO_TRANSCRIBE_MINUTES}min limit)`);
    // Still write basic metadata even without transcript
    result.metadataWritten = await enrichVideoFile(mp4Path, {
      title: item.title || undefined,
      custom: {
        doc_type: 'video',
        source_url: item.url,
        bookmarked_at: item.bookmarkedAt || '',
      },
    });
    return result;
  }

  console.log(`Enriching video: ${mp4Path} (${Math.round(sizeMB)}MB)`);

  // Persist identifying metadata to the MP4 BEFORE the long transcription step,
  // which can fail outright (e.g. the primary ASR host going down mid-job). If
  // it does and we never reach the step-4 metadata write, the file is left with
  // no embedded source_url/title — and a later re-enrich (files.ts) then can't
  // recover them: it falls back to a `file://` URL and a "Video Transcript"
  // placeholder title (exactly the bug this guards against). Best-effort.
  try {
    await enrichVideoFile(mp4Path, {
      title: item.title || ytMeta?.title || undefined,
      custom: {
        doc_type: 'video',
        source_url: item.url,
        bookmarked_at: item.bookmarkedAt || '',
        ...(ytMeta?.channel ? { channel: ytMeta.channel } : {}),
        ...(ytMeta?.uploadDate ? { upload_date: ytMeta.uploadDate } : {}),
      },
    });
  } catch (err) {
    console.warn('Early MP4 metadata write failed (non-fatal):', err instanceof Error ? err.message : err);
  }

  let audioPath: string | undefined;
  try {
    // Step 1: Extract audio
    console.log('Extracting audio from video...');
    audioPath = await extractAudio(mp4Path);
    console.log(`Audio extracted: ${audioPath}`);

    // Step 2: Transcribe with Parakeet (text + VTT)
    const videoTitle = item.title || path.basename(mp4Path, '.mp4');
    await sendDiscordNotification({
      type: 'info',
      title: '🎬 Parakeet: transcribing video',
      description: videoTitle,
      fields: [
        { name: 'Size', value: `${Math.round(sizeMB)} MB`, inline: true },
      ],
    });

    console.log('Transcribing video audio with Parakeet...');
    const transcribeStart = Date.now();
    const { text, vtt } = await transcribeForVideo(audioPath);
    result.transcriptLength = text.length;
    const transcribeElapsed = Math.round((Date.now() - transcribeStart) / 1000);
    console.log(`Transcription complete: ${text.length} chars in ${transcribeElapsed}s`);

    await sendDiscordNotification({
      type: 'success',
      title: '🎬 Parakeet: done',
      description: videoTitle,
      fields: [
        { name: 'Time', value: `${transcribeElapsed}s`, inline: true },
        { name: 'Chars', value: text.length.toLocaleString(), inline: true },
      ],
    });

    // Step 2.5: Format transcript with LLM (proper-noun correction from title).
    // MUST run BEFORE enrichment: the summary/tags are otherwise generated from
    // raw ASR text and bake phonetic misspellings ("Jan Lakun" for Yann LeCun,
    // "jeppa" for JEPA) into the Info Dict even though the PDF body gets the
    // corrected text. Same order as the podcast path (podcast-worker.ts).
    let formattedTranscript = text;
    const hasTitle = !!(item.title);
    if (hasTitle) {
      await sendDiscordNotification({
        type: 'info',
        title: '🧠 Gemma4: formatting video transcript',
        description: videoTitle,
        fields: [
          { name: 'Chunks', value: `~${Math.ceil(text.length / 15000)}`, inline: true },
          { name: 'Input', value: `${text.length.toLocaleString()} chars`, inline: true },
        ],
      });
    }

    const formatStart = Date.now();
    try {
      formattedTranscript = await formatTranscriptWithLLM(text, {
        episodeTitle: item.title || undefined,
      });
      const formatElapsed = Math.round((Date.now() - formatStart) / 1000);
      console.log(`Transcript formatted: ${text.length} -> ${formattedTranscript.length} chars in ${formatElapsed}s`);

      if (hasTitle) {
        await sendDiscordNotification({
          type: 'success',
          title: '🧠 Gemma4: done',
          description: videoTitle,
          fields: [
            { name: 'Time', value: `${formatElapsed}s`, inline: true },
            { name: 'Output', value: `${formattedTranscript.length.toLocaleString()} chars`, inline: true },
          ],
        });
      }
    } catch (err) {
      console.warn('Transcript formatting failed, using raw text:', err instanceof Error ? err.message : err);
    }

    // Step 3: AI enrichment (summary + tags from the FORMATTED transcript)
    let summary: string | undefined;
    let tags: string[] | undefined;
    let enrichedAuthor: string | undefined;
    let enrichedPublication: string | undefined;
    let enrichedLanguage: string | undefined;
    try {
      const enriched = await enrichDocumentMetadata(
        formattedTranscript.slice(0, 8000),
        item.url,
        item.title
      );
      summary = enriched.summary;
      tags = enriched.tags;
      enrichedAuthor = enriched.author || undefined;
      enrichedPublication = enriched.publication || undefined;
      enrichedLanguage = enriched.language || undefined;
      result.summary = summary;
      result.tags = tags;
    } catch (err) {
      console.warn('Video AI enrichment failed:', err instanceof Error ? err.message : err);
    }

    // Resolve the canonical creator + publisher once, reused for the MP4 tags
    // and the transcript PDF so both carry consistent values.
    //   creator     = who made it (channel, else the enriched author)
    //   publisher   = where it was distributed (the channel/show/account) —
    //                 NEVER the subject. The LLM's enrichedPublication is derived
    //                 from transcript *content*, so it latches onto the topic
    //                 ("NVIDIA" for a CNET keynote recap); prefer the structural
    //                 channel. For X (no yt-dlp channel) the publisher is the
    //                 posting account (≈ the enriched author), not the platform
    //                 "X" the LLM returns. enrichedPublication is the last resort
    //                 (e.g. re-enriched org talks: publisher "Y Combinator").
    const creator = ytMeta?.channel || enrichedAuthor;
    const publisher =
      ytMeta?.channel ||
      (isTwitterUrl(item.url) ? enrichedAuthor : undefined) ||
      enrichedPublication;

    // Step 4: Embed VTT subtitles + metadata into MP4 (ytMeta resolved up-front).
    // artist/album are STANDARD MP4 tags that survive the muxer (unlike the
    // `custom` keys, which MP4 silently drops), so creator/publisher persist.
    const commentParts: string[] = [];
    if (summary) commentParts.push(summary);
    if (tags && tags.length > 0) commentParts.push(`Tags: ${tags.join(', ')}`);
    commentParts.push(`Transcript: ${text.length.toLocaleString()} chars`);
    commentParts.push(`Source: ${item.url}`);

    result.metadataWritten = await enrichVideoFile(mp4Path, {
      title: item.title || undefined,
      artist: creator,
      album: publisher,
      comment: commentParts.join('\n'),
      custom: {
        doc_type: 'video',
        summary: summary || '',
        tags: (tags || []).join(', '),
        source_url: item.url,
        bookmarked_at: item.bookmarkedAt || '',
        transcript_chars: String(text.length),
        ...(ytMeta?.channel ? { channel: ytMeta.channel } : {}),
        ...(ytMeta?.uploadDate ? { upload_date: ytMeta.uploadDate } : {}),
        ...(ytMeta?.description ? { yt_description: ytMeta.description.slice(0, 4000) } : {}),
      },
    }, vtt);

    result.vttEmbedded = result.metadataWritten;

    // Step 5: Generate transcript PDF alongside the video (Karpathy-compliant metadata)
    const transcriptPdfPath = mp4Path.replace(/\.mp4$/i, '.transcript.pdf');
    const pdfBuffer = await generateTranscriptPdf({
      title: item.title || ytMeta?.title || deriveTitleFromFilename(mp4Path),
      sourceUrl: item.url,
      date: ytMeta?.uploadDate || item.bookmarkedAt,
      summary,
      tags,
      author: creator,
      publication: publisher,
      language: enrichedLanguage,
      channel: ytMeta?.channel,
      channelUrl: ytMeta?.channelUrl,
      uploadDate: ytMeta?.uploadDate,
      description: ytMeta?.description,
      thumbnail: ytMeta?.thumbnail,
      transcriptText: formattedTranscript,
    });
    await writeFile(transcriptPdfPath, pdfBuffer);
    result.transcriptPath = transcriptPdfPath;
    console.log(`Transcript PDF saved: ${transcriptPdfPath} (${pdfBuffer.length} bytes)`);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`Video enrichment complete in ${elapsed}s: ${mp4Path}`);

  } catch (error) {
    console.error(`Video enrichment failed for ${mp4Path}:`, error instanceof Error ? error.message : error);
  } finally {
    // Clean up temp audio
    if (audioPath) {
      try { await unlink(audioPath); } catch { /* ignore */ }
    }
  }

  return result;
}
