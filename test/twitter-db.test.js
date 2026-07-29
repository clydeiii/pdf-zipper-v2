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

  assert.equal(db.pragma('user_version', { simple: true }), 3);
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
  assert.equal(db.pragma('user_version', { simple: true }), 3);
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
