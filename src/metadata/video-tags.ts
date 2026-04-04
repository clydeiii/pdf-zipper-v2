/**
 * Video file metadata and subtitle embedding via ffmpeg
 *
 * - Writes metadata tags to MP4 files (title, artist, date, comment, etc.)
 * - Embeds WebVTT subtitle tracks into MP4 containers
 * - All operations use ffmpeg via child_process (must be installed in container)
 */

import { execFile } from 'node:child_process';
import { writeFile, unlink, rename } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface VideoMetadataOptions {
  title?: string;
  artist?: string;      // Channel/creator name
  album?: string;       // Show/series name
  date?: string;        // ISO date
  comment?: string;     // Summary
  genre?: string;
  description?: string; // Longer description
  /** Custom key-value metadata pairs */
  custom?: Record<string, string>;
}

/**
 * Write metadata to an MP4 file using ffmpeg
 * Creates a new file with metadata, then replaces the original
 */
export async function writeVideoMetadata(filePath: string, meta: VideoMetadataOptions): Promise<boolean> {
  const tmpPath = filePath + '.meta.tmp.mp4';

  try {
    const args = ['-i', filePath, '-c', 'copy'];

    // Standard metadata fields
    if (meta.title) args.push('-metadata', `title=${meta.title}`);
    if (meta.artist) args.push('-metadata', `artist=${meta.artist}`);
    if (meta.album) args.push('-metadata', `album=${meta.album}`);
    if (meta.date) args.push('-metadata', `date=${meta.date}`);
    if (meta.comment) args.push('-metadata', `comment=${meta.comment}`);
    if (meta.genre) args.push('-metadata', `genre=${meta.genre}`);
    if (meta.description) args.push('-metadata', `description=${meta.description}`);

    // Custom metadata
    if (meta.custom) {
      for (const [key, value] of Object.entries(meta.custom)) {
        if (value) args.push('-metadata', `${key}=${value}`);
      }
    }

    args.push('-y', tmpPath);

    await execFileAsync('ffmpeg', args, { timeout: 60000 });
    await rename(tmpPath, filePath);

    console.log(`Video metadata written to ${filePath}: "${meta.title}"`);
    return true;
  } catch (error) {
    // Clean up temp file on failure
    try { await unlink(tmpPath); } catch { /* ignore */ }
    console.warn(`Failed to write video metadata to ${filePath}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Embed a WebVTT subtitle file into an MP4 container
 * Adds as a subtitle stream (mov_text codec for MP4 compatibility)
 */
export async function embedVttInMp4(mp4Path: string, vttContent: string): Promise<boolean> {
  const vttPath = mp4Path + '.subs.vtt';
  const tmpPath = mp4Path + '.subs.tmp.mp4';

  try {
    // Write VTT to temp file
    await writeFile(vttPath, vttContent);

    // Embed VTT as subtitle track
    const args = [
      '-i', mp4Path,
      '-i', vttPath,
      '-c', 'copy',           // Copy video/audio streams
      '-c:s', 'mov_text',     // Encode subtitles for MP4
      '-metadata:s:s:0', 'language=eng',
      '-metadata:s:s:0', 'title=Transcript',
      '-y', tmpPath,
    ];

    await execFileAsync('ffmpeg', args, { timeout: 120000 });
    await rename(tmpPath, mp4Path);

    // Clean up VTT file
    await unlink(vttPath);

    console.log(`VTT subtitles embedded in ${mp4Path}`);
    return true;
  } catch (error) {
    try { await unlink(vttPath); } catch { /* ignore */ }
    try { await unlink(tmpPath); } catch { /* ignore */ }
    console.warn(`Failed to embed VTT in ${mp4Path}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Write metadata AND embed subtitles in a single ffmpeg pass
 * More efficient than two separate passes
 */
export async function enrichVideoFile(
  mp4Path: string,
  meta: VideoMetadataOptions,
  vttContent?: string
): Promise<boolean> {
  const tmpPath = mp4Path + '.enriched.tmp.mp4';
  let vttPath: string | undefined;

  try {
    const args = ['-i', mp4Path];

    // Add VTT input if provided
    if (vttContent) {
      vttPath = mp4Path + '.subs.vtt';
      await writeFile(vttPath, vttContent);
      args.push('-i', vttPath);
    }

    args.push('-c', 'copy');  // Copy video/audio

    // Subtitle encoding (if VTT provided)
    if (vttContent) {
      args.push('-c:s', 'mov_text');
      args.push('-metadata:s:s:0', 'language=eng');
      args.push('-metadata:s:s:0', 'title=Transcript');
    }

    // Metadata
    if (meta.title) args.push('-metadata', `title=${meta.title}`);
    if (meta.artist) args.push('-metadata', `artist=${meta.artist}`);
    if (meta.album) args.push('-metadata', `album=${meta.album}`);
    if (meta.date) args.push('-metadata', `date=${meta.date}`);
    if (meta.comment) args.push('-metadata', `comment=${meta.comment}`);
    if (meta.genre) args.push('-metadata', `genre=${meta.genre}`);
    if (meta.description) args.push('-metadata', `description=${meta.description}`);
    if (meta.custom) {
      for (const [key, value] of Object.entries(meta.custom)) {
        if (value) args.push('-metadata', `${key}=${value}`);
      }
    }

    args.push('-y', tmpPath);

    // Long timeout for large files (some videos are 30+ GB)
    await execFileAsync('ffmpeg', args, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
    await rename(tmpPath, mp4Path);

    if (vttPath) await unlink(vttPath);

    console.log(`Video enriched: ${mp4Path} (metadata${vttContent ? ' + subtitles' : ''})`);
    return true;
  } catch (error) {
    try { if (vttPath) await unlink(vttPath); } catch { /* ignore */ }
    try { await unlink(tmpPath); } catch { /* ignore */ }
    console.warn(`Failed to enrich video ${mp4Path}:`, error instanceof Error ? error.message : error);
    return false;
  }
}
