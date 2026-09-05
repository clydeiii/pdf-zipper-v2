import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { applyMediaRouting } from '../dist/media/routing.js';
import { downloadTweetVideos, isTweetStatusUrl, tweetIdOf } from '../dist/media/x-media.js';
import { filterCookiesToX } from '../dist/media/x-cookies.js';
import { linkedMediaKey, postPdfBasename, embedLinkedMedia, recordLinkedMedia, applyLinkedMediaToPdf } from '../dist/media/pdf-media-link.js';
import { setInfoDictFields, readInfoDictField } from '../dist/utils/pdf-info-dict.js';

const item = (url, extra = {}) => ({ url, canonicalUrl: url, guid: 'g', source: 'karakeep', bookmarkedAt: '2026-09-05T12:00:00Z', ...extra });

test('native X routing gives every tweet a speculative yt-dlp enclosure; articles/X profile pages untouched', () => {
  const t = applyMediaRouting(item('https://x.com/Reuters/status/2095823526125252742?s=12'), { youtube: 'karakeep', x: 'native' });
  assert.equal(t.mediaType, 'video');
  assert.equal(t.enclosure.downloadVia, 'yt-dlp');
  const asset = item('https://x.com/a/status/1', { mediaType: 'video', enclosure: { url: 'http://karakeep/api/assets/1', type: 'video/mp4' } });
  assert.equal(applyMediaRouting(asset, { youtube: 'karakeep', x: 'native' }).enclosure.downloadVia, 'yt-dlp', 'Karakeep asset replaced');
  assert.equal(applyMediaRouting(asset, { youtube: 'karakeep', x: 'karakeep' }), asset, 'legacy mode untouched');
  const profile = item('https://x.com/Reuters');
  assert.equal(applyMediaRouting(profile, { youtube: 'native', x: 'native' }), profile);
  assert.equal(isTweetStatusUrl('https://twitter.com/a/status/1?s=20'), true);
  assert.equal(isTweetStatusUrl('https://x.com/i/article/123'), false);
  assert.equal(tweetIdOf('https://x.com/a/status/2095823526125252742?s=12'), '2095823526125252742');
});

test('X-scoped cookie jar keeps only x.com/twitter.com lines', () => {
  const jar = ['# Netscape HTTP Cookie File', '.nytimes.com\tTRUE\t/\tTRUE\t0\tnyt-a\tSECRET', '.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tXT', '#HttpOnly_.twitter.com\tTRUE\t/\tTRUE\t0\tct0\tCT', '.google.com\tTRUE\t/\tTRUE\t0\tSID\tG'].join('\n');
  const out = filterCookiesToX(jar);
  assert.ok(out.includes('auth_token') && out.includes('ct0'));
  assert.ok(!out.includes('nyt-a') && !out.includes('SID'));
  assert.ok(out.startsWith('# Netscape HTTP Cookie File'));
});

// Tiered download with a fake downloader: which tier answers, and when.
function fakeDownload(script) {
  const calls = [];
  const fn = async (url, finalPath, opts) => {
    calls.push({ url, cookies: opts.cookiesFile, multiple: opts.allowMultiple });
    const step = script.shift();
    if (!step) throw new Error('unexpected download call');
    if (step.ok) return { ok: true, filePath: finalPath, sizeBytes: 100, extraFiles: step.extra ?? [] };
    return { ok: false, outcome: step.outcome, error: step.outcome };
  };
  return { fn, calls };
}

test('tier 1 anonymous success returns immediately with all videos', async () => {
  const d = fakeDownload([{ ok: true, extra: ['/x/base-2.mp4'] }]);
  const out = await downloadTweetVideos('https://x.com/a/status/1', '/x/base.mp4', { download: d.fn, harvested: async () => [], xCookies: () => undefined });
  assert.equal(out.ok, true);
  assert.deepEqual(out.extraFiles, ['/x/base-2.mp4']);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].multiple, true);
});

test('no_media from the extractor is final — no cookies are spent on a text tweet', async () => {
  const d = fakeDownload([{ ok: false, outcome: 'no_media' }]);
  const out = await downloadTweetVideos('https://x.com/a/status/1', '/x/base.mp4', { download: d.fn, harvested: async () => ['https://video.twimg.com/x.m3u8'], xCookies: () => '/jar' });
  assert.equal(out.ok, false);
  assert.equal(out.outcome, 'no_media');
  assert.equal(d.calls.length, 1);
});

