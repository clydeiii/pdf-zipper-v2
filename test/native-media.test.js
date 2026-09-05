import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { applyMediaRouting, isNativeVideoHost, parseMediaSourceMode, acquisitionSourceOf } from '../dist/media/routing.js';
import { classifyYtDlpFailure, buildYtDlpArgs, downloadWithYtDlp, TERMINAL_YTDLP_OUTCOMES } from '../dist/media/ytdlp-video.js';
import { classifyBookmark, coverageUrlKeys } from '../dist/maintenance/coverage-reconciler.js';

const item = (url, extra = {}) => ({ url, canonicalUrl: url, guid: 'g1', source: 'karakeep', bookmarkedAt: '2026-09-05T12:00:00Z', ...extra });

// --- routing -------------------------------------------------------------

test('native mode gives a YouTube/Vimeo link a yt-dlp enclosure immediately, replacing any Karakeep asset', () => {
  const yt = applyMediaRouting(item('https://www.youtube.com/watch?v=abc123&is=xyz'), { youtube: 'native' });
  assert.equal(yt.mediaType, 'video');
  assert.equal(yt.enclosure.downloadVia, 'yt-dlp');
  assert.equal(yt.enclosure.url, 'https://www.youtube.com/watch?v=abc123&is=xyz');
  const withAsset = applyMediaRouting(item('https://youtu.be/abc123', { mediaType: 'video', enclosure: { url: 'http://karakeep/api/assets/1', type: 'video/mp4' } }), { youtube: 'native' });
  assert.equal(withAsset.enclosure.downloadVia, 'yt-dlp', 'Karakeep asset ignored in native mode');
  assert.equal(acquisitionSourceOf(withAsset), 'native');
  const vimeo = applyMediaRouting(item('https://vimeo.com/12345'), { youtube: 'native' });
  assert.equal(vimeo.enclosure.downloadVia, 'yt-dlp');
});

test('karakeep mode leaves items exactly as the parser built them', () => {
  const plain = item('https://www.youtube.com/watch?v=abc');
  assert.equal(applyMediaRouting(plain, { youtube: 'karakeep' }), plain);
  const asset = item('https://www.youtube.com/watch?v=abc', { mediaType: 'video', enclosure: { url: 'http://karakeep/api/assets/1', type: 'video/mp4' } });
  assert.equal(applyMediaRouting(asset, { youtube: 'karakeep' }), asset);
  assert.equal(acquisitionSourceOf(asset), 'karakeep');
});

test('x.com, articles, Patreon and uploaded PDF assets are untouched by the YouTube flag', () => {
  for (const u of ['https://x.com/a/status/1', 'https://example.com/post', 'https://www.patreon.com/posts/thing-123']) {
    const it = item(u);
    assert.equal(applyMediaRouting(it, { youtube: 'native' }), it, u);
  }
  const pdfAsset = item('http://karakeep/api/assets/9', { mediaType: 'pdf', enclosure: { url: 'http://karakeep/api/assets/9', type: 'application/pdf' } });
  assert.equal(applyMediaRouting(pdfAsset, { youtube: 'native' }), pdfAsset);
  assert.equal(isNativeVideoHost('https://m.youtube.com/watch?v=1'), true);
  assert.equal(isNativeVideoHost('https://notyoutube.com/watch'), false);
  assert.equal(parseMediaSourceMode('native'), 'native');
  assert.equal(parseMediaSourceMode('bogus'), 'karakeep');
});

// --- outcome classification (real yt-dlp messages) -----------------------

test('terminal outcomes are named, and "there was no video" is never inferred from vague failures', () => {
  assert.equal(classifyYtDlpFailure("ERROR: [twitter] 123: There's no video in this tweet"), 'no_media');
  assert.equal(classifyYtDlpFailure('ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader'), 'unavailable');
  assert.equal(classifyYtDlpFailure('ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video'), 'auth_required');
  assert.equal(classifyYtDlpFailure('ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser'), 'auth_required');
  assert.equal(classifyYtDlpFailure('ERROR: [youtube] abc: Join this channel to get access to members-only content'), 'auth_required');
  assert.equal(classifyYtDlpFailure('ERROR: Unsupported URL: https://example.com/thing'), 'unsupported');
  assert.equal(classifyYtDlpFailure('ERROR: [youtube] abc: The uploader has not made this video available in your country'), 'unsupported');
  assert.equal(classifyYtDlpFailure('File is larger than max-filesize (6000000000 bytes > 5242880000 bytes). Aborting.'), 'policy_exceeded');
  assert.equal(classifyYtDlpFailure('ERROR: unable to download video data: HTTP Error 429: Too Many Requests'), 'transient');
  assert.equal(classifyYtDlpFailure('ERROR: fragment 12 not found, unable to continue (--abort-on-unavailable-fragments)'), 'transient');
  assert.equal(classifyYtDlpFailure('ERROR: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>'), 'transient');
  // The two messages that used to complete jobs as "no video":
  assert.equal(classifyYtDlpFailure('ERROR: [youtube] abc: Requested format is not available. Use --list-formats'), 'unknown');
  assert.equal(classifyYtDlpFailure('ERROR: No video formats found!; please report this issue'), 'unknown');
  for (const o of ['no_media', 'unavailable', 'auth_required', 'unsupported', 'policy_exceeded']) assert.ok(TERMINAL_YTDLP_OUTCOMES.has(o));
  assert.ok(!TERMINAL_YTDLP_OUTCOMES.has('transient') && !TERMINAL_YTDLP_OUTCOMES.has('unknown'));
});

