/**
 * Native video acquisition via yt-dlp — the downloader behind every video
 * pdf-zipper fetches itself (YouTube/Vimeo since PR1, Patreon with the
 * personal cookies, x.com in PR2).
 *
 * Hardening that came out of the 2026-09-05 design review, each rule with
 * the failure it prevents:
 *  - ONE format policy: `-S res:<cap>,+size` — the largest rendition whose
 *    SHORTER side is ≤ VIDEO_COMPRESS_MAX_HEIGHT (the compressor's own rule,
 *    so portrait phone video isn't crushed), preferring smaller files. The
 *    old selector's trailing `/best` silently escaped the cap.
 *  - Staging directory per attempt on the destination filesystem; the file
 *    is probed (readable, has video, has duration) and only then renamed into
 *    place. Every leftover (.part, component streams) dies with the directory,
 *    on success and on failure alike.
 *  - `--abort-on-unavailable-fragments`: yt-dlp's default is to SKIP a missing
 *    fragment and still produce a readable-but-incomplete file that passes
 *    every probe.
 *  - `--max-filesize` plus a staging-size check for HLS where size is unknown.
 *  - The subprocess runs in its own process group and the whole group is
 *    killed on timeout — a Node timeout alone orphaned ffmpeg children.
 *  - Structured outcomes instead of `no_video | download_failed`. "Terminal"
 *    must never mean "there was no video": yt-dlp's "Video unavailable" and
 *    "Unsupported URL" were both classified as no_video and completed the job
 *    without retry, silently. Only an explicit no-media message is no_media.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { judgeProbe, probeVideo } from './video-provenance.js';

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';

/** Default acquisition deadline — long YouTube videos on a slow link. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 45 * 60_000;

export type YtDlpOutcome =
  | 'no_media'          // explicit "this post/page has no video" — terminal, PDF alone satisfies coverage
  | 'unavailable'       // deleted / private / removed — terminal, an unmet requirement
  | 'auth_required'     // login/age/membership gate we could not satisfy — terminal for now
  | 'unsupported'       // DRM, geo-restriction, unsupported extractor — terminal
  | 'policy_exceeded'   // size cap — terminal by policy, visible
  | 'transient'         // network / 429 / 5xx / timeout — retry with backoff
  | 'unknown';          // no formats, malformed output, missing file — retry a bounded number of times

/** Outcomes the collection worker completes without retrying. */
export const TERMINAL_YTDLP_OUTCOMES: ReadonlySet<YtDlpOutcome> =
  new Set<YtDlpOutcome>(['no_media', 'unavailable', 'auth_required', 'unsupported', 'policy_exceeded']);

export type YtDlpDownloadOutcome =
  | {
      ok: true;
      filePath: string;
      sizeBytes: number;
      width?: number;
      height?: number;
      /**
       * Further videos from the same post (a tweet can carry up to four),
       * published beside `filePath` as `<base>-2.mp4`, `<base>-3.mp4`, …
       * Only populated when the caller allowed multiple outputs.
       */
      extraFiles: string[];
    }
  | { ok: false; outcome: YtDlpOutcome; error: string };

/**
 * Map yt-dlp's stderr/stdout to an outcome. Pure and tested against real
 * messages. Order matters: the specific classes come before the catch-alls.
 */
