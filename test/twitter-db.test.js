import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  insertCapture,
  openTwitterDb,
  upsertTweet,
} from '../dist/twitter/db.js';
import { matchUrlToPdf, upsertTweetLinks } from '../dist/twitter/link-match.js';

function tweet(overrides = {}) {
  return {
    id: '100',
    articleId: null,
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
    links: [],
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

  assert.equal(db.pragma('user_version', { simple: true }), 4);
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

test('migration v2 adds article tweet_id without losing v1 data', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'twitter-db-v1-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, 'twitter.db');
  const v1 = new Database(dbPath);
  v1.exec(`
    CREATE TABLE articles (
      id TEXT PRIMARY KEY,
      title TEXT,
      body_text TEXT
    );
    INSERT INTO articles (id, title, body_text)
    VALUES ('900', 'Existing v1 article', 'Preserve this body');
    CREATE TABLE tweets (
      id TEXT PRIMARY KEY,
      username TEXT,
      updated_at TEXT
    );
    INSERT INTO tweets (id, username, updated_at)
    VALUES ('100', 'alice', '2025-01-01T00:00:00.000Z');
    CREATE TABLE captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      pdf_path TEXT
    );
    INSERT INTO captures (kind, subject_id, captured_at, pdf_path) VALUES
      ('tweet', '100', '2025-01-02T00:00:00.000Z', 'media/2025-W01/pdfs/old.pdf'),
      ('tweet', '100', '2025-01-03T00:00:00.000Z', 'media/2025-W01/pdfs/x.com-alice-post-100.pdf'),
      ('article', '900', '2025-01-02T00:00:00.000Z', 'media/2025-W01/pdfs/x.com-alice-article-900.pdf');
    PRAGMA user_version = 1;
  `);
  v1.close();

  const db = openTwitterDb({ dbPath });
  t.after(() => db.close());
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  assert.ok(db.pragma('table_info(articles)').some((column) => column.name === 'tweet_id'));
  assert.deepEqual(
    db.prepare('SELECT id, title, body_text, tweet_id FROM articles WHERE id = ?').get('900'),
    {
      id: '900',
      title: 'Existing v1 article',
      body_text: 'Preserve this body',
      tweet_id: null,
    },
  );

  // v3 data migration: pdf_path lands on the subject rows, newest capture wins.
  assert.equal(
    db.prepare('SELECT pdf_path FROM tweets WHERE id = ?').get('100').pdf_path,
    'media/2025-W01/pdfs/x.com-alice-post-100.pdf',
  );
  assert.equal(
    db.prepare('SELECT pdf_path FROM articles WHERE id = ?').get('900').pdf_path,
    'media/2025-W01/pdfs/x.com-alice-article-900.pdf',
  );
});

test('matches normalized URLs and preserves existing tweet link matches', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'twitter-db-links-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const db = openTwitterDb({ dataDir });
  t.after(() => db.close());
  upsertTweet(db, tweet());

  const insertPdf = db.prepare(`
    INSERT INTO pdf_index (
      pdf_path, url, url_normalized, url_no_query, mtime_ms, indexed_at
    ) VALUES (?, ?, ?, ?, 1, '2026-01-01T00:00:00.000Z')
  `);
  insertPdf.run(
    'media/2026-W01/pdfs/story.pdf',
    'https://example.com/story',
    'https://example.com/story',
    'https://example.com/story',
  );
  insertPdf.run(
    'media/2026-W01/pdfs/status.pdf',
    'https://twitter.com/alice/status/123',
    'https://twitter.com/alice/status/123',
    'https://twitter.com/alice/status/123',
  );
  insertPdf.run(
    'media/2026-W01/pdfs/short.pdf',
    'https://t.co/abc',
    'https://t.co/abc',
    'https://t.co/abc',
  );

  assert.equal(
    matchUrlToPdf(db, 'https://www.example.com/story/?utm_source=x&s=20'),
    'media/2026-W01/pdfs/story.pdf',
  );
  assert.equal(
    matchUrlToPdf(db, 'https://x.com/alice/status/123?s=20'),
    'media/2026-W01/pdfs/status.pdf',
  );
  assert.equal(matchUrlToPdf(db, 'not a URL'), null);

  await upsertTweetLinks(db, '100', [
    'https://www.example.com/story/?utm_source=x&s=20',
    'https://unmatched.example/path',
    'https://t.co/abc',
  ], {
    resolver: async (url) => url === 'https://t.co/abc'
      ? 'https://expanded.example/article'
      : url,
    timestamp: '2026-01-02T00:00:00.000Z',
  });
  let rows = db.prepare(
    'SELECT position, url, pdf_path, matched_at FROM tweet_links WHERE tweet_id = ? ORDER BY position',
  ).all('100');
  assert.deepEqual(rows, [
    {
      position: 0,
      url: 'https://www.example.com/story/?utm_source=x&s=20',
      pdf_path: 'media/2026-W01/pdfs/story.pdf',
      matched_at: '2026-01-02T00:00:00.000Z',
    },
    {
      position: 1,
      url: 'https://unmatched.example/path',
      pdf_path: null,
      matched_at: null,
    },
    {
      position: 2,
      url: 'https://expanded.example/article',
      pdf_path: 'media/2026-W01/pdfs/short.pdf',
      matched_at: '2026-01-02T00:00:00.000Z',
    },
  ]);

  db.prepare('DELETE FROM pdf_index').run();
  await upsertTweetLinks(db, '100', [
    'https://www.example.com/story/?utm_source=x&s=20',
    'https://different.example/path',
  ], {
    resolver: async (url) => url,
    timestamp: '2026-01-03T00:00:00.000Z',
  });
  await upsertTweetLinks(db, '100', []);
  rows = db.prepare(
    'SELECT position, url, pdf_path, matched_at FROM tweet_links WHERE tweet_id = ? ORDER BY position',
  ).all('100');
  assert.deepEqual(rows, [
    {
      position: 0,
      url: 'https://www.example.com/story/?utm_source=x&s=20',
      pdf_path: 'media/2026-W01/pdfs/story.pdf',
      matched_at: '2026-01-02T00:00:00.000Z',
    },
    {
      position: 1,
      url: 'https://different.example/path',
      pdf_path: null,
      matched_at: null,
    },
  ]);
});

