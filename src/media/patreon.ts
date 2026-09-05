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

import { env } from '../config/env.js';
import { downloadWithYtDlp, type YtDlpDownloadOutcome } from './ytdlp-video.js';

/**
 * HLS is muxed segment-by-segment, so a long post can take a while. Integer by
 * construction — execFile REJECTS a non-integer timeout, which is how every
 * long video compression silently failed once already.
 */
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

export type PatreonDownloadOutcome = YtDlpDownloadOutcome;

/**
 * Download a Patreon post's video to an exact path through the shared,
 * hardened yt-dlp runner (staging dir, probe, structured outcomes). Patreon
 * needs the PERSONAL cookie jar on the first attempt — member-only HLS is
 * behind the user's own session — which is the one difference from the
 * public-platform path. The shorter-side cap pulls the 480p rendition
 * directly, so the compressor rarely has anything to do.
 */
export async function downloadPatreonVideo(
  postUrl: string,
  filePath: string
): Promise<PatreonDownloadOutcome> {
  return downloadWithYtDlp(postUrl, filePath, { cookiesFile: env.COOKIES_FILE });
}