export function classifyYtDlpFailure(output: string): YtDlpOutcome {
  const o = output;
  if (/File is larger than max-filesize|larger than the maximum file size|exceeds the size cap/i.test(o)) return 'policy_exceeded';
  if (/There.s no video in this tweet|no media found|does not contain any (video|media)|has no video|no video formats? (were )?found for this (post|tweet)/i.test(o)) return 'no_media';
  if (/Sign in to confirm|confirm your age|age.restricted|not a bot|login required|Log in for access|members?-only|Join this channel|This video is available to this channel's members|Private video|requires? (a )?(login|authentication|subscription)|NSFW tweet requires authentication/i.test(o)) return 'auth_required';
  if (/Video unavailable|has been removed|This video is no longer available|(?<!format )is not available\b(?! in your)|does not exist|account has been terminated|HTTP Error 404|HTTP Error 410|This video is private|removed by the uploader|Tweet .*deleted|Sorry, that page does not exist/i.test(o)) return 'unavailable';
  if (/Unsupported URL|DRM|not available in your (country|location|region)|not made this video available|available in your country|geo.?(restricted|blocked)|blocked it in your country|is not supported/i.test(o)) return 'unsupported';
  if (/HTTP Error 429|HTTP Error 5\d\d|Too Many Requests|timed out|Timed out|Connection reset|ECONNRESET|ECONNREFUSED|EAI_AGAIN|Temporary failure|Unable to download webpage|Read timed out|Remote end closed|fragment .* not found|unavailable fragments?|Network is unreachable|Killed by timeout/i.test(o)) return 'transient';
  return 'unknown';
}

/** Did the failure look like a gate that the platform's cookies could open? */
export function looksLikeGatedFailure(output: string): boolean {
  return /Sign in to confirm|confirm your age|age.restricted|not a bot|HTTP Error 403|login required|NSFW tweet requires authentication/i.test(output);
}

export interface YtDlpRunOptions {
  /** Cookies to present on the first attempt (Patreon uses the personal jar). */
  cookiesFile?: string;
  /** Cookies to retry with only after a gated failure (YouTube's work jar). */
  gatedRetryCookiesFile?: string;
  timeoutMs?: number;
  /** Shorter-side cap in px; defaults to VIDEO_COMPRESS_MAX_HEIGHT. */
  maxShortSide?: number;
  /** Size cap in MB; defaults to MEDIA_DOWNLOAD_MAX_MB. */
  maxFileMb?: number;
  /**
   * Accept every video the extractor yields for the URL (multi-video tweets;
   * yt-dlp returns them as entries even with --no-playlist). Extras are
   * published as `<base>-N.mp4`. Off for YouTube/Vimeo: one URL, one video.
   */
  allowMultiple?: boolean;
  /** Injected for tests. */
  runner?: ProcessRunner;
}

export interface ProcessResult { code: number | null; signal: NodeJS.Signals | null; output: string; timedOut: boolean }
export type ProcessRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<ProcessResult>;

/**
 * Spawn in its own process group and kill the GROUP on timeout so yt-dlp's
 * ffmpeg child can't outlive it and keep writing into the staging dir.
 */
export const spawnProcessGroup: ProcessRunner = (cmd, args, timeoutMs) => new Promise((resolve) => {
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const cap = 2 * 1024 * 1024;
  const collect = (chunk: Buffer) => { if (output.length < cap) output += chunk.toString('utf8'); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }, timeoutMs);
  child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, signal: null, output: `${output}\n${err.message}`, timedOut }); });
  child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output, timedOut }); });
});

/** yt-dlp arguments for one attempt. Exported for tests. */
export function buildYtDlpArgs(url: string, stageDir: string, opts: { maxShortSide: number; maxFileMb: number; cookiesFile?: string }): string[] {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--js-runtimes', 'node',
    // Largest rendition whose SHORTER side ≤ cap, smaller file preferred.
    // `res` in yt-dlp's sort is the smaller dimension, i.e. the compressor's rule.
    '-f', 'bv*+ba/b',
    // `lang` (yt-dlp's language preference: the original track ranks above
    // every dub) MUST come before `+size`. YouTube now attaches 15+ AI-dubbed
    // audio tracks to popular videos, and with size first the smallest track
    // won: 2026-09-08, a week of captures came through with Malayalam/other
    // dubs (xOi5nDH0lu0 → 249-20 "Malayalam, low" instead of 139-20
    // "English (US) original (default)"). The container tags still said
    // `eng`, so tags can't be trusted to detect it.
    '-S', `res:${opts.maxShortSide},lang,+size`,
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--abort-on-unavailable-fragments',
    '--concurrent-fragments', '1',
    '--socket-timeout', '30',
    '--retries', '2',
    '--fragment-retries', '2',
    '--max-filesize', `${opts.maxFileMb}M`,
    '-P', stageDir,
    // playlist_index is NA for a single video → `|1`. Multi-video tweets
    // number their entries; the publisher maps N=1 to <base>.mp4, N>1 to <base>-N.mp4.
    '-o', 'video-%(playlist_index|1)s.%(ext)s',
  ];
  if (opts.cookiesFile && existsSync(opts.cookiesFile)) args.push('--cookies', opts.cookiesFile);
  args.push(url);
  return args;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    try { total += (await stat(path.join(dir, entry))).size; } catch { /* vanished */ }
  }
  return total;
}

/**
 * Download `url` to `finalPath` (an .mp4 path in the weekly bin). Staging,
 * validation and atomic publish are handled here; callers get an outcome.
 */
