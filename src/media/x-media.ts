/**
 * Native x.com video acquisition (PR 2 of "pdf-zipper downloads every video").
 *
 * A tweet's video is fetched by pdf-zipper itself, independently of the PDF
 * capture and of anything Karakeep does. The tiers, in order, and why:
 *
 *   1. yt-dlp, anonymous. Works for ordinary public tweets (verified on three
 *      recent bookmarks in the design review, ~1s each) and returns EVERY
 *      video of a multi-video tweet.
 *   2. The CDN URL the Nitter harvest recorded in twitter.db
 *      (`tweet_media.video_url`, video.twimg.com m3u8/mp4). Bytes we already
 *      located are worth more than another platform extraction, and this tier
 *      needs no account at all. Only available once the tweet's PDF capture
 *      has run the harvest — on a first attempt that may not be yet, which
 *      is fine: the queue's backoff comes back later.
 *   3. yt-dlp with the X-SCOPED subset of the personal cookie jar
 *      (src/media/x-cookies.ts) — for login-gated/NSFW tweets. Last because it
 *      spends the user's session, and because NSFW tweets are reported to fail
 *      even with cookies in 2026.
 *
 * Outcomes are the structured ones from ytdlp-video.ts; "no_media" only ever
 * comes from yt-dlp's explicit "There's no video in this tweet".
 */

import { existsSync } from 'node:fs';
import { env } from '../config/env.js';
import { downloadWithYtDlp, type YtDlpDownloadOutcome, type YtDlpRunOptions } from './ytdlp-video.js';
import { getXScopedCookiesFile } from './x-cookies.js';

/** x.com / twitter.com status URL (a tweet), any spelling. */
export function isTweetStatusUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|mobile|m)\./, '');
    return (host === 'x.com' || host === 'twitter.com') && /\/status\/\d+/.test(u.pathname);
  } catch {
    return false;
  }
}

export function tweetIdOf(url: string): string | null {
  return /\/status\/(\d+)/.exec(url)?.[1] ?? null;
}

/** Acquisition deadline for a tweet: clips are short; a stuck extraction must not hold a slot for 45 min. */
export const TWEET_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/**
 * Harvested CDN URLs for the tweet's own videos/GIFs, in attachment order,
 * from twitter.db. Empty when the DB is disabled, absent, or the tweet was
 * not harvested yet. Lazy import: the collection worker must not open the
 * SQLite file unless it needs it.
 */
