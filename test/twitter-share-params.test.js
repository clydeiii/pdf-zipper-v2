import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBookmarkUrl, stripTwitterShareParams } from '../dist/urls/normalizer.js';

test('iOS and laptop spellings of the same tweet share one dedup key', () => {
  const ios = normalizeBookmarkUrl('https://x.com/JaredKubin/status/2094136005435564399?s=20');
  const laptop = normalizeBookmarkUrl('https://x.com/JaredKubin/status/2094136005435564399');
  assert.equal(ios, laptop);
  const withToken = normalizeBookmarkUrl('https://x.com/theojaffee/status/2094196190778900892?s=46&t=Ab3dEfG');
  assert.equal(withToken, normalizeBookmarkUrl('https://x.com/theojaffee/status/2094196190778900892'));
});

test('twitter.com and mobile hosts are covered', () => {
  assert.equal(
    stripTwitterShareParams('https://twitter.com/a/status/123?s=20'),
    'https://twitter.com/a/status/123'
  );
  assert.equal(
    stripTwitterShareParams('https://mobile.twitter.com/a/status/123?t=xyz'),
    'https://mobile.twitter.com/a/status/123'
  );
});

test('s and t params on other hosts are untouched', () => {
  assert.equal(stripTwitterShareParams('https://example.com/page?s=important&t=42'),
    'https://example.com/page?s=important&t=42');
  assert.ok(normalizeBookmarkUrl('https://example.com/page?s=important').includes('s=important'));
});

test('other x.com query params survive', () => {
  assert.equal(
    stripTwitterShareParams('https://x.com/search?q=hello&s=20'),
    'https://x.com/search?q=hello'
  );
});

test('FT gift-link params never reach the dedup key', async () => {
  const { stripFtShareParams } = await import('../dist/urls/normalizer.js');
  const gift = 'https://www.ft.com/content/f100c90b-c138-4125-aaa7-853b77690db9?accessToken=zwAAAaBMm1&sharetype=gift&token=0062664e-51e4&syn-25a6b1a6=1';
  assert.equal(stripFtShareParams(gift), 'https://www.ft.com/content/f100c90b-c138-4125-aaa7-853b77690db9');
  assert.equal(normalizeBookmarkUrl(gift), normalizeBookmarkUrl('https://www.ft.com/content/f100c90b-c138-4125-aaa7-853b77690db9'));
  // token/accessToken on other hosts are untouched
  assert.equal(stripFtShareParams('https://example.com/x?token=keep'), 'https://example.com/x?token=keep');
});
