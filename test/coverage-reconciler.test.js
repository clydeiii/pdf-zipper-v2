import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  classifyBookmark, coverageUrlKeys, expectedCoverageRoles, summarizeCoverage,
  fetchCoverageBookmarks, scanCoverageArtifacts, persistCoverageReport, coverageNotification,
} from '../dist/maintenance/coverage-reconciler.js';
import { buildKarakeepItem } from '../dist/feeds/parsers/karakeep.js';
import { BookmarkDeduplicator } from '../dist/urls/deduplicator.js';
import { substackDedupCandidates } from '../dist/urls/substack-canonical.js';
import { declaredCanonicalCandidates } from '../dist/urls/canonical-declaration.js';

const HOUR = 3_600_000;
const now = Date.parse('2026-09-04T16:00:00Z');
const articleUrl = 'https://example.com/story';
const videoUrl = 'https://youtube.com/watch?v=abcdefghijk';
const tweetUrl = 'https://x.com/user/status/123456789';
const podcastUrl = 'https://podcasts.apple.com/us/podcast/show/id123?i=456';
function bookmark(url = articleUrl, age = HOUR, extra = {}) {
  const record = { id: 'b1', createdAt: new Date(now - age).toISOString(), content: { type: 'link', url, title: 'A story' }, ...extra };
  const item = buildKarakeepItem(record, 'https://karakeep.test');
  return { bookmarkId: record.id, createdAt: record.createdAt, url: item?.url || url, title: item?.title, item };
}
function artifact(url = articleUrl, role = 'pdf', file = `media/2026-W36/pdfs/a.${role}`) {
  return { keys: coverageUrlKeys(url), role, file };
}
function job(url = articleUrl, state = 'waiting', age = HOUR, roles = ['pdf'], extra = {}) {
  return { keys: coverageUrlKeys(url), state, timestamp: now - age, roles, queue: 'url-conversion', ...extra };
}
function classify(input = bookmark(), extra = {}) {
  return classifyBookmark(input, { now, keys: coverageUrlKeys(input.url), artifacts: [], jobs: [], ...extra });
}
function videoTweet() {
  return bookmark(tweetUrl, HOUR, { content: { type: 'link', url: tweetUrl, videoAssetId: 'v1' }, assets: [{ id: 'v1', assetType: 'video' }] });
}

test('every coverage status is reachable and files take precedence over failed history', () => {
  assert.equal(classify().status, 'unaccounted');
  assert.equal(classify(bookmark(), { artifacts: [artifact()], jobs: [job(articleUrl, 'failed')] }).status, 'archived');
  assert.equal(classify(bookmark(), { jobs: [job()] }).status, 'pending');
  assert.equal(classify(bookmark(), { jobs: [job(articleUrl, 'active', 7 * HOUR)] }).status, 'stale_pending');
  const failed = classify(bookmark(), { jobs: [job(articleUrl, 'failed', HOUR, ['pdf'], { failedReason: 'paywall: subscriber only' })] });
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail, /paywall/);
  assert.equal(classify(bookmark(), { source: 'manual', artifacts: [artifact()] }).status, 'manual');
  assert.equal(classify(bookmark(), { source: 'manual', jobs: [job()] }).status, 'manual_missing');
  const note = bookmark(articleUrl, HOUR, { content: { type: 'text' } });
  assert.equal(classify(note).status, 'skipped');
  assert.equal(classify(videoTweet(), { artifacts: [artifact(tweetUrl)] }).status, 'partial');
});

test('deadline boundaries use strict > and queued jobs use job age, not bookmark age', () => {
  for (const state of ['waiting', 'active', 'delayed']) {
    assert.equal(classify(bookmark(articleUrl, 2 * 24 * HOUR), { jobs: [job(articleUrl, state, 6 * HOUR)] }).status, 'pending');
    assert.equal(classify(bookmark(), { jobs: [job(articleUrl, state, 6 * HOUR + 1)] }).status, 'stale_pending');
  }
  assert.equal(classify(bookmark(videoUrl, 3 * HOUR), { videoRetry: true }).status, 'pending');
  assert.equal(classify(bookmark(videoUrl, 3 * HOUR + 1), { videoRetry: true }).status, 'stale_pending');
  assert.equal(classify(bookmark(videoUrl, 9 * HOUR)).status, 'unaccounted');
});

