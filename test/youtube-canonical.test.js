import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeYouTubeUrl, normalizeBookmarkUrl } from '../dist/urls/normalizer.js';

const CANON = 'https://youtube.com/watch?v=9_0hs2sxHHo';

// Observed live 2026-08-22: three bookmarks of one video, each share minting
// a fresh is= token, each passing string-level dedup.
test('every share-token and short-link spelling collapses to one canonical', () => {
  const variants = [
    'https://youtube.com/watch?v=9_0hs2sxHHo&is=uvCbh0X4Y3Sfhg6b',
    'https://youtube.com/watch?v=9_0hs2sxHHo&is=7SnXTxHJH1ARv2xW',
    'https://youtube.com/watch?is=-OXEfphs2s3T6-CT&v=9_0hs2sxHHo',
    'https://youtu.be/9_0hs2sxHHo?is=P1kRsQ9_IcUzhK4C',
    'https://youtu.be/9_0hs2sxHHo?si=abc123',
    'https://www.youtube.com/watch?v=9_0hs2sxHHo&t=43s',
    'https://m.youtube.com/watch?v=9_0hs2sxHHo',
  ];
  for (const v of variants) {
    assert.equal(normalizeBookmarkUrl(v), CANON, v);
  }
});

test('shorts, live, and embed paths canonicalize too', () => {
  assert.equal(canonicalizeYouTubeUrl('https://youtube.com/shorts/9_0hs2sxHHo'), CANON);
  assert.equal(canonicalizeYouTubeUrl('https://www.youtube.com/live/9_0hs2sxHHo?feature=share'), CANON);
  assert.equal(canonicalizeYouTubeUrl('https://www.youtube.com/embed/9_0hs2sxHHo'), CANON);
});

test('non-video YouTube URLs fall through to generic normalization', () => {
  assert.equal(canonicalizeYouTubeUrl('https://www.youtube.com/@veritasium'), null);
  assert.equal(canonicalizeYouTubeUrl('https://www.youtube.com/playlist?list=PLx'), null);
  assert.equal(canonicalizeYouTubeUrl('https://www.youtube.com/results?search_query=ai'), null);
  assert.equal(canonicalizeYouTubeUrl('https://youtube.com/watch'), null);
});

test('non-YouTube URLs are untouched by the special case', () => {
  assert.equal(canonicalizeYouTubeUrl('https://example.com/watch?v=9_0hs2sxHHo'), null);
  assert.equal(normalizeBookmarkUrl('https://www.example.com/a?utm_source=x'), 'https://example.com/a');
});