export async function downloadWithYtDlp(url: string, finalPath: string, options: YtDlpRunOptions = {}): Promise<YtDlpDownloadOutcome> {
  const runner = options.runner ?? spawnProcessGroup;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxShortSide = options.maxShortSide ?? env.VIDEO_COMPRESS_MAX_HEIGHT;
  const maxFileMb = options.maxFileMb ?? env.MEDIA_DOWNLOAD_MAX_MB;
  const stageDir = path.join(path.dirname(finalPath), `.stage-${path.basename(finalPath, '.mp4')}-${randomUUID().slice(0, 8)}`);
  await mkdir(stageDir, { recursive: true });
  const cleanup = () => rm(stageDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });

  try {
    let result = await runner(YT_DLP_PATH, buildYtDlpArgs(url, stageDir, { maxShortSide, maxFileMb, cookiesFile: options.cookiesFile }), timeoutMs);
    if (result.timedOut) return { ok: false, outcome: 'transient', error: `yt-dlp exceeded ${Math.round(timeoutMs / 60000)} min (killed)` };

    if (result.code !== 0 && options.gatedRetryCookiesFile && existsSync(options.gatedRetryCookiesFile)
        && options.gatedRetryCookiesFile !== options.cookiesFile && looksLikeGatedFailure(result.output)) {
      console.log(JSON.stringify({ event: 'ytdlp_cookie_retry', url, timestamp: new Date().toISOString() }));
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
      await mkdir(stageDir, { recursive: true });
      result = await runner(YT_DLP_PATH, buildYtDlpArgs(url, stageDir, { maxShortSide, maxFileMb, cookiesFile: options.gatedRetryCookiesFile }), timeoutMs);
      if (result.timedOut) return { ok: false, outcome: 'transient', error: `yt-dlp exceeded ${Math.round(timeoutMs / 60000)} min (killed)` };
    }

    if (result.code !== 0) {
      const outcome = classifyYtDlpFailure(result.output);
      return { ok: false, outcome, error: result.output.trim().slice(-600) };
    }

    // yt-dlp exits 0 with `--max-filesize` exceeded (it just skips the download).
    if (/File is larger than max-filesize/i.test(result.output)) {
      return { ok: false, outcome: 'policy_exceeded', error: `exceeds MEDIA_DOWNLOAD_MAX_MB=${maxFileMb}` };
    }
    if (await dirSize(stageDir) > maxFileMb * 1024 * 1024) {
      return { ok: false, outcome: 'policy_exceeded', error: `staged output exceeds MEDIA_DOWNLOAD_MAX_MB=${maxFileMb}` };
    }

    const produced = (await readdir(stageDir))
      .map((f) => ({ f, m: /^video-(\d+|NA)\.[a-z0-9]+$/i.exec(f) }))
      .filter((x): x is { f: string; m: RegExpExecArray } => !!x.m && !x.f.endsWith('.part'))
      .map((x) => ({ file: x.f, index: x.m[1] === 'NA' ? 1 : Number(x.m[1]) }))
      .sort((a, b) => a.index - b.index);
    if (produced.length === 0) {
      return { ok: false, outcome: 'unknown', error: `yt-dlp exited 0 but produced no file: ${result.output.trim().slice(-300)}` };
    }
    const selected = options.allowMultiple ? produced : produced.slice(0, 1);
    const published: string[] = [];
    let dims: { width?: number; height?: number } | undefined;
    for (let i = 0; i < selected.length; i++) {
      const staged = path.join(stageDir, selected[i].file);
      const probe = await probeVideo(staged);
      const verdict = judgeProbe(probe);
      if (!verdict.ok) {
        // One bad entry poisons the whole attempt: a partially-published
        // multi-video tweet would look complete to every later check.
        for (const done of published) await rm(done, { force: true }).catch(() => {});
        return { ok: false, outcome: 'unknown', error: `downloaded file ${selected[i].file} failed probe (${verdict.reason})` };
      }
      const d = probe?.streams?.find((s) => s.codec_type === 'video') as { width?: number; height?: number } | undefined;
      if (i === 0) dims = d;
      if (d?.width && d?.height && Math.min(d.width, d.height) > maxShortSide) {
        // No compliant rendition existed; the compressor will bring it down.
        console.log(JSON.stringify({ event: 'ytdlp_format_fallback', url, width: d.width, height: d.height, cap: maxShortSide, timestamp: new Date().toISOString() }));
      }
      const target = i === 0 ? finalPath : finalPath.replace(/\.mp4$/i, `-${i + 1}.mp4`);
      await rename(staged, target);
      published.push(target);
    }
    return { ok: true, filePath: published[0], sizeBytes: statSync(published[0]).size, width: dims?.width, height: dims?.height, extraFiles: published.slice(1) };
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: error instanceof Error ? error.message : String(error) };
  } finally {
    await cleanup();
  }
}

/**
 * Public-platform download (YouTube/Vimeo, and until PR2 the self-download
 * fallback for anything the poller routes to yt-dlp): anonymous first, the
 * work-account cookie jar only after a gated failure.
 */
export async function downloadVideoViaYtDlp(url: string, filePath: string, options: Pick<YtDlpRunOptions, 'runner' | 'timeoutMs'> = {}): Promise<YtDlpDownloadOutcome> {
  return downloadWithYtDlp(url, filePath, {
    ...options,
    gatedRetryCookiesFile: env.YT_DLP_COOKIES_FILE,
  });
}