test('tier 2 uses the harvested CDN URLs before touching the user session', async () => {
  const d = fakeDownload([{ ok: false, outcome: 'unknown' }, { ok: true }, { ok: true }]);
  const out = await downloadTweetVideos('https://x.com/a/status/1', '/x/base.mp4', { download: d.fn, harvested: async () => ['https://video.twimg.com/a.m3u8', 'https://video.twimg.com/b.mp4'], xCookies: () => '/jar' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.extraFiles, ['/x/base-2.mp4']);
  assert.equal(d.calls[1].url, 'https://video.twimg.com/a.m3u8');
  assert.equal(d.calls[2].url, 'https://video.twimg.com/b.mp4');
  assert.equal(d.calls.every(c => !c.cookies), true);
});

test('tier 3 presents the X-scoped jar only for gates, and an auth failure with cookies is terminal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'xjar-'));
  const jar = path.join(dir, 'x.txt');
  await writeFile(jar, '# jar\n');
  const d = fakeDownload([{ ok: false, outcome: 'auth_required' }, { ok: false, outcome: 'auth_required' }]);
  const out = await downloadTweetVideos('https://x.com/a/status/1', '/x/base.mp4', { download: d.fn, harvested: async () => [], xCookies: () => jar });
  assert.equal(out.ok, false);
  assert.equal(out.outcome, 'auth_required');
  assert.equal(d.calls[1].cookies, jar);
  // A transient failure never spends the session.
  const d2 = fakeDownload([{ ok: false, outcome: 'transient' }]);
  const out2 = await downloadTweetVideos('https://x.com/a/status/2', '/x/b.mp4', { download: d2.fn, harvested: async () => [], xCookies: () => jar });
  assert.equal(out2.outcome, 'transient');
  assert.equal(d2.calls.length, 1);
});

// PDF ↔ MP4 link
test('linked-media key is case-insensitive on the handle and drops share params; PDF basename matches the capture convention', () => {
  assert.equal(linkedMediaKey('https://x.com/Reuters/status/1?s=12'), linkedMediaKey('https://x.com/reuters/status/1'));
  assert.equal(postPdfBasename('https://x.com/Reuters/status/2095823526125252742?s=12'), 'x.com-reuters-post-2095823526125252742.pdf');
});

test('whichever side finishes last completes the link (media first, then PDF; and PDF first, then media)', async () => {
  const store = (() => { const m = new Map(); return { async sadd(k, ...v) { const s = m.get(k) ?? new Set(); v.forEach(x => s.add(x)); m.set(k, s); }, async smembers(k) { return [...(m.get(k) ?? [])]; } }; })();
  const dir = await mkdtemp(path.join(tmpdir(), 'link-'));
  const mkPdf = async (name) => { const doc = await PDFDocument.create(); doc.addPage(); setInfoDictFields(doc, { Subject: 'https://x.com/a/status/9' }); const f = path.join(dir, name); await writeFile(f, Buffer.from(await doc.save())); return f; };
  // Media first: no PDF on disk yet (findPostPdf searches DATA_DIR, which has no such file) → only the store is written.
  await recordLinkedMedia(store, 'https://x.com/a/status/9', ['/w/x.com-a-post-9.mp4', '/w/x.com-other-post-5.mp4']);
  const pdf = await mkPdf('x.com-a-post-9.pdf');
  await applyLinkedMediaToPdf(store, 'https://x.com/a/status/9', pdf);
  const doc = await PDFDocument.load(await readFile(pdf), { updateMetadata: false });
  assert.equal(readInfoDictField(doc, 'LinkedMedia'), 'x.com-a-post-9.mp4; x.com-other-post-5.mp4');
  // Idempotent re-embed, and a later extra merges.
  assert.equal(await embedLinkedMedia(pdf, ['x.com-a-post-9.mp4']), false);
  assert.equal(await embedLinkedMedia(pdf, ['x.com-a-post-9-2.mp4']), true);
  const doc2 = await PDFDocument.load(await readFile(pdf), { updateMetadata: false });
  assert.equal(readInfoDictField(doc2, 'LinkedMedia'), 'x.com-a-post-9-2.mp4; x.com-a-post-9.mp4; x.com-other-post-5.mp4');
});

test('"No video formats found" on a harvested tweet with no video attachment is no_media; unharvested stays unknown', async () => {
  const mk = () => fakeDownload([{ ok: false, outcome: 'unknown' }]);
  // Make the fake carry yt-dlp's wording.
  const withMsg = (d) => ({ fn: async (u, f, o) => { const r = await d.fn(u, f, o); return r.ok ? r : { ...r, error: 'ERROR: [twitter] 1: No video formats found!; please report this issue' }; }, calls: d.calls });
  const a = withMsg(mk());
  const settled = await downloadTweetVideos('https://x.com/a/status/1', '/x/b.mp4', { download: a.fn, harvested: async () => [], evidence: async () => ({ harvested: true, hasVideo: false }), xCookies: () => '/jar' });
  assert.equal(settled.outcome, 'no_media');
  assert.equal(a.calls.length, 1, 'no cookie tier for a text tweet');
  const b = withMsg(mk());
  const pending = await downloadTweetVideos('https://x.com/a/status/2', '/x/c.mp4', { download: b.fn, harvested: async () => [], evidence: async () => ({ harvested: false, hasVideo: false }), xCookies: () => undefined });
  assert.equal(pending.outcome, 'unknown', 'retry until the harvest can testify');
});