test('missing roles require the correct pending job and stale waits remain visible', () => {
  const input = videoTweet();
  const pdf = artifact(tweetUrl);
  assert.equal(classify(input, { artifacts: [pdf], jobs: [job(tweetUrl)] }).status, 'partial');
  assert.equal(classify(input, { artifacts: [pdf], jobs: [job(tweetUrl, 'active', HOUR, ['mp4'])] }).status, 'pending');
  assert.equal(classify(input, { artifacts: [pdf], jobs: [job(tweetUrl, 'delayed', 7 * HOUR, ['mp4'])] }).status, 'stale_pending');
  assert.equal(classify(input, { artifacts: [pdf], jobs: [job(tweetUrl, 'failed', HOUR, ['mp4'])] }).status, 'partial');
  assert.equal(classify(input, { source: 'manual', artifacts: [pdf] }).status, 'partial');
  assert.equal(classify(input, { artifacts: [pdf, artifact(tweetUrl, 'mp4')], jobs: [job(tweetUrl, 'active', 7 * HOUR)] }).status, 'archived');
  assert.equal(classify(bookmark(podcastUrl), { artifacts: [artifact(podcastUrl, 'mp3')], jobs: [job(podcastUrl, 'active', HOUR, ['mp3', 'transcript'])] }).status, 'pending');
});

test('newest job across queues controls failures; completed job without a file is unaccounted', () => {
  const jobs = [job(articleUrl, 'failed', 2 * HOUR), job(articleUrl, 'completed', HOUR, ['pdf'], { queue: 'media-collection' })];
  assert.equal(classify(bookmark(), { jobs }).status, 'unaccounted');
  assert.equal(classify(bookmark(), { jobs: [...jobs, job(articleUrl, 'waiting', HOUR / 2)] }).status, 'pending');
  assert.equal(classify(bookmark(), { jobs: [job('https://unrelated.test', 'failed')] }).status, 'unaccounted');
});

test('expected roles reuse poller routing, with optional Patreon video and video fallback', () => {
  assert.deepEqual(expectedCoverageRoles(bookmark().item), ['pdf']);
  assert.deepEqual(expectedCoverageRoles(videoTweet().item), ['pdf', 'mp4']);
  assert.deepEqual(expectedCoverageRoles(bookmark(videoUrl).item), ['mp4']);
  assert.deepEqual(expectedCoverageRoles(bookmark('https://vimeo.com/123').item), ['mp4']);
  assert.deepEqual(expectedCoverageRoles(bookmark(podcastUrl).item), ['mp3', 'transcript']);
  const patreon = bookmark('https://patreon.com/posts/member-post-123');
  assert.equal(patreon.item.mediaType, 'video');
  assert.deepEqual(expectedCoverageRoles(patreon.item), ['pdf']);
  assert.equal(classify(patreon, { artifacts: [artifact(patreon.url)] }).status, 'archived');
  const pdf = bookmark('', HOUR, { content: { type: 'asset', assetType: 'pdf', assetId: 'pdf1' }, assets: [{ id: 'pdf1', assetType: 'pdf', fileName: 'Uploaded.pdf' }] });
  assert.equal(pdf.item.url, 'https://karakeep.test/api/assets/pdf1');
  assert.equal(pdf.title, 'Uploaded');
  assert.deepEqual(expectedCoverageRoles(pdf.item), ['pdf']);
  const image = bookmark('', HOUR, { content: { type: 'asset', assetType: 'image', assetId: 'i1' } });
  assert.equal(classify(image).status, 'skipped');
  const articleWithEmbed = bookmark(articleUrl, HOUR, { content: { type: 'link', url: articleUrl, videoAssetId: 'v' }, assets: [{ id: 'v', assetType: 'video' }] });
  assert.deepEqual(expectedCoverageRoles(articleWithEmbed.item), ['pdf']);
});

