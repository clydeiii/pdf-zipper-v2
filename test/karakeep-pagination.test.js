import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKarakeepFeed, fetchKarakeepBookmarkItem } from '../dist/feeds/parsers/karakeep.js';

const FEED_URL = 'http://karakeep.test?token=abc';

const link = (id, url) => ({
  id,
  createdAt: '2026-09-02T00:00:00.000Z',
  title: id,
  content: { type: 'link', url, title: id },
  assets: [],
});

// Newest first, like the real API. Page 1 has a seen item; a waiting video
// sits on page 2 behind it — exactly the position pagination never reaches.
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
    const u = new URL(url);
    const byId = u.pathname.match(/\/api\/v1\/bookmarks\/([^/]+)$/);
    if (byId) {
      fetched.push(`id:${byId[1]}`);
      if (byId[1] === 'vid1') return { ok: true, status: 200, json: async () => PAGES.c2.bookmarks[1] };
      if (byId[1] === 'flaky') return { ok: false, status: 503, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const cursor = u.searchParams.get('cursor') ?? 'first';
    fetched.push(cursor);
    return { ok: true, status: 200, json: async () => PAGES[cursor] };
  };
  return fetched;
}

const isGuidSeen = async (guid) => guid.startsWith('seen');

test('pagination stops at the first seen item (waiting videos behind it are not reached)', async () => {
  const fetched = stubFetch();
  const result = await parseKarakeepFeed(FEED_URL, undefined, isGuidSeen);
  assert.deepEqual(fetched, ['first']);
  assert.deepEqual(result.items.map((i) => i.guid), ['newA']);
});

test('direct lookup returns the waiting video item by id', async () => {
  const fetched = stubFetch();
  const item = await fetchKarakeepBookmarkItem(FEED_URL, 'vid1');
  assert.deepEqual(fetched, ['id:vid1']);
  assert.equal(item.guid, 'vid1');
  assert.equal(item.url, 'https://www.youtube.com/watch?v=abcdefgh123');
});

test('direct lookup distinguishes deleted (gone) from transient failure (null)', async () => {
  stubFetch();
  assert.equal(await fetchKarakeepBookmarkItem(FEED_URL, 'ghost'), 'gone');
  assert.equal(await fetchKarakeepBookmarkItem(FEED_URL, 'flaky'), null);
});