test('one format policy: shorter-side cap via -S res, no /best escape, fragments abort, size cap, staging output', () => {
  const args = buildYtDlpArgs('https://youtu.be/x', '/tmp/stage', { maxShortSide: 480, maxFileMb: 5000 });
  const joined = args.join(' ');
  assert.match(joined, /-S res:480,\+size/);
  assert.match(joined, /-f bv\*\+ba\/b(?! |$)?/);
  assert.ok(!/\/best(\s|$)/.test(joined.replace('bv*+ba/b', '')), 'no unbounded /best fallback');
  assert.match(joined, /--abort-on-unavailable-fragments/);
  assert.match(joined, /--max-filesize 5000M/);
  assert.match(joined, /-P \/tmp\/stage -o video-%\(playlist_index\|1\)s\.%\(ext\)s/);
  assert.ok(!joined.includes('--cookies'), 'anonymous by default');
  const withCookies = buildYtDlpArgs('https://youtu.be/x', '/tmp/stage', { maxShortSide: 480, maxFileMb: 5000, cookiesFile: '/etc/hostname' });
  assert.ok(withCookies.includes('--cookies'));
});

test('a failed run leaves no staging directory behind and reports the classified outcome', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytdlp-'));
  const final = path.join(dir, 'video.mp4');
  const runner = async (_cmd, args, _timeout) => {
    // Simulate yt-dlp writing a .part into the staging dir, then dying.
    const stage = args[args.indexOf('-P') + 1];
    await writeFile(path.join(stage, 'video.mp4.part'), 'partial');
    return { code: 1, signal: null, output: 'ERROR: [youtube] abc: Video unavailable', timedOut: false };
  };
  const out = await downloadWithYtDlp('https://youtu.be/abc', final, { runner, maxShortSide: 480, maxFileMb: 10 });
  assert.equal(out.ok, false);
  assert.equal(out.outcome, 'unavailable');
  const left = await readdir(dir);
  assert.deepEqual(left, [], `staging cleaned: ${left}`);
});

test('a timeout is transient and kills the attempt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytdlp-'));
  const runner = async () => ({ code: null, signal: 'SIGKILL', output: '', timedOut: true });
  const out = await downloadWithYtDlp('https://youtu.be/abc', path.join(dir, 'v.mp4'), { runner, timeoutMs: 1000 });
  assert.equal(out.ok, false);
  assert.equal(out.outcome, 'transient');
});

test('yt-dlp exiting 0 with no produced file is "unknown" (retryable), never no_media', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytdlp-'));
  const runner = async () => ({ code: 0, signal: null, output: '[download] Skipping', timedOut: false });
  const out = await downloadWithYtDlp('https://youtu.be/abc', path.join(dir, 'v.mp4'), { runner });
  assert.equal(out.ok, false);
  assert.equal(out.outcome, 'unknown');
  assert.equal((await readdir(dir)).length, 0);
});

// --- coverage audit reads terminal media outcomes ------------------------

test('coverage: a completed media job with no_media is a documented skip; other terminal outcomes are failures', () => {
  const url = 'https://www.youtube.com/watch?v=abc123';
  const keys = coverageUrlKeys(url);
  const bm = { bookmarkId: 'b', createdAt: '2026-09-05T00:00:00Z', url, item: item(url) };
  const job = (outcome, detail) => ({ keys, queue: 'media-collection', roles: ['mp4', 'transcript'], state: 'completed', timestamp: Date.now(), outcome, outcomeDetail: detail });
  assert.equal(classifyBookmark(bm, { now: Date.now(), keys, artifacts: [], jobs: [job('no_media', 'text only')] }).status, 'skipped');
  const gone = classifyBookmark(bm, { now: Date.now(), keys, artifacts: [], jobs: [job('unavailable', 'Video unavailable')] });
  assert.equal(gone.status, 'failed');
  assert.match(gone.detail, /unavailable/);
  const tweet = 'https://x.com/a/status/1';
  const tkeys = coverageUrlKeys(tweet);
  const tbm = { bookmarkId: 't', createdAt: '2026-09-05T00:00:00Z', url: tweet, item: item(tweet, { mediaType: 'video', enclosure: { url: 'u', type: 'video/mp4' } }) };
  const pdf = { file: 'media/2026-W36/pdfs/x.com-a-post-1.pdf', role: 'pdf', keys: tkeys };
  const authed = classifyBookmark(tbm, { now: Date.now(), keys: tkeys, artifacts: [pdf], jobs: [{ ...job('auth_required', 'Sign in'), keys: tkeys }] });
  assert.equal(authed.status, 'partial');
  assert.match(authed.detail, /auth_required/);
});
