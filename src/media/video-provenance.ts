/**
 * Accept-or-reject gate for a freshly downloaded video, plus the provenance
 * stamp that makes the file self-describing before anything else touches it.
 *
 * Why this exists: on 2026-09-05 the coverage audit found 21 MP4s in the
 * library that ffprobe could not open — truncated downloads (mostly a few
 * hundred KB) fetched from Karakeep's asset endpoint while Karakeep's own
 * yt-dlp was still writing the file. The download "succeeded" (HTTP 200,
 * bytes on disk), enrichment then failed on the unreadable file, and the
 * junk shipped to the KB with no source URL at all. Nothing was ever written
 * to the file that could identify it.
 *
 * Two rules, applied by the collection worker right after download and
 * before dedup/compress/enrich:
 *   1. A video that ffprobe can't read, that has no video stream, or that has
 *      no duration is NOT a download — it is deleted and the job fails so
 *      BullMQ's backoff retries once the upstream file is complete.
 *   2. A valid video is stamped with source_url / bookmarked_at / doc_type
 *      immediately. Every later step preserves tags, so the file can never
 *      again reach the library without its source.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlink } from 'node:fs/promises';
import { writeVideoMetadata } from '../metadata/video-tags.js';
import type { MediaItem } from './types.js';

const execFileAsync = promisify(execFile);

export interface ProbeSummary {
  streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  format?: { duration?: string | number; tags?: Record<string, string> };
}

export type VideoValidity =
  | { ok: true; durationSec: number; hasAudio: boolean }
  | { ok: false; reason: 'unreadable' | 'no_video_stream' | 'no_duration' };

/** Pure decision over ffprobe's JSON so it can be unit-tested without ffmpeg. */
export function judgeProbe(probe: ProbeSummary | null): VideoValidity {
  if (!probe || !probe.streams) return { ok: false, reason: 'unreadable' };
  const hasVideo = probe.streams.some((s) => s.codec_type === 'video');
  if (!hasVideo) return { ok: false, reason: 'no_video_stream' };
  const durationSec = Number(probe.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { ok: false, reason: 'no_duration' };
  return { ok: true, durationSec, hasAudio: probe.streams.some((s) => s.codec_type === 'audio') };
}

export async function probeVideo(filePath: string): Promise<ProbeSummary | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height:format=duration:format_tags=source_url',
      '-of', 'json',
      filePath,
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout) as ProbeSummary;
  } catch {
    return null;
  }
}

/**
 * Validate the file at `filePath` and stamp provenance. Returns the validity
 * verdict; on a reject the file is already gone. A stamp failure on a valid
 * file is reported as `stamped: false` so the caller can decide (the worker
 * treats it as a failed download — a tagless file is not acceptable).
 */
export async function finalizeVideoDownload(
  filePath: string,
  item: Pick<MediaItem, 'url' | 'bookmarkedAt'>
): Promise<VideoValidity & { stamped?: boolean }> {
  const verdict = judgeProbe(await probeVideo(filePath));
  if (!verdict.ok) {
    await unlink(filePath).catch(() => { /* already gone */ });
    console.warn(JSON.stringify({
      event: 'video_download_rejected',
      filePath,
      reason: verdict.reason,
      url: item.url,
      timestamp: new Date().toISOString(),
    }));
    return verdict;
  }
  const stamped = await writeVideoMetadata(filePath, {
    custom: {
      source_url: item.url,
      bookmarked_at: item.bookmarkedAt || '',
      doc_type: 'video',
    },
  });
  return { ...verdict, stamped };
}

/** Does the file carry a source_url tag? (null = unreadable) */
export async function hasSourceUrl(filePath: string): Promise<boolean | null> {
  const probe = await probeVideo(filePath);
  if (!probe) return null;
  return Boolean(probe.format?.tags?.source_url);
}
