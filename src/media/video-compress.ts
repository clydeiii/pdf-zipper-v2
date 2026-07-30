/**
 * Post-download video compression
 *
 * All videos land here via Karakeep assets (its yt-dlp download), but sources
 * differ wildly in bitrate: YouTube serves well-compressed streams (~1-2.5 Mbps),
 * while X/Twitter's top H.264 variant is ~2-3x fatter for the same resolution.
 * This step re-encodes only when a file's bitrate is clearly above what a
 * YouTube grab of the same resolution would be, bringing X clips in line
 * without touching already-lean files.
 *
 * Runs BEFORE video enrichment so metadata/VTT embedding happens on the final
 * file. Gating by bitrate makes it idempotent: a compressed file falls below
 * the threshold and is skipped on re-enrich.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rename, unlink, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { env } from '../config/env.js';

const execFileAsync = promisify(execFile);

/**
 * Never re-encode files already below this overall bitrate, regardless of
 * resolution — the savings aren't worth the generation loss + CPU.
 */
const MIN_COMPRESS_KBPS_FLOOR = 1200;

/** Keep the re-encode only if it's meaningfully smaller than the original. */
const KEEP_RATIO = 0.9;

export interface VideoProbe {
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
}

export interface CompressDecision {
  compress: boolean;
  reason: string;
  kbps?: number;
  thresholdKbps?: number;
  /** Exact output dimensions when downscaling (short side capped at maxHeight). */
  targetWidth?: number;
  targetHeight?: number;
  /** Output frame rate when the source exceeds maxFps. */
  targetFps?: number;
}

export interface CompressOptions {
  enabled: boolean;
  /** Bitrate allowance per megapixel of frame area (YouTube-like ceiling). */
  kbpsPerMegapixel: number;
  /** Cap on the SHORTER frame side (portrait-safe "720p" semantics). */
  maxHeight: number;
  /** Cap on frame rate; sources above this are resampled down to it. */
  maxFps: number;
}

/**
 * Decide whether a video justifies re-encoding. Calibrated against real
 * on-disk data (2026-W26): Karakeep's yt-dlp grabs YouTube at 360p /
 * ~160-500 kbps, while X's variants arrive anywhere from 576p up to 4K
 * (a 36-min 4K X clip weighed 2.7 GB). Two triggers:
 *
 * 1. Oversize: shorter frame side > maxHeight (default 720) → downscale +
 *    re-encode. Short side (not height) so portrait phone video isn't
 *    crushed to 405px wide.
 * 2. Fat bitrate at ≤maxHeight: kbps > max(floor, kbpsPerMegapixel × frame
 *    megapixels). The 1200 kbps floor keeps every observed YouTube grab
 *    (≤500 kbps) and lean small X clips untouched.
 * 3. High frame rate: fps > maxFps (default 30) → resample. Also applied
 *    opportunistically whenever a re-encode fires for reasons 1-2.
 *
 * Missing probe data fails open — keep the original untouched (a null fps
 * only disables the fps cap, not the other triggers).
 */
export function shouldCompressVideo(probe: VideoProbe, opts: CompressOptions): CompressDecision {
  if (!opts.enabled) {
    return { compress: false, reason: 'disabled' };
  }
  if (!probe.durationSec || probe.durationSec < 1) {
    return { compress: false, reason: 'unknown_duration' };
  }
  if (!probe.width || !probe.height) {
    return { compress: false, reason: 'unknown_dimensions' };
  }

  const kbps = Math.round((probe.sizeBytes * 8) / probe.durationSec / 1000);
  const shortSide = Math.min(probe.width, probe.height);
  // +0.5 tolerance so NTSC 29.97 (and encoder jitter around exactly 30)
  // never triggers a resample against a maxFps of 30.
  const targetFps =
    probe.fps && probe.fps > opts.maxFps + 0.5 ? opts.maxFps : undefined;

  if (shortSide > opts.maxHeight) {
    // Scale so the short side lands on maxHeight; x264 needs even dimensions.
    const factor = opts.maxHeight / shortSide;
    const even = (n: number) => Math.max(2, Math.round((n * factor) / 2) * 2);
    return {
      compress: true,
      reason: 'oversize',
      kbps,
      targetWidth: even(probe.width),
      targetHeight: even(probe.height),
      targetFps,
    };
  }

  const megapixels = (probe.width * probe.height) / 1_000_000;
  const thresholdKbps = Math.round(
    Math.max(MIN_COMPRESS_KBPS_FLOOR, opts.kbpsPerMegapixel * megapixels)
  );

  if (kbps > thresholdKbps) {
    return { compress: true, reason: 'bitrate_high', kbps, thresholdKbps, targetFps };
  }
  if (targetFps) {
    return { compress: true, reason: 'high_fps', kbps, thresholdKbps, targetFps };
  }
  return { compress: false, reason: 'bitrate_ok', kbps, thresholdKbps };
}

