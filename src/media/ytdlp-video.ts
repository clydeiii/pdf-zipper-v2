/**
 * Self-download of public-platform video (YouTube/Vimeo) via our own yt-dlp.
 *
 * Normally these arrive as Karakeep video assets, but Karakeep's bundled
 * yt-dlp goes stale between image releases and YouTube's countermeasures move
 * fast — observed 2026-08-18..20: every Karakeep YouTube download failing
 * with "HTTP Error 403: Forbidden" for days, silently dropping bookmarked
 * videos. When the feed poller's asset-wait window expires it now points the
 * enclosure at the watch URL itself with `downloadVia: 'yt-dlp'` (the Patreon
 * pattern) and the collector lands here.
 *
 * Differences from the Patreon downloader:
 * - `--js-runtimes node`: YouTube requires JS-based signature solving as of
 *   2026-08; without a runtime yt-dlp only sees a crippled format list and
 *   the height-capped selector matches nothing. Node is in the container.
 * - Anonymous first, work-account cookies (`YT_DLP_COOKIES_FILE`) only as a
 *   retry when the failure smells like an age/bot gate — never the personal
 *   COOKIES_FILE, and never cookies on the first attempt (the account should
 *   not be associated with routine grabs).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { env } from '../config/env.js';

const execFileAsync = promisify(execFile);

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';

/** Integer by construction — execFile rejects non-integer timeouts. */
const DOWNLOAD_TIMEOUT_MS = 45 * 60_000;

export type YtDlpDownloadOutcome =
  | { ok: true; filePath: string; sizeBytes: number }
  /** The page exists but has nothing downloadable — terminal, not transient. */
  | { ok: false; reason: 'no_video' }
  | { ok: false; reason: 'download_failed'; error: string };

function meansNoVideo(output: string): boolean {
  return /No video formats found|Unsupported URL|no media found|There.s no video|Video unavailable/i.test(output);
}

/** Failures where a signed-in retry has a real chance of succeeding. */
export function looksLikeGatedFailure(output: string): boolean {
  return /Sign in to confirm|confirm your age|age.restricted|not a bot|HTTP Error 403/i.test(output);
}

async function runYtDlp(url: string, filePath: string, withCookies: boolean): Promise<{ ok: true } | { ok: false; output: string }> {
  const maxHeight = env.VIDEO_COMPRESS_MAX_HEIGHT;
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--js-runtimes', 'node',
    '-f', `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`,
    '--merge-output-format', 'mp4',
    '-o', filePath,
  ];
  if (withCookies && env.YT_DLP_COOKIES_FILE && existsSync(env.YT_DLP_COOKIES_FILE)) {
    args.push('--cookies', env.YT_DLP_COOKIES_FILE);
  }
  args.push(url);

  try {
    await execFileAsync(YT_DLP_PATH, args, {
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: string }).stderr || '';
    return { ok: false, output: `${message}\n${stderr}` };
  }
}

/**
 * Download a public video page's media to an exact path, height-capped like
 * every other grab so the compressor's bitrate floor leaves it untouched.
 */
export async function downloadVideoViaYtDlp(
  url: string,
  filePath: string
): Promise<YtDlpDownloadOutcome> {
  let attempt = await runYtDlp(url, filePath, false);

  if (!attempt.ok && looksLikeGatedFailure(attempt.output)
      && env.YT_DLP_COOKIES_FILE && existsSync(env.YT_DLP_COOKIES_FILE)) {
    console.log(JSON.stringify({
      event: 'ytdlp_cookie_retry',
      url,
      timestamp: new Date().toISOString(),
    }));
    try { if (existsSync(filePath)) await unlink(filePath); } catch { /* ignore */ }
    attempt = await runYtDlp(url, filePath, true);
  }

  if (!attempt.ok) {
    try { if (existsSync(filePath)) await unlink(filePath); } catch { /* ignore */ }
    if (meansNoVideo(attempt.output)) {
      return { ok: false, reason: 'no_video' };
    }
    return { ok: false, reason: 'download_failed', error: attempt.output.trim().slice(0, 500) };
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