test('media skip requires explicit evidence; known failure and partial still win', () => {
  assert.equal(classify(bookmark(videoUrl), { mediaRebookmark: true }).status, 'skipped');
  assert.match(classify(bookmark(videoUrl), { mediaRebookmark: true }).detail, /media_rebookmark_dedup/);
  assert.equal(classify(bookmark(videoUrl), { mediaRebookmark: true, jobs: [job(videoUrl, 'failed', HOUR, ['mp4'])] }).status, 'failed');
  assert.equal(classify(videoTweet(), { mediaRebookmark: true, artifacts: [artifact(tweetUrl)] }).status, 'partial');
});

test('share-token tweets and query-only aliases match with reviewable reasons', () => {
  const shared = bookmark(`${tweetUrl}?s=20&t=phone`);
  const result = classify(shared, { artifacts: [artifact(tweetUrl)] });
  assert.equal(result.status, 'archived');
  assert.deepEqual(result.matchedBy, ['no-query']);
  const query = classify(bookmark(`${articleUrl}?share=abc`), { artifacts: [artifact(articleUrl)] });
  assert.equal(query.status, 'archived');
  assert.deepEqual(query.matchedBy, ['no-query']);
  assert.equal(classify(bookmark('https://www.example.com/story'), { artifacts: [artifact()] }).status, 'archived');
  assert.equal(classify(bookmark(), { artifacts: [artifact('https://example.com/other')] }).status, 'unaccounted');
});

test('YouTube is= and short URLs meet at video id without merging distinct videos', () => {
  for (const url of [`${videoUrl}&is=phone`, 'https://youtu.be/abcdefghijk?si=share']) {
    const result = classify(bookmark(url), { artifacts: [artifact(videoUrl, 'mp4')] });
    assert.equal(result.status, 'archived');
    assert.deepEqual(result.matchedBy, ['youtube-id']);
  }
  assert.equal(classify(bookmark(videoUrl), { artifacts: [artifact('https://youtube.com/watch?v=other123456', 'mp4')] }).status, 'unaccounted');
  assert.equal(classify(bookmark(podcastUrl), { artifacts: [artifact(podcastUrl.replace('i=456', 'i=789'), 'mp3')] }).status, 'unaccounted');
});

test('Substack candidate sets bridge open spelling and custom domains in either direction', async () => {
  const open = 'https://open.substack.com/pub/coverage-test/p/some-post?r=reader';
  const custom = 'https://www.coverage-publication.test/p/some-post';
  const candidates = await substackDedupCandidates(open, async () => 'www.coverage-publication.test');
  const keys = coverageUrlKeys(open, candidates);
  const result = classify(bookmark(open), { keys, artifacts: [artifact(custom)] });
  assert.equal(result.status, 'archived');
  assert.deepEqual(result.matchedBy, ['substack']);
  assert.equal(classify(bookmark(custom), { artifacts: [{ ...artifact(open), keys }] }).status, 'archived');
  // An unrelated host with the SAME long slug is accepted only as the weakest
  // match kind, and says so — that is the price of surviving a Substack 429.
  const slugOnly = classify(bookmark(open), { keys, artifacts: [artifact('https://unrelated.test/p/some-post')] });
  assert.equal(slugOnly.status, 'archived');
  assert.deepEqual(slugOnly.matchedBy, ['substack-slug']);
});

