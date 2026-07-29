import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { env } from '../config/env.js';
import type {
  ImageIndexRow,
  ParsedArticle,
  ParsedTweet,
  ParsedUser,
} from './types.js';

export type TwitterDatabase = Database.Database;

const SCHEMA_VERSION = 1;

const MIGRATION_V1 = `
CREATE TABLE users (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  fullname TEXT,
  verified TEXT,
  avatar_url TEXT,
  avatar_file TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tweets (
  id TEXT PRIMARY KEY,
  username TEXT REFERENCES users(username),
  content_html TEXT,
  content_text TEXT,
  published_at TEXT,
  reply_to_id TEXT REFERENCES tweets(id),
  reply_to_users TEXT,
  quoted_id TEXT REFERENCES tweets(id),
  retweeted_by TEXT,
  replies_count INTEGER,
  retweets_count INTEGER,
  likes_count INTEGER,
  views_count INTEGER,
  stats_updated_at TEXT,
  source_url TEXT,
  is_stub INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tweet_media (
  tweet_id TEXT NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'gif', 'card-image')),
  orig_url TEXT,
  file TEXT,
  poster_file TEXT,
  video_url TEXT,
  local_video TEXT,
  PRIMARY KEY (tweet_id, position)
);

CREATE TABLE tweet_cards (
  tweet_id TEXT PRIMARY KEY REFERENCES tweets(id) ON DELETE CASCADE,
  url TEXT,
  title TEXT,
  description TEXT,
  image_file TEXT
);

CREATE TABLE tweet_polls (
  tweet_id TEXT NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  label TEXT,
  value_percent REAL,
  PRIMARY KEY (tweet_id, option_index)
);

CREATE TABLE captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('tweet', 'article')),
  subject_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  bookmarked_at TEXT,
  captured_at TEXT NOT NULL,
  pdf_path TEXT,
  replies_captured INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL CHECK (origin IN ('worker', 'backfill', 'manual'))
);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  author_username TEXT,
  title TEXT,
  preview_text TEXT,
  cover_image_url TEXT,
  cover_image_file TEXT,
  body_html TEXT,
  body_text TEXT,
  published_at TEXT,
  harvested_from TEXT NOT NULL CHECK (harvested_from IN ('nitter', 'x.com')),
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE article_media (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  orig_url TEXT,
  file TEXT,
  PRIMARY KEY (article_id, position)
);

CREATE TABLE images (
  url TEXT PRIMARY KEY,
  file TEXT,
  sha256 TEXT,
  bytes INTEGER,
  content_type TEXT,
  fetched_at TEXT NOT NULL,
  error TEXT
);

CREATE INDEX idx_tweets_username ON tweets(username);
CREATE INDEX idx_tweets_published_at ON tweets(published_at);
CREATE INDEX idx_tweets_reply_to_id ON tweets(reply_to_id);
CREATE INDEX idx_tweets_quoted_id ON tweets(quoted_id);
CREATE INDEX idx_captures_subject_id ON captures(subject_id);
`;

let singleton: TwitterDatabase | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function nullable(value: string | null | undefined): string | null {
  return value && value.trim() ? value : null;
}

export function openTwitterDb(options: { dataDir?: string; dbPath?: string } = {}): TwitterDatabase {
  const dbPath = options.dbPath ?? path.join(options.dataDir ?? env.DATA_DIR, 'twitter', 'twitter.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`Twitter database schema ${version} is newer than supported version ${SCHEMA_VERSION}`);
  }
  if (version === 0) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATION_V1);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  return db;
}

export function getTwitterDb(): TwitterDatabase {
  singleton ??= openTwitterDb();
  return singleton;
}

export function closeTwitterDb(): void {
  if (!singleton) return;
  singleton.close();
  singleton = null;
}

