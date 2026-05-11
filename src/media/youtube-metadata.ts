/**
 * YouTube/Vimeo metadata extraction via yt-dlp --dump-json.
 *
 * Karakeep already downloaded the video file; this fetches the human-facing
 * fields (channel, upload date, description) that aren't in the feed enclosure
 * so they can be embedded in the transcript PDF + MP4 metadata.
 *
 * Best-effort: returns null on any failure. yt-dlp throttles/breaks regularly
 * against YouTube — never block the enrichment pipeline on it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { env } from '../config/env.js';

const execFileAsync = promisify(execFile);

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const YT_DLP_TIMEOUT_MS = 30_000;

export interface YouTubeMetadata {
  channel?: string;
  channelUrl?: string;
  uploadDate?: string;       // ISO 8601 (converted from yt-dlp's YYYYMMDD)
  description?: string;
  title?: string;
  durationSeconds?: number;
  viewCount?: number;
  thumbnail?: string;
}

/**
 * Check whether a URL is supported by this extractor.
 * yt-dlp supports many sites, but we only call it for the ones we know
 * deliver useful uploader metadata (YouTube, Vimeo).
 */
export function isYouTubeOrVimeoUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be' ||
      host === 'vimeo.com' ||
      host.endsWith('.vimeo.com')
    );
  } catch {
    return false;
  }
}

/**
 * Convert yt-dlp's YYYYMMDD upload_date to ISO date (YYYY-MM-DD).
 */
function normalizeUploadDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Pick the best thumbnail URL we can actually embed in a PDF.
 *
 * pdf-lib's StandardFonts path only supports PNG and JPEG — `.webp`/`.avif`
 * (which YouTube increasingly serves) won't embed. We prefer the top-level
 * `thumbnail` field when it's already JPG/PNG, otherwise walk `thumbnails[]`
 * for the largest embeddable variant by pixel area.
 */
function pickEmbeddableThumbnail(json: any): string | undefined {
  const isWebp = (url: string): boolean => /\.webp(\?|$)/i.test(url) || /\/vi_webp\//i.test(url);
  const isJpeg = (url: string): boolean => /\.(jpe?g)(\?|$)/i.test(url);
  const isPng = (url: string): boolean => /\.png(\?|$)/i.test(url);
  const isEmbeddable = (url: string): boolean => !isWebp(url) && (isJpeg(url) || isPng(url));

  if (typeof json.thumbnail === 'string' && isEmbeddable(json.thumbnail)) {
    return json.thumbnail;
  }

  if (Array.isArray(json.thumbnails)) {
    let best: { url: string; area: number } | undefined;
    for (const t of json.thumbnails) {
      if (!t || typeof t.url !== 'string' || !isEmbeddable(t.url)) continue;
      const w = typeof t.width === 'number' ? t.width : 0;
      const h = typeof t.height === 'number' ? t.height : 0;
      const area = w * h;
      if (!best || area > best.area) best = { url: t.url, area };
    }
    if (best) return best.url;
  }

  return undefined;
}

/**
 * Run yt-dlp --dump-json against a URL and return parsed metadata, or null
 * on any failure. Optionally pass a cookies file for authenticated requests.
 */
async function runYtDlp(url: string, cookiesFile?: string): Promise<YouTubeMetadata | null> {
  const args = [
    '--dump-json',
    '--skip-download',
    '--no-warnings',
    '--no-playlist',
    // Format-validation fallback. yt-dlp errors out with "Requested format is
    // not available" when YouTube returns only storyboard formats (bot-detect
    // / restricted videos). Pinning a guaranteed-present format lets the JSON
    // extraction succeed even when no real streams are exposed. --skip-download
    // means nothing is actually fetched.
    '-f', 'mhtml/bestaudio/best',
  ];
  if (cookiesFile) args.push('--cookies', cookiesFile);
  args.push(url);

  try {
    const { stdout } = await execFileAsync(YT_DLP_PATH, args, {
      timeout: YT_DLP_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const json = JSON.parse(stdout);
    return {
      channel: typeof json.channel === 'string' ? json.channel : (typeof json.uploader === 'string' ? json.uploader : undefined),
      channelUrl: typeof json.channel_url === 'string' ? json.channel_url : (typeof json.uploader_url === 'string' ? json.uploader_url : undefined),
      uploadDate: normalizeUploadDate(json.upload_date),
      description: typeof json.description === 'string' ? json.description : undefined,
      title: typeof json.title === 'string' ? json.title : undefined,
      durationSeconds: typeof json.duration === 'number' ? json.duration : undefined,
      viewCount: typeof json.view_count === 'number' ? json.view_count : undefined,
      thumbnail: pickEmbeddableThumbnail(json),
    };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'yt_dlp_metadata_failed',
      url,
      cookies: cookiesFile ? 'used' : 'none',
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      timestamp: new Date().toISOString(),
    }));
    return null;
  }
}

/**
 * Fetch metadata for a YouTube/Vimeo URL via yt-dlp.
 *
 * Strategy: try anonymously first (default cookies.txt is for the personal
 * Google account, which triggered bot-detection — anonymous works for most
 * public videos). If that fails AND a dedicated YT_DLP_COOKIES_FILE is
 * configured (work account), retry with that file for age-gated / member-
 * only cases.
 *
 * Returns null if extraction fails (network, auth, rate limit). Pipeline
 * treats null as "no enrichment" and continues — never fatal.
 */
export async function fetchYouTubeMetadata(url: string): Promise<YouTubeMetadata | null> {
  if (!isYouTubeOrVimeoUrl(url)) return null;

  const meta = await runYtDlp(url);
  if (meta) {
    console.log(JSON.stringify({
      event: 'yt_dlp_metadata_fetched',
      url,
      cookies: 'none',
      channel: meta.channel,
      uploadDate: meta.uploadDate,
      descriptionLength: meta.description?.length ?? 0,
      thumbnail: meta.thumbnail,
      timestamp: new Date().toISOString(),
    }));
    return meta;
  }

  const cookies = env.YT_DLP_COOKIES_FILE;
  if (cookies && existsSync(cookies)) {
    console.log(JSON.stringify({
      event: 'yt_dlp_metadata_retry_with_cookies',
      url,
      cookiesFile: cookies,
      timestamp: new Date().toISOString(),
    }));
    const authed = await runYtDlp(url, cookies);
    if (authed) {
      console.log(JSON.stringify({
        event: 'yt_dlp_metadata_fetched',
        url,
        cookies: 'fallback',
        channel: authed.channel,
        uploadDate: authed.uploadDate,
        descriptionLength: authed.description?.length ?? 0,
        thumbnail: authed.thumbnail,
        timestamp: new Date().toISOString(),
      }));
      return authed;
    }
  }

  return null;
}