test('insertCapture stamps pdf_path onto the subject row; latest capture wins', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'twitter-db-pdf-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const db = openTwitterDb({ dataDir });
  t.after(() => db.close());

  upsertTweet(db, tweet(), '2025-01-01T01:00:00.000Z');
  insertCapture(db, {
    kind: 'tweet',
    subjectId: '100',
    sourceUrl: 'https://x.com/alice/status/100',
    pdfPath: 'media/2025-W01/pdfs/x.com-alice-post-100.pdf',
    origin: 'worker',
  }, '2025-01-02T00:00:00.000Z');
  assert.equal(
    db.prepare('SELECT pdf_path FROM tweets WHERE id = ?').get('100').pdf_path,
    'media/2025-W01/pdfs/x.com-alice-post-100.pdf',
  );

  // A rerun that renamed the PDF replaces the stored name.
  insertCapture(db, {
    kind: 'tweet',
    subjectId: '100',
    sourceUrl: 'https://x.com/alice/status/100',
    pdfPath: 'media/2025-W02/pdfs/x.com-alice-post-100-renamed.pdf',
    origin: 'worker',
  }, '2025-01-09T00:00:00.000Z');
  assert.equal(
    db.prepare('SELECT pdf_path FROM tweets WHERE id = ?').get('100').pdf_path,
    'media/2025-W02/pdfs/x.com-alice-post-100-renamed.pdf',
  );

  // A capture without a PDF (e.g. backfill with pruned bins) keeps the last name.
  insertCapture(db, {
    kind: 'tweet',
    subjectId: '100',
    sourceUrl: 'https://x.com/alice/status/100',
    origin: 'backfill',
  }, '2025-01-10T00:00:00.000Z');
  assert.equal(
    db.prepare('SELECT pdf_path FROM tweets WHERE id = ?').get('100').pdf_path,
    'media/2025-W02/pdfs/x.com-alice-post-100-renamed.pdf',
  );
});
