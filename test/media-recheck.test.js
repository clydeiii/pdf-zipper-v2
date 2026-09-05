import test from 'node:test';
import assert from 'node:assert/strict';
import { needsMediaRecheck, isTweetUrl, mediaJobId } from '../dist/feeds/media-recheck.js';

// Tweets whose Karakeep video asset lands after the first poll are parked
// for a re-check; anything that already has an enclosure, or isn't a tweet,
// must not be.

const base = { canonicalUrl: 'x', guid: 'g', source: 'karakeep', bookmarkedAt: '2026-09-05T00:00:00Z' };

test('a plain tweet link with no enclosure needs a re-check', () => {
  assert.equal(needsMediaRecheck({ ...base, url: 'https://x.com/anthropicai/status/2095947707605266436?s=12' }), true);
  assert.equal(needsMediaRecheck({ ...base, url: 'https://twitter.com/a/status/1' }), true);
});

test('a tweet that already carries a video enclosure does not', () => {
  assert.equal(needsMediaRecheck({ ...base, url: 'https://x.com/a/status/1', enclosure: { url: 'u', type: 'video/mp4' }, mediaType: 'video' }), false);
});

test('non-tweet links never do (YouTube has its own wait loop; articles have no video)', () => {
  assert.equal(needsMediaRecheck({ ...base, url: 'https://www.youtube.com/watch?v=abc' }), false);
  assert.equal(needsMediaRecheck({ ...base, url: 'https://example.com/post' }), false);
  assert.equal(isTweetUrl('https://notx.com/a/status/1'), false);
});

test('mediaJobId matches the metadata worker convention (no colons, canonical-URL keyed)', () => {
  assert.equal(mediaJobId('https://x.com/a/status/1'), 'media-https___x_com_a_status_1');
});
