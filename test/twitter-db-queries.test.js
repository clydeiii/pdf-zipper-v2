import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  getArticleMedia,
  getCapturesForSubjectKind,
  getTweetCard,
  getTweetMedia,
  getTweetPoll,
  getTweetReplies,
  getTwitterStats,
  hasCaptureForSubject,
  insertCapture,
  listLatestTwitterCaptures,
  openTwitterDb,
  upsertArticle,
  upsertImageIndex,
  upsertTweet,
} from '../dist/twitter/db.js';

function tweet(overrides = {}) {
  const id = overrides.id || '100';
  const username = overrides.username || 'alice';
  return {
    id,
    articleId: null,
    username,
    user: {
      username,
      fullname: username === 'alice' ? 'Alice Example' : username,
      verified: null,
      avatarUrl: null,
      avatarFetchUrl: null,
      avatarFile: username === 'alice' ? 'twitter/imagestore/aa/avatar.jpg' : null,
    },
    contentHtml: '<p>Hello database</p>',
    contentText: 'Hello database',
    publishedAt: '2025-01-01T00:00:00.000Z',
    replyToId: null,
    replyToUsers: [],
    quotedId: null,
    retweetedBy: null,
    repliesCount: 1,
    retweetsCount: 2,
    likesCount: 3,
    viewsCount: 4,
    sourceUrl: `https://x.com/${username}/status/${id}`,
    isStub: false,
    media: [],
    card: null,
    poll: [],
    ...overrides,
  };
}

test('viewer query helpers return deduplicated list and relation shapes', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'twitter-query-db-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const db = openTwitterDb({ dataDir });
  t.after(() => db.close());

  upsertTweet(db, tweet({
    media: [{
      position: 0,
      kind: 'photo',
      origUrl: 'https://pbs.twimg.com/media/photo.jpg',
      fetchUrl: null,
      file: 'twitter/imagestore/aa/photo.jpg',
      posterUrl: null,
      posterFetchUrl: null,
      videoUrl: null,
    }],
    card: {
      url: 'https://example.com',
      title: 'Example card',
      description: 'Card description',
      imageUrl: null,
      imageFetchUrl: null,
    },
    poll: [{ optionIndex: 0, label: 'Yes', valuePercent: 75 }],
  }));
  upsertTweet(db, tweet({
    id: '101',
    username: 'bob',
    replyToId: '100',
    contentText: 'A reply',
    contentHtml: 'A reply',
    publishedAt: '2025-01-02T00:00:00.000Z',
  }));
  upsertTweet(db, tweet({
    id: '102',
    articleId: '900',
    card: {
      url: '/i/article/900',
      title: 'Article card',
      description: 'Stored on the parsed tweet, not as a generic DB card',
      imageUrl: null,
      imageFetchUrl: null,
    },
  }));
  upsertArticle(db, {
    id: '900',
    announcingTweetId: '899',
    url: 'https://x.com/alice/article/900',
    authorUsername: 'alice',
    title: 'Structured article',
    previewText: 'Article preview',
    coverImageUrl: null,
    coverImageFetchUrl: null,
    bodyHtml: '<p>Article body</p>',
    bodyText: 'Article body',
    publishedAt: '2025-01-03T00:00:00.000Z',
    harvestedFrom: 'nitter',
    media: [{
      position: 0,
      origUrl: 'https://pbs.twimg.com/media/article.jpg',
      fetchUrl: null,
      file: 'twitter/imagestore/bb/article.jpg',
    }],
  });
  upsertArticle(db, {
    id: '900',
    announcingTweetId: null,
    url: 'https://x.com/alice/article/900',
    authorUsername: null,
    title: null,
    previewText: null,
    coverImageUrl: null,
    coverImageFetchUrl: null,
    bodyHtml: null,
    bodyText: null,
    publishedAt: null,
    harvestedFrom: 'nitter',
    media: [],
  });
  upsertImageIndex(db, {
    url: 'https://pbs.twimg.com/media/photo.jpg',
    file: 'twitter/imagestore/aa/photo.jpg',
    sha256: 'a'.repeat(64),
    bytes: 2048,
    content_type: 'image/jpeg',
    fetched_at: '2025-01-01T00:00:00.000Z',
    error: null,
  });

  insertCapture(db, {
    kind: 'tweet',
    subjectId: '100',
    sourceUrl: 'https://x.com/alice/status/100',
    origin: 'worker',
  }, '2025-01-04T00:00:00.000Z');
  insertCapture(db, {
    kind: 'tweet',
    subjectId: '100',
    sourceUrl: 'https://x.com/alice/status/100',
    pdfPath: 'media/2025-W01/pdfs/x.com-alice-post-100.pdf',
    repliesCaptured: 1,
    origin: 'backfill',
  }, '2025-01-05T00:00:00.000Z');
  insertCapture(db, {
    kind: 'article',
    subjectId: '900',
    sourceUrl: 'https://x.com/alice/article/900',
    origin: 'worker',
  }, '2025-01-06T00:00:00.000Z');

  assert.deepEqual(getTwitterStats(db), {
    tweets: 3,
    users: 2,
    articles: 1,
    captures: 3,
    images: 1,
    imagestoreBytes: 2048,
  });

  const list = listLatestTwitterCaptures(db, { limit: 50, offset: 0 });
  assert.equal(list.total, 2);
  assert.deepEqual(list.items.map((item) => item.subjectId), ['900', '100']);
  assert.equal(list.items[1].fullname, 'Alice Example');
  assert.equal(list.items[1].mediaCount, 1);
  assert.equal(list.items[1].repliesCaptured, 1);
  assert.deepEqual(list.items[1].stats, {
    replies: 1,
    retweets: 2,
    likes: 3,
    views: 4,
  });

  assert.equal(listLatestTwitterCaptures(db, {
    limit: 50,
    offset: 0,
    query: 'structured',
  }).total, 1);
  assert.equal(listLatestTwitterCaptures(db, {
    limit: 50,
    offset: 0,
    query: 'Alice Example',
  }).total, 2);

  assert.equal(getTweetMedia(db, '100').length, 1);
  assert.equal(getTweetCard(db, '100').title, 'Example card');
  assert.equal(getTweetCard(db, '102'), undefined);
  assert.equal(getTweetPoll(db, '100')[0].label, 'Yes');
  assert.deepEqual(getTweetReplies(db, '100').map((row) => row.id), ['101']);
  assert.equal(getArticleMedia(db, '900').length, 1);
  assert.equal(db.prepare('SELECT tweet_id FROM articles WHERE id = ?').get('900').tweet_id, '899');
  assert.equal(getCapturesForSubjectKind(db, 'tweet', '100').length, 2);
  assert.equal(hasCaptureForSubject(db, 'tweet', '100'), true);
  assert.equal(hasCaptureForSubject(db, 'article', '100'), false);
});