test('audit candidate mode never fetches or poisons declaration cache; reuses live mappings', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected source network request'); };
  try {
    const dedup = new BookmarkDeduplicator({});
    const url = 'https://canonical-coverage.test/posts/a-long-article';
    assert.deepEqual(await dedup.dedupCandidates(url, { allowNetwork: false }), [url]);
    let calls = 0;
    await declaredCanonicalCandidates(url, async () => { calls++; return { finalUrl: url, html: `<link rel="canonical" href="${url}?canonical=1">` }; });
    assert.equal(calls, 1, 'cache-only miss must not cache a failed declaration');
    assert.ok((await dedup.dedupCandidates(url, { allowNetwork: false })).includes(`${url}?canonical=1`));
    const candidates = await dedup.dedupCandidates('https://open.substack.com/pub/coverage-test/p/some-post', { allowNetwork: false });
    assert.ok(candidates.includes('https://coverage-publication.test/p/some-post'));
    const unknown = await dedup.dedupCandidates('https://open.substack.com/pub/coverage-never-resolved/p/unknown', { allowNetwork: false });
    assert.ok(unknown.includes('https://coverage-never-resolved.substack.com/p/unknown'));
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('shared artifact counts unique bookmarks and records each file, including video aliases', () => {
  const first = classify(bookmark(), { artifacts: [artifact()] });
  const second = { ...first, bookmarkId: 'b2' };
  const summary = summarizeCoverage([first, second]);
  assert.equal(summary.totals.archived, 2);
  assert.equal(summary.totals.shared_artifact, 2);
  assert.deepEqual(summary.sharedArtifacts, [{ file: artifact().file, bookmarkIds: ['b1', 'b2'] }]);
  const multiUrlVideo = { ...artifact(tweetUrl, 'mp4'), keys: [...coverageUrlKeys(tweetUrl), ...coverageUrlKeys('https://x.com/quote/status/987')] };
  assert.deepEqual(classify(bookmark('https://x.com/quote/status/987'), { artifacts: [multiUrlVideo] }).foundRoles, ['mp4']);
});

test('pagination stops at cutoff, includes boundary, encodes cursor, and deduplicates IDs', async () => {
  const errors = [];
  const cutoff = now - 3 * 24 * HOUR;
  const row = (id, time) => ({ id, createdAt: new Date(time).toISOString() });
  let calls = 0;
  const records = await fetchCoverageBookmarks('https://karakeep.test', 'fake-token', cutoff, errors, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fake-token');
    assert.equal(options.method, undefined);
    assert.equal(url.searchParams.get('limit'), '50');
    calls++;
    if (calls === 1) return Response.json({ bookmarks: [row('new', now)], nextCursor: 'a+b/c' });
    assert.equal(url.searchParams.get('cursor'), 'a+b/c');
    return Response.json({ bookmarks: [row('new', now), row('boundary', cutoff), row('old', cutoff - 1)], nextCursor: 'never' });
  });
  assert.equal(calls, 2);
  assert.deepEqual(records.map(row => row.id), ['new', 'boundary']);
  assert.deepEqual(errors, []);
});

test('pagination failure and page cap retain fetched rows and flag incomplete input', async () => {
  let calls = 0;
  const errors = [];
  const rows = await fetchCoverageBookmarks('https://karakeep.test', 'fake', now - HOUR, errors, async () => {
    calls++;
    if (calls === 2) return new Response('', { status: 503 });
    return Response.json({ bookmarks: [{ id: 'b', createdAt: new Date(now).toISOString() }], nextCursor: 'next' });
  });
  assert.equal(rows.length, 1);
  assert.match(errors[0], /HTTP 503/);
  calls = 0;
  const cappedErrors = [];
  await fetchCoverageBookmarks('https://karakeep.test', 'fake', now - HOUR, cappedErrors, async () => {
    calls++;
    return Response.json({ bookmarks: [], nextCursor: String(calls) });
  });
  assert.equal(calls, 40);
  assert.match(cappedErrors[0], /40-page cap/);
});

function fakeRedis() {
  const hash = {};
  const strings = {};
  let writes = 0;
  return {
    hash, strings, get writes() { return writes; },
    async hgetall() { return { ...hash }; },
    async set(key, value) { strings[key] = value; },
    pipeline() {
      const actions = [];
      const pipeline = {
        hset(_key, field, value) { actions.push(() => { hash[field] = value; writes++; }); return pipeline; },
        hdel(_key, ...fields) { actions.push(() => { for (const field of fields) delete hash[field]; }); return pipeline; },
        async exec() { return actions.map(fn => { fn(); return [null, 1]; }); },
      };
      return pipeline;
    },
  };
}
async function temporaryDirectory(fn) {
  // Stay in the worktree, never use the owner's data/ or the primary checkout.
  const directory = await mkdtemp(path.join(process.cwd(), '.coverage-test-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('artifact scan caches metadata, tolerates corrupt PDFs, sees changed/deleted files', async () => {
  await temporaryDirectory(async directory => {
    const folder = path.join(directory, 'media/2026-W36/pdfs');
    await mkdir(folder, { recursive: true });
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.setSubject(articleUrl);
    const good = path.join(folder, 'good.pdf');
    const bad = path.join(folder, 'bad.pdf');
    await writeFile(good, await doc.save());
    await writeFile(bad, 'not a PDF');
    const redis = fakeRedis();
    const keysFor = async url => coverageUrlKeys(url);
    const errors = [];
    const first = await scanCoverageArtifacts(directory, redis, keysFor, errors);
    assert.equal(first.length, 2);
    assert.equal(classify(bookmark(), { artifacts: first }).status, 'archived');
    assert.equal(errors.length, 1);
    assert.equal(redis.writes, 2);
    const warmErrors = [];
    const warm = await scanCoverageArtifacts(directory, redis, keysFor, warmErrors);
    assert.equal(redis.writes, 2, 'warm scan must not rewrite or parse metadata');
    assert.equal(warmErrors.length, 1, 'cached corrupt files still surface');
    assert.deepEqual(warm, first);
    doc.setSubject('https://example.com/replacement');
    await writeFile(good, await doc.save());
    await utimes(good, new Date(now), new Date(now));
    const changed = await scanCoverageArtifacts(directory, redis, keysFor, []);
    assert.equal(classify(bookmark(), { artifacts: changed }).status, 'unaccounted');
    await unlink(good);
    const deleted = await scanCoverageArtifacts(directory, redis, keysFor, []);
    assert.equal(deleted.length, 1);
    assert.equal(Object.keys(redis.hash).length, 1);
  });
});

test('report persistence keeps 14 dated reports, preserves other files, and stores latest JSON', async () => {
  await temporaryDirectory(async directory => {
    const audit = path.join(directory, 'audit');
    await mkdir(audit);
    for (let day = 1; day <= 16; day++) await writeFile(path.join(audit, `coverage-2026-08-${String(day).padStart(2, '0')}.json`), '{}');
    await writeFile(path.join(audit, 'capture-other.json'), 'untouched');
    const items = [classify()];
    const report = { startedAt: new Date(now).toISOString(), windowDays: 3, cutoff: new Date(now - 3 * 24 * HOUR).toISOString(), items, ...summarizeCoverage(items), complete: true, errors: [] };
    const redis = fakeRedis();
    await persistCoverageReport(report, directory, redis);
    const names = await readdir(audit);
    assert.equal(names.filter(name => name.startsWith('coverage-')).length, 14);
    assert.equal(await readFile(path.join(audit, 'capture-other.json'), 'utf8'), 'untouched');
    assert.deepEqual(JSON.parse(redis.strings['coverage:last-report']), report);
  });
});

test('Discord reports known failures as clean, incomplete scans as warning, caps problems at 15', () => {
  const failed = classify(bookmark(), { jobs: [job(articleUrl, 'failed')] });
  const report = { windowDays: 3, items: [failed], ...summarizeCoverage([failed]), complete: true, errors: [] };
  assert.equal(coverageNotification(report).type, 'info');
  assert.match(coverageNotification(report).title, /clean/);
  assert.equal(coverageNotification({ ...report, complete: false, errors: ['page failed'] }).type, 'warning');
  const items = Array.from({ length: 20 }, (_, index) => ({ ...classify(), bookmarkId: String(index) }));
  const notification = coverageNotification({ ...report, items, ...summarizeCoverage(items) });
  assert.match(notification.title, /20 problems/);
  assert.equal(notification.description.split('\n').length, 15);
});

test('input time budget stops further work and exposes the limitation', async () => {
  const errors = [];
  await fetchCoverageBookmarks('https://karakeep.test', 'fake', now - HOUR, errors,
    async () => { assert.fail('expired budget must not make another request'); }, 0);
  assert.match(errors[0], /time budget/);
  await temporaryDirectory(async directory => {
    const folder = path.join(directory, 'media/2026-W36/pdfs');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'never-parsed.pdf'), 'not a PDF');
    const scanErrors = [];
    const redis = fakeRedis();
    const found = await scanCoverageArtifacts(directory, redis, async () => [], scanErrors, 0);
    assert.deepEqual(found, []);
    assert.equal(redis.writes, 0);
    assert.match(scanErrors[0], /time budget/);
  });
});