export function upsertUser(db: TwitterDatabase, user: ParsedUser, timestamp = nowIso()): void {
  db.prepare(`
    INSERT INTO users (
      username, fullname, verified, avatar_url, avatar_file, first_seen_at, updated_at
    ) VALUES (
      @username, @fullname, @verified, @avatarUrl, @avatarFile, @timestamp, @timestamp
    )
    ON CONFLICT(username) DO UPDATE SET
      fullname = COALESCE(excluded.fullname, users.fullname),
      verified = COALESCE(excluded.verified, users.verified),
      avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
      avatar_file = COALESCE(excluded.avatar_file, users.avatar_file),
      updated_at = excluded.updated_at
  `).run({
    username: user.username,
    fullname: nullable(user.fullname),
    verified: nullable(user.verified),
    avatarUrl: nullable(user.avatarUrl),
    avatarFile: nullable(user.avatarFile),
    timestamp,
  });
}

function ensureTweetReferenceStubs(db: TwitterDatabase, tweet: ParsedTweet, timestamp: string): void {
  const insert = db.prepare(`
    INSERT INTO tweets (id, source_url, is_stub, first_seen_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  if (tweet.replyToId) {
    insert.run(tweet.replyToId, `https://x.com/i/status/${tweet.replyToId}`, timestamp, timestamp);
  }
  if (tweet.quotedId) {
    insert.run(tweet.quotedId, `https://x.com/i/status/${tweet.quotedId}`, timestamp, timestamp);
  }
}