/** Probe duration + dimensions via ffprobe. Nulls on failure (fail open). */
async function probeVideo(filePath: string): Promise<VideoProbe> {
  const sizeBytes = (await stat(filePath)).size;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ], { timeout: 30000 });
    const parsed = JSON.parse(String(stdout));
    const stream = parsed.streams?.[0] ?? {};
    const durationSec = parseFloat(parsed.format?.duration);
    return {
      sizeBytes,
      durationSec: Number.isFinite(durationSec) ? durationSec : null,
      width: Number.isFinite(stream.width) ? stream.width : null,
      height: Number.isFinite(stream.height) ? stream.height : null,
      fps: parseFrameRate(stream.avg_frame_rate),
    };
  } catch {
    return { sizeBytes, durationSec: null, width: null, height: null, fps: null };
  }
}

/** ffprobe reports frame rate as a rational string ("30000/1001", "25/1"). */
function parseFrameRate(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const [num, den] = raw.split('/').map(Number);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den <= 0) return null;
  return num / den;
}

export interface CompressResult {
  compressed: boolean;
  reason: string;
  originalSizeBytes: number;
  newSizeBytes?: number;
}

/**
 * Re-encode an MP4 in place (same path) if its bitrate is above the
 * resolution-scaled threshold. Keeps the original when the re-encode isn't
 * meaningfully smaller. Never throws — a failure keeps the original file.
 */
export async function maybeCompressVideo(filePath: string): Promise<CompressResult> {
  const probe = await probeVideo(filePath);
  const decision = shouldCompressVideo(probe, {
    enabled: env.VIDEO_COMPRESS_ENABLED,
    kbpsPerMegapixel: env.VIDEO_COMPRESS_KBPS_PER_MEGAPIXEL,
    maxHeight: env.VIDEO_COMPRESS_MAX_HEIGHT,
    maxFps: env.VIDEO_COMPRESS_MAX_FPS,
  });

  if (!decision.compress) {
    if (decision.reason !== 'disabled') {
      console.log(JSON.stringify({
        event: 'video_compress_skipped',
        filePath,
        reason: decision.reason,
        kbps: decision.kbps,
        thresholdKbps: decision.thresholdKbps,
        timestamp: new Date().toISOString(),
      }));
    }
    return { compressed: false, reason: decision.reason, originalSizeBytes: probe.sizeBytes };
  }

  // Temp output in the same directory so the final rename is atomic (the
  // weekly bin lives on a Docker volume; /tmp may be a different filesystem).
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath, '.mp4')}.compress-tmp.mp4`
  );

  const args = [
    '-i', filePath,
    '-map', '0',
    '-dn',
    '-map_metadata', '0',
    '-c', 'copy',
    '-c:v', 'libx264',
    '-crf', String(env.VIDEO_COMPRESS_CRF),
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
  ];
  const filters: string[] = [];
  if (decision.targetWidth && decision.targetHeight) {
    filters.push(`scale=${decision.targetWidth}:${decision.targetHeight}`);
  }
  if (decision.targetFps) {
    filters.push(`fps=${decision.targetFps}`);
  }
  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }
  args.push('-movflags', '+faststart+use_metadata_tags', '-y', tmpPath);

  const startTime = Date.now();
  try {
    // Allow ~3x realtime on slow CPUs, floored at 15 minutes. Math.ceil is
    // load-bearing: ffprobe durations are floats, and execFile REJECTS a
    // non-integer timeout — which made every needs-compression video longer
    // than 5 minutes (duration*3000 > the integer floor) fail instantly and
    // silently keep its original file.
    const timeout = Math.max(15 * 60_000, Math.ceil((probe.durationSec ?? 0) * 3000));
    await execFileAsync('ffmpeg', args, { timeout });

    const newSize = (await stat(tmpPath)).size;
    if (newSize === 0 || newSize >= probe.sizeBytes * KEEP_RATIO) {
      await unlink(tmpPath);
      console.log(JSON.stringify({
        event: 'video_compress_skipped',
        filePath,
        reason: 'not_smaller',
        originalSizeBytes: probe.sizeBytes,
        reencodedSizeBytes: newSize,
        timestamp: new Date().toISOString(),
      }));
      return { compressed: false, reason: 'not_smaller', originalSizeBytes: probe.sizeBytes };
    }

    await rename(tmpPath, filePath);
    console.log(JSON.stringify({
      event: 'video_compressed',
      filePath,
      reason: decision.reason,
      originalSizeBytes: probe.sizeBytes,
      newSizeBytes: newSize,
      savedPercent: Math.round((1 - newSize / probe.sizeBytes) * 100),
      kbps: decision.kbps,
      thresholdKbps: decision.thresholdKbps,
      downscaledTo: decision.targetWidth ? `${decision.targetWidth}x${decision.targetHeight}` : undefined,
      resampledFps: decision.targetFps,
      elapsedSec: Math.round((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    }));
    return { compressed: true, reason: decision.reason, originalSizeBytes: probe.sizeBytes, newSizeBytes: newSize };
  } catch (error) {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    console.warn(
      `Video compression failed (keeping original) for ${filePath}:`,
      error instanceof Error ? error.message : error
    );
    return { compressed: false, reason: 'encode_failed', originalSizeBytes: probe.sizeBytes };
  }
}
