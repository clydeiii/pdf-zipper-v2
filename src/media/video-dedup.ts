/**
 * Duplicate-video detection for the media collection pipeline.
 *
 * The same underlying video arrives multiple times when the user bookmarks
 * both an original tweet and a quote-tweet of it (X serves the SAME embedded
 * video for both, and Karakeep dutifully downloads it for each bookmark).
 * Observed 2026-07-02: one 33-min 4K video stored twice (2×2.0GB) under two
 * different account filenames.
 *
 * Design constraint: NO state beyond the files already on disk. Identity is
 * derived by probing the library at download time:
 *
 *   candidate match = duration within 50ms          (survives re-encode)
 *                   + aspect ratio within 1%        (survives downscale)
 *                   + same has-audio bit
 *   confirmed by    = perceptual frame hash          (8x8 grayscale frame
 *                     sampled at the same timestamp, hamming distance ≤ 12/64)
 *
 * On a confirmed duplicate the caller keeps the EXISTING file as canonical,
 * appends the new bookmark's URL to its `also_bookmarked_as` metadata tag,
 * and deletes the fresh download — no second copy, no second re-encode, and
 * the tweet↔video linkage lands INSIDE the canonical mp4 (Karpathy KB rule:
 * files self-describe, no sidecars). The quote-tweet's own PDF capture keeps
 * the quote relationship from the other direction.
 *
 * Fails open: any probe/hash error means "not a duplicate" — worst case we
 * store a redundant copy, never lose a capture.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { env } from '../config/env.js';
import { enrichVideoFile } from '../metadata/video-tags.js';

const execFileAsync = promisify(execFile);

const DURATION_TOLERANCE_MS = 50;
const ASPECT_TOLERANCE = 0.01;
const FRAME_HASH_MAX_DISTANCE = 12; // of 64 bits
/** Videos shorter than this are too likely to collide on duration alone. */
const MIN_DURATION_MS = 3000;

interface VideoProbe {
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

async function probeVideo(filePath: string): Promise<VideoProbe | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ], { timeout: 30000 });
    const json = JSON.parse(stdout);
    const video = (json.streams || []).find((s: any) => s.codec_type === 'video');
    const durationSec = parseFloat(json.format?.duration);
    if (!video || !Number.isFinite(durationSec)) return null;
    return {
      durationMs: Math.round(durationSec * 1000),
      width: video.width || 0,
      height: video.height || 0,
      hasAudio: (json.streams || []).some((s: any) => s.codec_type === 'audio'),
    };
  } catch {
    return null;
  }
}

/**
 * 64-bit average hash of one frame at `atSec`, as a bigint. ffmpeg decodes
 * the frame, scales to 8x8 grayscale, and we threshold on the mean.
 */
async function frameHash(filePath: string, atSec: number): Promise<bigint | null> {
  try {
    const { stdout } = await execFileAsync('ffmpeg', [
      '-ss', String(atSec),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=8:8',
      '-pix_fmt', 'gray',
      '-f', 'rawvideo',
      '-v', 'error',
      'pipe:1',
    ], { timeout: 60000, encoding: 'buffer' as BufferEncoding, maxBuffer: 1024 * 1024 });
    const pixels = Buffer.from(stdout as unknown as Buffer);
    if (pixels.length < 64) return null;
    let mean = 0;
    for (let i = 0; i < 64; i++) mean += pixels[i];
    mean /= 64;
    let hash = 0n;
    for (let i = 0; i < 64; i++) {
      if (pixels[i] > mean) hash |= 1n << BigInt(i);
    }
    return hash;
  } catch {
    return null;
  }
}

function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) { count += Number(x & 1n); x >>= 1n; }
  return count;
}

/** Walk every media/{week}/videos dir and yield absolute mp4 paths. */
async function listLibraryVideos(excludePath: string): Promise<string[]> {
  const mediaDir = path.join(path.resolve(env.DATA_DIR), 'media');
  const out: string[] = [];
  let weeks: string[] = [];
  try {
    weeks = (await readdir(mediaDir)).filter((n) => /^\d{4}-W\d{2}$/.test(n));
  } catch { return out; }
  for (const week of weeks) {
    const dir = path.join(mediaDir, week, 'videos');
    let entries: string[] = [];
    try { entries = await readdir(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.mp4')) continue;
      const full = path.join(dir, entry);
      if (full === excludePath) continue;
      try {
        if ((await stat(full)).isFile()) out.push(full);
      } catch { /* ignore */ }
    }
  }
  return out;
}

export interface DuplicateMatch {
  existingPath: string;
}

/**
 * Find an existing library video with the same content as `newFilePath`.
 * Returns null when no confident match exists (including all error paths).
 */
export async function findDuplicateVideo(newFilePath: string): Promise<DuplicateMatch | null> {
  const newProbe = await probeVideo(newFilePath);
  if (!newProbe || newProbe.durationMs < MIN_DURATION_MS || !newProbe.width || !newProbe.height) {
    return null;
  }
  const newAspect = newProbe.width / newProbe.height;

  const candidates: string[] = [];
  for (const libPath of await listLibraryVideos(newFilePath)) {
    const libProbe = await probeVideo(libPath);
    if (!libProbe || !libProbe.width || !libProbe.height) continue;
    if (Math.abs(libProbe.durationMs - newProbe.durationMs) > DURATION_TOLERANCE_MS) continue;
    const libAspect = libProbe.width / libProbe.height;
    if (Math.abs(libAspect - newAspect) / newAspect > ASPECT_TOLERANCE) continue;
    if (libProbe.hasAudio !== newProbe.hasAudio) continue;
    candidates.push(libPath);
  }
  if (candidates.length === 0) return null;

  // Confirm with a perceptual frame comparison at a shared timestamp.
  const sampleAt = Math.min(5, (newProbe.durationMs / 1000) / 2);
  const newHash = await frameHash(newFilePath, sampleAt);
  if (newHash === null) return null;

  for (const candidate of candidates) {
    const candidateHash = await frameHash(candidate, sampleAt);
    if (candidateHash === null) continue;
    if (hammingDistance(newHash, candidateHash) <= FRAME_HASH_MAX_DISTANCE) {
      return { existingPath: candidate };
    }
  }
  return null;
}

/**
 * Record a second bookmark of the same video on the canonical file:
 * append `url` to the `also_bookmarked_as` tag (deduped, `; `-separated).
 */
export async function appendVideoCrossRef(canonicalPath: string, url: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format_tags=also_bookmarked_as,source_url',
      '-of', 'json',
      canonicalPath,
    ], { timeout: 30000 });
    const tags = (JSON.parse(stdout).format?.tags ?? {}) as Record<string, string>;
    const existing = (tags.also_bookmarked_as || '').split(';').map((s) => s.trim()).filter(Boolean);
    if (existing.includes(url) || tags.source_url === url) return true; // already recorded
    existing.push(url);
    return await enrichVideoFile(canonicalPath, {
      custom: { also_bookmarked_as: existing.join('; ') },
    });
  } catch (err) {
    console.warn(`[video-dedup] cross-ref append failed for ${canonicalPath}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Delete a confirmed-duplicate download. Best-effort. */
export async function removeDuplicateDownload(filePath: string): Promise<void> {
  try { await unlink(filePath); } catch { /* ignore */ }
}
