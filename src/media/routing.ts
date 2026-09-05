/**
 * Media acquisition routing — who downloads a bookmark's video.
 *
 * Owner decision (2026-09-05): Karakeep is the bookmarking service only;
 * pdf-zipper acquires every video itself. The one exception is a PDF the user
 * drags into Karakeep (an uploaded asset) — there is no other copy of that.
 *
 * Why not keep Karakeep's downloads: its asset endpoint served us truncated
 * files while its yt-dlp was still writing (21 corrupt MP4s in the library),
 * a tweet whose asset landed after the first poll never got its video (6 in
 * two days), YouTube captures waited up to 2h for an asset that we then had
 * to download ourselves anyway, and its bundled yt-dlp was 403-blocked for
 * days in August with nothing to tell us. Its downloader also has no
 * authentication advantage over ours (design review 2026-09-05).
 *
 * Rollout is platform-scoped so it can be reverted per platform:
 *   PR1 (this): YouTube/Vimeo — `MEDIA_SOURCE_YOUTUBE=native|karakeep`.
 *   PR2: x.com with durable per-media discovery (multi-video tweets exist).
 *   PR3: retire the Karakeep asset path and flip CRAWLER_VIDEO_DOWNLOAD off.
 */

import type { BookmarkItem } from '../feeds/types.js';

export type MediaSourceMode = 'native' | 'karakeep';

export interface MediaRoutingSettings {
  youtube: MediaSourceMode;
}

const NATIVE_VIDEO_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'vimeo.com', 'www.vimeo.com', 'player.vimeo.com',
]);

/** YouTube/Vimeo — the platforms PR1 moves to native acquisition. */
export function isNativeVideoHost(url: string): boolean {
  try {
    return NATIVE_VIDEO_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function parseMediaSourceMode(value: string | undefined, fallback: MediaSourceMode = 'karakeep'): MediaSourceMode {
  return value === 'native' || value === 'karakeep' ? value : fallback;
}

/**
 * Decide how a bookmark's video is acquired. Pure: returns a (possibly new)
 * item; never touches I/O. In native mode a YouTube/Vimeo LINK gets a yt-dlp
 * enclosure pointing at the watch URL itself — immediately, regardless of
 * whether Karakeep has (or will ever have) a video asset — so the collector
 * downloads it the moment the metadata worker queues it. Any Karakeep asset
 * enclosure the parser attached is replaced. Uploaded PDF assets and every
 * other host pass through untouched.
 */
export function applyMediaRouting(item: BookmarkItem, settings: MediaRoutingSettings): BookmarkItem {
  if (item.mediaType === 'pdf') return item;
  if (settings.youtube !== 'native' || !isNativeVideoHost(item.url)) return item;
  return {
    ...item,
    mediaType: 'video',
    enclosure: { url: item.url, type: 'video/mp4', length: undefined, downloadVia: 'yt-dlp' },
  };
}

/** Which acquisition path an item is on, for logs and the coverage audit. */
export function acquisitionSourceOf(item: Pick<BookmarkItem, 'enclosure'>): 'native' | 'karakeep' | 'none' {
  if (!item.enclosure) return 'none';
  return item.enclosure.downloadVia === 'yt-dlp' ? 'native' : 'karakeep';
}