export function upsertTweet(db: TwitterDatabase, tweet: ParsedTweet, timestamp = nowIso()): void {
  upsertUser(db, tweet.user, timestamp);
  ensureTweetReferenceStubs(db, tweet, timestamp);
  db.prepare(`
    INSERT INTO tweets (
      id, username, content_html, content_text, published_at, reply_to_id,
      reply_to_users, quoted_id, retweeted_by, replies_count, retweets_count,
      likes_count, views_count, stats_updated_at, source_url, is_stub,
      first_seen_at, updated_at
    ) VALUES (
      @id, @username, @contentHtml, @contentText, @publishedAt, @replyToId,
      @replyToUsers, @quotedId, @retweetedBy, @repliesCount, @retweetsCount,
      @likesCount, @viewsCount, @timestamp, @sourceUrl, @isStub,
      @timestamp, @timestamp
    )
    ON CONFLICT(id) DO UPDATE SET
      username = COALESCE(excluded.username, tweets.username),
      content_html = COALESCE(excluded.content_html, tweets.content_html),
      content_text = COALESCE(excluded.content_text, tweets.content_text),
      published_at = COALESCE(excluded.published_at, tweets.published_at),
      reply_to_id = COALESCE(excluded.reply_to_id, tweets.reply_to_id),
      reply_to_users = COALESCE(excluded.reply_to_users, tweets.reply_to_users),
      quoted_id = COALESCE(excluded.quoted_id, tweets.quoted_id),
      retweeted_by = COALESCE(excluded.retweeted_by, tweets.retweeted_by),
      replies_count = COALESCE(excluded.replies_count, tweets.replies_count),
      retweets_count = COALESCE(excluded.retweets_count, tweets.retweets_count),
      likes_count = COALESCE(excluded.likes_count, tweets.likes_count),
      views_count = COALESCE(excluded.views_count, tweets.views_count),
      stats_updated_at = excluded.stats_updated_at,
      source_url = COALESCE(excluded.source_url, tweets.source_url),
      is_stub = MIN(tweets.is_stub, excluded.is_stub),
      updated_at = excluded.updated_at
  `).run({
    id: tweet.id,
    username: nullable(tweet.username),
    contentHtml: nullable(tweet.contentHtml),
    contentText: nullable(tweet.contentText),
    publishedAt: nullable(tweet.publishedAt),
    replyToId: nullable(tweet.replyToId),
    replyToUsers: tweet.replyToUsers.length ? JSON.stringify(tweet.replyToUsers) : null,
    quotedId: nullable(tweet.quotedId),
    retweetedBy: nullable(tweet.retweetedBy),
    repliesCount: tweet.repliesCount,
    retweetsCount: tweet.retweetsCount,
    likesCount: tweet.likesCount,
    viewsCount: tweet.viewsCount,
    sourceUrl: nullable(tweet.sourceUrl),
    isStub: tweet.isStub ? 1 : 0,
    timestamp,
  });

  const mediaStatement = db.prepare(`
    INSERT INTO tweet_media (
      tweet_id, position, kind, orig_url, file, poster_file, video_url, local_video
    ) VALUES (
      @tweetId, @position, @kind, @origUrl, @file, @posterFile, @videoUrl, @localVideo
    )
    ON CONFLICT(tweet_id, position) DO UPDATE SET
      kind = excluded.kind,
      orig_url = COALESCE(excluded.orig_url, tweet_media.orig_url),
      file = COALESCE(excluded.file, tweet_media.file),
      poster_file = COALESCE(excluded.poster_file, tweet_media.poster_file),
      video_url = COALESCE(excluded.video_url, tweet_media.video_url),
      local_video = COALESCE(excluded.local_video, tweet_media.local_video)
  `);
  for (const media of tweet.media) {
    mediaStatement.run({
      tweetId: tweet.id,
      position: media.position,
      kind: media.kind,
      origUrl: nullable(media.origUrl),
      file: nullable(media.file),
      posterFile: nullable(media.posterFile),
      videoUrl: nullable(media.videoUrl),
      localVideo: nullable(media.localVideo),
    });
  }

  if (tweet.card) {
    db.prepare(`
      INSERT INTO tweet_cards (tweet_id, url, title, description, image_file)
      VALUES (@tweetId, @url, @title, @description, @imageFile)
      ON CONFLICT(tweet_id) DO UPDATE SET
        url = COALESCE(excluded.url, tweet_cards.url),
        title = COALESCE(excluded.title, tweet_cards.title),
        description = COALESCE(excluded.description, tweet_cards.description),
        image_file = COALESCE(excluded.image_file, tweet_cards.image_file)
    `).run({
      tweetId: tweet.id,
      url: nullable(tweet.card.url),
      title: nullable(tweet.card.title),
      description: nullable(tweet.card.description),
      imageFile: nullable(tweet.card.imageFile),
    });
  }

  const pollStatement = db.prepare(`
    INSERT INTO tweet_polls (tweet_id, option_index, label, value_percent)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tweet_id, option_index) DO UPDATE SET
      label = COALESCE(excluded.label, tweet_polls.label),
      value_percent = COALESCE(excluded.value_percent, tweet_polls.value_percent)
  `);
  for (const option of tweet.poll) {
    pollStatement.run(tweet.id, option.optionIndex, option.label, option.valuePercent);
  }
}

export function upsertTweets(db: TwitterDatabase, tweets: ParsedTweet[], timestamp = nowIso()): void {
  db.transaction((items: ParsedTweet[]) => {
    // Quote/reference stubs must exist before tweets that point at them.
    for (const tweet of items.filter((item) => item.isStub)) upsertTweet(db, tweet, timestamp);
    for (const tweet of items.filter((item) => !item.isStub)) upsertTweet(db, tweet, timestamp);
  })(tweets);
}