test('either persistence destination survives the other failing and records incomplete status', async () => {
  await temporaryDirectory(async directory => {
    const items = [classify()];
    const report = () => ({ startedAt: new Date(now).toISOString(), windowDays: 3, cutoff: new Date(now - 3 * 24 * HOUR).toISOString(), items, ...summarizeCoverage(items), complete: true, errors: [] });
    const redisDown = fakeRedis();
    redisDown.set = async () => { throw new Error('Redis unavailable'); };
    const diskReport = report();
    await persistCoverageReport(diskReport, directory, redisDown);
    assert.equal(diskReport.complete, false);
    const names = await readdir(path.join(directory, 'audit'));
    const stored = JSON.parse(await readFile(path.join(directory, 'audit', names[0]), 'utf8'));
    assert.equal(stored.complete, false);
    assert.match(stored.errors[0], /Redis unavailable/);

    const blocked = path.join(directory, 'not-a-directory');
    await writeFile(blocked, 'block directory creation');
    const redisUp = fakeRedis();
    await persistCoverageReport(report(), blocked, redisUp);
    const latest = JSON.parse(redisUp.strings['coverage:last-report']);
    assert.equal(latest.complete, false);
    assert.match(latest.errors[0], /file persistence/);
  });
});

test('tweet keys are case-insensitive on the handle (x.com/Reuters vs x.com/reuters?s=12)', async () => {
  const { coverageUrlKeys, matchCoverageKeys } = await import('../dist/maintenance/coverage-reconciler.js');
  const bookmark = coverageUrlKeys('https://x.com/Reuters/status/2095823526125252742');
  const artifact = coverageUrlKeys('https://x.com/reuters/status/2095823526125252742?s=12');
  // Share-token spellings are reported as 'no-query' matches by design; what matters is that they match at all.
  assert.ok(matchCoverageKeys(bookmark, artifact), 'case-different handles must still match');
});

