/**
 * Patreon post video capture.
 *
 * Patreon posts carry member-only video, and unlike every other video source
 * here the bytes don't arrive via Karakeep: Karakeep has no Patreon session, so
 * it files these as plain `link` bookmarks with no video asset (verified across
 * four real bookmarks — screenshot/bannerImage/linkHtmlContent only). Left
 * alone they'd get a PDF capture and the video would be lost.
 *
 * There's also no mp4 to scrape. The video is served from Mux as HLS
 * (`rendition.m3u8`) behind short-lived signed URLs, so it has to be muxed from
 * segments at capture time — which is exactly what yt-dlp does, using the
 * personal cookies.txt for auth.
 *
 * The Patreon post still gets its normal PDF capture alongside this, matching
 * how an x.com video bookmark yields both a tweet PDF and an mp4.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { env } from '../config/env.js';

const execFileAsync = promisify(execFile);

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';

/**
 * HLS is muxed segment-by-segment, so a long post can take a while. Integer by
 * construction — execFile REJECTS a non-integer timeout, which is how every
 * long video compression silently failed once already.
 */
const DOWNLOAD_TIMEOUT_MS = 45 * 60_000;

/**
 * True for a Patreon post URL — `patreon.com/<creator>/posts/<slug>-<id>` or
 * the shorter `patreon.com/posts/<slug>-<id>`. Creator pages, the home feed and
 * everything else are left to normal PDF capture.
 */
export function isPatreonPostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'patreon.com') return false;
    return /^\/(?:[^/]+\/)?posts\/[^/]+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export type PatreonDownloadOutcome =
  | { ok: true; filePath: string; sizeBytes: number }
  /** The post exists but carries no video (text/image-only) — not an error. */
  | { ok: false; reason: 'no_video' }
  | { ok: false; reason: 'download_failed'; error: string };

/** yt-dlp's way of saying "this page has nothing downloadable on it". */
function meansNoVideo(output: string): boolean {
  return /No video formats found|Unsupported URL|no media found|There.s no video/i.test(output);
}

/**
 * Download a Patreon post's video to an exact path.
 *
 * Format selection caps the frame height at VIDEO_COMPRESS_MAX_HEIGHT (compose
 * pins 480), so we pull the 480p rendition rather than 1080p and land below the
 * compressor's bitrate floor — no re-encode, and a fraction of the bandwidth.
 * The trailing `/best` keeps an unusual source (e.g. a portrait clip whose only
 * rendition is taller) downloadable rather than failing the cap.
 */
export async function downloadPatreonVideo(
  postUrl: string,
  filePath: string
): Promise<PatreonDownloadOutcome> {
  const maxHeight = env.VIDEO_COMPRESS_MAX_HEIGHT;
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '-f', `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`,
    '--merge-output-format', 'mp4',
    '-o', filePath,
  ];
  if (env.COOKIES_FILE && existsSync(env.COOKIES_FILE)) {
    args.push('--cookies', env.COOKIES_FILE);
  }
  args.push(postUrl);

  try {
    await execFileAsync(YT_DLP_PATH, args, {
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: string }).stderr || '';
    try { if (existsSync(filePath)) await unlink(filePath); } catch { /* ignore */ }
    if (meansNoVideo(`${message}\n${stderr}`)) {
      return { ok: false, reason: 'no_video' };
    }
    return { ok: false, reason: 'download_failed', error: stderr.trim() || message };
  }

  if (!existsSync(filePath)) {
    return { ok: false, reason: 'no_video' };
  }
  const sizeBytes = statSync(filePath).size;
  if (sizeBytes === 0) {
    try { await unlink(filePath); } catch { /* ignore */ }
    return { ok: false, reason: 'download_failed', error: 'yt-dlp produced an empty file' };
  }
  return { ok: true, filePath, sizeBytes };
}
