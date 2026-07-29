import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  insertCapture,
  openTwitterDb,
  upsertTweet,
} from '../dist/twitter/db.js';

function tweet(overrides = {}) {
  return {
    id: '100',
    username: 'alice',
    user: {
      username: 'alice',
      fullname: 'Alice',
      verified: 'blue',
      avatarUrl: null,
      avatarFetchUrl: null,
    },
    contentHtml: '<p>Hello</p>',
    contentText: 'Hello',
    publishedAt: '2025-01-01T00:00:00.000Z',
    replyToId: null,
    replyToUsers: [],
    quotedId: null,
    retweetedBy: null,
    repliesCount: 1,
    retweetsCount: 2,
    likesCount: 3,
    viewsCount: 4,
    sourceUrl: 'https://x.com/alice/status/100',
    isStub: false,
    media: [],
    card: null,
    poll: [],
    ...overrides,
  };
}

test('migrates from scratch and preserves upsert invariants', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'twitter-db-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const db = openTwitterDb({ dataDir });
  t.after(() => db.close());

  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

  upsertTweet(db, tweet(), '2025-01-01T01:00:00.000Z');
  upsertTweet(db, tweet({
    contentHtml: null,
    contentText: null,
    repliesCount: 9,
    likesCount: 12,
    viewsCount: null,
  }), '2025-01-02T01:00:00.000Z');

  const row = db.prepare('SELECT * FROM tweets WHERE id = ?').get('100');
  assert.equal(row.first_seen_at, '2025-01-01T01:00:00.000Z');
  assert.equal(row.updated_at, '2025-01-02T01:00:00.000Z');
  assert.equal(row.content_text, 'Hello');
  assert.equal(row.replies_count, 9);
  assert.equal(row.likes_count, 12);
  assert.equal(row.views_count, 4);

  upsertTweet(db, tweet({
    id: '200',
    contentHtml: null,
    contentText: null,
    publishedAt: null,
    isStub: true,
    sourceUrl: 'https://x.com/alice/status/200',
  }), '2025-01-01T00:00:00.000Z');
  upsertTweet(db, tweet({
    id: '200',
    contentText: 'Now fully harvested',
    contentHtml: 'Now fully harvested',
    isStub: false,
    sourceUrl: 'https://x.com/alice/status/200',
  }), '2025-01-03T00:00:00.000Z');

  const promoted = db.prepare('SELECT is_stub, content_text, first_seen_at FROM tweets WHERE id = ?').get('200');
  assert.equal(promoted.is_stub, 0);
  assert.equal(promoted.content_text, 'Now fully harvested');
  assert.equal(promoted.first_seen_at, '2025-01-01T00:00:00.000Z');

  const captureId = insertCapture(db, {
    kind: 'tweet',
    subjectId: '100',
    sourceUrl: 'https://x.com/alice/status/100',
    bookmarkedAt: '2025-01-01T00:00:00.000Z',
    pdfPath: 'media/2025-W01/pdfs/x.com-alice-post-100.pdf',
    repliesCaptured: 36,
    pagesFetched: 2,
    origin: 'manual',
  }, '2025-01-04T00:00:00.000Z');
  assert.ok(captureId > 0);
  const capture = db.prepare('SELECT * FROM captures WHERE id = ?').get(captureId);
  assert.equal(capture.subject_id, '100');
  assert.equal(capture.replies_captured, 36);
  assert.equal(capture.pages_fetched, 2);
});