export function upsertArticle(db: TwitterDatabase, article: ParsedArticle, timestamp = nowIso()): void {
  db.prepare(`
    INSERT INTO articles (
      id, url, author_username, title, preview_text, cover_image_url,
      cover_image_file, body_html, body_text, published_at, harvested_from,
      first_seen_at, updated_at
    ) VALUES (
      @id, @url, @authorUsername, @title, @previewText, @coverImageUrl,
      @coverImageFile, @bodyHtml, @bodyText, @publishedAt, @harvestedFrom,
      @timestamp, @timestamp
    )
    ON CONFLICT(id) DO UPDATE SET
      url = COALESCE(excluded.url, articles.url),
      author_username = COALESCE(excluded.author_username, articles.author_username),
      title = COALESCE(excluded.title, articles.title),
      preview_text = COALESCE(excluded.preview_text, articles.preview_text),
      cover_image_url = COALESCE(excluded.cover_image_url, articles.cover_image_url),
      cover_image_file = COALESCE(excluded.cover_image_file, articles.cover_image_file),
      body_html = COALESCE(excluded.body_html, articles.body_html),
      body_text = COALESCE(excluded.body_text, articles.body_text),
      published_at = COALESCE(excluded.published_at, articles.published_at),
      harvested_from = CASE
        WHEN articles.harvested_from = 'nitter' THEN 'nitter'
        ELSE excluded.harvested_from
      END,
      updated_at = excluded.updated_at
  `).run({
    id: article.id,
    url: article.url,
    authorUsername: nullable(article.authorUsername),
    title: nullable(article.title),
    previewText: nullable(article.previewText),
    coverImageUrl: nullable(article.coverImageUrl),
    coverImageFile: nullable(article.coverImageFile),
    bodyHtml: nullable(article.bodyHtml),
    bodyText: nullable(article.bodyText),
    publishedAt: nullable(article.publishedAt),
    harvestedFrom: article.harvestedFrom,
    timestamp,
  });

  const statement = db.prepare(`
    INSERT INTO article_media (article_id, position, orig_url, file)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(article_id, position) DO UPDATE SET
      orig_url = COALESCE(excluded.orig_url, article_media.orig_url),
      file = COALESCE(excluded.file, article_media.file)
  `);
  for (const media of article.media) {
    statement.run(article.id, media.position, nullable(media.origUrl), nullable(media.file));
  }
}

export interface CaptureInput {
  kind: 'tweet' | 'article';
  subjectId: string;
  sourceUrl: string;
  bookmarkedAt?: string | Date;
  pdfPath?: string;
  repliesCaptured?: number;
  pagesFetched?: number;
  origin: 'worker' | 'backfill' | 'manual';
}

export function insertCapture(db: TwitterDatabase, capture: CaptureInput, capturedAt = nowIso()): number {
  const result = db.prepare(`
    INSERT INTO captures (
      kind, subject_id, source_url, bookmarked_at, captured_at, pdf_path,
      replies_captured, pages_fetched, origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    capture.kind,
    capture.subjectId,
    capture.sourceUrl,
    capture.bookmarkedAt instanceof Date ? capture.bookmarkedAt.toISOString() : capture.bookmarkedAt ?? null,
    capturedAt,
    capture.pdfPath ?? null,
    capture.repliesCaptured ?? 0,
    capture.pagesFetched ?? 0,
    capture.origin,
  );
  return Number(result.lastInsertRowid);
}

export function getImageIndex(db: TwitterDatabase, url: string): ImageIndexRow | undefined {
  return db.prepare('SELECT * FROM images WHERE url = ?').get(url) as ImageIndexRow | undefined;
}

export function upsertImageIndex(db: TwitterDatabase, image: ImageIndexRow): void {
  db.prepare(`
    INSERT INTO images (url, file, sha256, bytes, content_type, fetched_at, error)
    VALUES (@url, @file, @sha256, @bytes, @content_type, @fetched_at, @error)
    ON CONFLICT(url) DO UPDATE SET
      file = excluded.file,
      sha256 = excluded.sha256,
      bytes = excluded.bytes,
      content_type = excluded.content_type,
      fetched_at = excluded.fetched_at,
      error = excluded.error
  `).run(image);
}

export function getTweetById(db: TwitterDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM tweets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

export function getUserByUsername(
  db: TwitterDatabase,
  username: string,
): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined;
}

export function getArticleById(db: TwitterDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

export function getCapturesForSubject(
  db: TwitterDatabase,
  subjectId: string,
): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM captures WHERE subject_id = ? ORDER BY id').all(subjectId) as Array<Record<string, unknown>>;
}
