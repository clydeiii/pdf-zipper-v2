import test from 'node:test';
import assert from 'node:assert/strict';
import { isPatreonPostUrl } from '../dist/media/patreon.js';

test('matches Patreon post URLs', () => {
  for (const url of [
    'https://www.patreon.com/AIExplained/posts/opus-5-amodei-165170363',
    'https://patreon.com/AIExplained/posts/glm-5-2-and-nsa-161869508',
    'https://www.patreon.com/AIExplained/posts/kimi-moment-kimi-164108791/',
    'https://www.patreon.com/posts/some-slug-12345',
  ]) {
    assert.equal(isPatreonPostUrl(url), true, `${url} should match`);
  }
});

test('leaves non-post Patreon pages to normal PDF capture', () => {
  for (const url of [
    'https://www.patreon.com/AIExplained',
    'https://www.patreon.com/',
    'https://www.patreon.com/AIExplained/about',
    'https://www.patreon.com/home',
  ]) {
    assert.equal(isPatreonPostUrl(url), false, `${url} should not match`);
  }
});

test('does not match other hosts', () => {
  for (const url of [
    'https://x.com/someone/status/123',
    'https://notpatreon.com/a/posts/b-1',
    'https://patreon.com.evil.example/a/posts/b-1',
    'not a url',
  ]) {
    assert.equal(isPatreonPostUrl(url), false, `${url} should not match`);
  }
});

import { isHostnamePlaceholderTitle } from '../dist/media/video-enrichment.js';

test('a bare-hostname feed title is treated as no title at all', () => {
  // Karakeep can't scrape a member-only post, so it stores "patreon.com".
  // Left alone that beats yt-dlp's real title in every fallback chain.
  assert.equal(isHostnamePlaceholderTitle('patreon.com', 'https://www.patreon.com/AIExplained/posts/x-1'), true);
  assert.equal(isHostnamePlaceholderTitle('Patreon.com', 'https://www.patreon.com/AIExplained/posts/x-1'), true);
  assert.equal(isHostnamePlaceholderTitle('www.patreon.com', 'https://www.patreon.com/AIExplained/posts/x-1'), true);
});

test('a real title is never mistaken for a hostname placeholder', () => {
  assert.equal(
    isHostnamePlaceholderTitle('Opus 5, Amodei, Cryptography', 'https://www.patreon.com/AIExplained/posts/x-1'),
    false,
  );
  assert.equal(isHostnamePlaceholderTitle(undefined, 'https://www.patreon.com/a/posts/b-1'), false);
  assert.equal(isHostnamePlaceholderTitle('patreon.com', 'not a url'), false);
});