export async function harvestedVideoUrls(tweetUrl: string): Promise<string[]> {
  if (!env.TWITTER_DB_ENABLED) return [];
  const id = tweetIdOf(tweetUrl);
  if (!id) return [];
  try {
    const { getTwitterDb, getTweetMedia } = await import('../twitter/db.js');
    const rows = getTweetMedia(getTwitterDb(), id);
    return rows
      .filter((r) => (r.kind === 'video' || r.kind === 'gif') && typeof r.video_url === 'string' && /^https?:\/\//.test(r.video_url as string))
      .map((r) => r.video_url as string);
  } catch {
    return [];
  }
}

/**
 * What the Nitter harvest knows about the tweet's attachments: `harvested`
 * false = not in twitter.db (PDF capture hasn't run yet, or DB disabled);
 * `hasVideo` = at least one video/gif attachment recorded.
 */
export async function harvestedMediaEvidence(tweetUrl: string): Promise<{ harvested: boolean; hasVideo: boolean }> {
  if (!env.TWITTER_DB_ENABLED) return { harvested: false, hasVideo: false };
  const id = tweetIdOf(tweetUrl);
  if (!id) return { harvested: false, hasVideo: false };
  try {
    const { getTwitterDb, getTweetById, getTweetMedia } = await import('../twitter/db.js');
    const db = getTwitterDb();
    if (!getTweetById(db, id)) return { harvested: false, hasVideo: false };
    const media = getTweetMedia(db, id);
    return { harvested: true, hasVideo: media.some((r) => r.kind === 'video' || r.kind === 'gif') };
  } catch {
    return { harvested: false, hasVideo: false };
  }
}

export interface TweetDownloadDeps {
  download?: typeof downloadWithYtDlp;
  harvested?: typeof harvestedVideoUrls;
  evidence?: typeof harvestedMediaEvidence;
  xCookies?: () => string | undefined;
}

/**
 * Download every video of the tweet at `url` to `finalPath` (+ `-N` siblings).
 * Tier decisions are logged as `x_video_tier` so the mix is observable.
 */
export async function downloadTweetVideos(url: string, finalPath: string, deps: TweetDownloadDeps = {}, runOptions: Pick<YtDlpRunOptions, 'runner'> = {}): Promise<YtDlpDownloadOutcome> {
  const download = deps.download ?? downloadWithYtDlp;
  const harvested = deps.harvested ?? harvestedVideoUrls;
  const xCookies = deps.xCookies ?? getXScopedCookiesFile;
  const evidence = deps.evidence ?? harvestedMediaEvidence;
  const base = { ...runOptions, timeoutMs: TWEET_DOWNLOAD_TIMEOUT_MS, allowMultiple: true };
  const tier = (name: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event: 'x_video_tier', url, tier: name, ...extra, timestamp: new Date().toISOString() }));

  // Tier 1: anonymous.
  const anon = await download(url, finalPath, base);
  if (anon.ok) {
    tier('anonymous', { ok: true, files: 1 + anon.extraFiles.length });
    return anon;
  }
  if (anon.outcome === 'no_media' || anon.outcome === 'unsupported' || anon.outcome === 'policy_exceeded') {
    tier('anonymous', { ok: false, outcome: anon.outcome, final: true });
    return anon;
  }
  // yt-dlp reports a photo/text-only tweet as "No video formats found!" —
  // the same words it uses for a real extraction failure, so on its own that
  // is `unknown` (retry). The Nitter harvest is the independent witness: a
  // harvested tweet with NO video/gif attachment settles it as no_media, and
  // saves the cookie tier for tweets that might actually be gated.
  if (anon.outcome === 'unknown' && /No video formats found/i.test(anon.error)) {
    const ev = await evidence(url);
    if (ev.harvested && !ev.hasVideo) {
      tier('anonymous', { ok: false, outcome: 'no_media', via: 'harvest_evidence', final: true });
      return { ok: false, outcome: 'no_media', error: 'No video formats found; Nitter harvest recorded no video/gif attachment' };
    }
  }

  // Tier 2: harvested CDN URLs (no account, bytes already located). For
  // `unavailable` too: a tweet deleted after the harvest may still stream.
  const cdn = await harvested(url);
  if (cdn.length > 0) {
    const published: string[] = [];
    let failed: Extract<YtDlpDownloadOutcome, { ok: false }> | undefined;
    for (let i = 0; i < cdn.length; i++) {
      const target = i === 0 ? finalPath : finalPath.replace(/\.mp4$/i, `-${i + 1}.mp4`);
      const one = await download(cdn[i], target, { ...base, allowMultiple: false });
      if (!one.ok) { failed = one; break; }
      published.push(one.filePath);
    }
    if (!failed && published.length > 0) {
      tier('harvested_cdn', { ok: true, files: published.length, after: anon.outcome });
      return { ok: true, filePath: published[0], sizeBytes: 0, extraFiles: published.slice(1) };
    }
    tier('harvested_cdn', { ok: false, outcome: failed?.outcome, after: anon.outcome });
  }

  // Tier 3: the user's X session, only for gates it can plausibly open.
  const cookies = xCookies();
  if (cookies && existsSync(cookies) && (anon.outcome === 'auth_required' || anon.outcome === 'unknown' || anon.outcome === 'unavailable')) {
    const authed = await download(url, finalPath, { ...base, cookiesFile: cookies });
    tier('x_cookies', { ok: authed.ok, outcome: authed.ok ? undefined : authed.outcome, after: anon.outcome });
    if (authed.ok) return authed;
    // An explicit auth failure WITH cookies is terminal; keep the more
    // specific of the two failures otherwise.
    return authed.outcome === 'auth_required' ? authed : (anon.outcome === 'unknown' ? authed : anon);
  }

  tier('anonymous', { ok: false, outcome: anon.outcome, final: true });
  return anon;
}