test('a manual capture with any artifact is "manual", never "partial"', async () => {
  const { classifyBookmark, coverageUrlKeys } = await import('../dist/maintenance/coverage-reconciler.js');
  const url = 'https://www.youtube.com/watch?v=67M02CnIbtk';
  const keys = coverageUrlKeys(url);
  const item = { url, canonicalUrl: url, guid: 'g', source: 'karakeep', bookmarkedAt: '2026-09-03T03:11:09.000Z' };
  const out = classifyBookmark({ bookmarkId: 'g', createdAt: item.bookmarkedAt, url, item }, {
    now: Date.now(), keys, jobs: [], source: 'manual',
    artifacts: [{ file: 'media/2026-W36/pdfs/youtube.com-watch.pdf', role: 'pdf', keys }],
  });
  assert.equal(out.status, 'manual');
});

test('an unresolved Substack share still matches its custom-domain capture by slug (weakest kind)', async () => {
  const { coverageUrlKeys, matchCoverageKeys } = await import('../dist/maintenance/coverage-reconciler.js');
  const bookmark = coverageUrlKeys('https://open.substack.com/pub/aistopwatch/p/shutting-it-down?r=9qonx&utm_medium=ios', ['https://aistopwatch.substack.com/p/shutting-it-down']);
  const artifact = coverageUrlKeys('https://aistop.watch/p/shutting-it-down');
  assert.equal(matchCoverageKeys(bookmark, artifact), 'substack-slug');
  // Short slugs are too collision-prone to count.
  assert.equal(matchCoverageKeys(coverageUrlKeys('https://open.substack.com/pub/a/p/astra'), coverageUrlKeys('https://b.example/p/astra')), null);
});
