import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKarakeepFeed } from '../dist/feeds/parsers/karakeep.js';

const FEED_URL = 'http://karakeep.test?token=abc';

const link = (id, url) => ({
  id,
  createdAt: '2026-09-02T00:00:00.000Z',
  title: id,
  content: { type: 'link', url, title: id },
  assets: [],
});

// Newest first, like the real API. Page 1 has a seen item; the waiting video
// sits on page 2 behind it.
const PAGES = {
  first: {
    bookmarks: [link('newA', 'https://example.com/a'), link('seen1', 'https://example.com/s1')],
    nextCursor: 'c2',
  },
  c2: {
    bookmarks: [link('seen2', 'https://example.com/s2'), link('vid1', 'https://www.youtube.com/watch?v=abcdefgh123')],
    nextCursor: null,
  },
};

function stubFetch() {
  const fetched = [];
  globalThis.fetch = async (url) => {
    const cursor = new URL(url).searchParams.get('cursor') ?? 'first';
    fetched.push(cursor);
    return { ok: true, json: async () => PAGES[cursor] };
  };
  return fetched;
}

const isGuidSeen = async (guid) => guid.startsWith('seen');

test('without pending videos, pagination stops at the first seen item', async () => {
  const fetched = stubFetch();
  const result = await parseKarakeepFeed(FEED_URL, undefined, isGuidSeen);
  assert.deepEqual(fetched, ['first']);
  assert.deepEqual(result.items.map((i) => i.guid), ['newA']);
});

test('pending video GUIDs keep pagination going past seen items until found', async () => {
  const fetched = stubFetch();
  const result = await parseKarakeepFeed(FEED_URL, undefined, isGuidSeen, new Set(['vid1']));
  assert.deepEqual(fetched, ['first', 'c2']);
  assert.deepEqual(result.items.map((i) => i.guid), ['newA', 'vid1']);
  assert.deepEqual(result.missingPendingGuids, []);
});

test('a pending GUID absent from the whole feed is reported missing', async () => {
  stubFetch();
  const result = await parseKarakeepFeed(FEED_URL, undefined, isGuidSeen, new Set(['ghost']));
  assert.deepEqual(result.missingPendingGuids, ['ghost']);
});
