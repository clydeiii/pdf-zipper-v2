import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArticle, parseStatCount, parseThreadPage } from '../dist/twitter/parse.js';

async function fixture(name) {
  return readFile(new URL(`./fixtures/nitter/${name}`, import.meta.url), 'utf8');
}

test('parses jack status and its reply page structure', async () => {
  const parsed = parseThreadPage(
    await fixture('jack-status-20.html'),
    'https://x.com/jack/status/20',
  );

  assert.ok(parsed.mainTweet);
  assert.equal(parsed.mainTweet.id, '20');
  assert.equal(parsed.mainTweet.username, 'jack');
  assert.equal(parsed.mainTweet.publishedAt, '2006-03-21T20:50:00.000Z');
  assert.equal(parsed.mainTweet.contentText, 'just setting up my twttr');
  assert.deepEqual(
    [
      parsed.mainTweet.repliesCount,
      parsed.mainTweet.retweetsCount,
      parsed.mainTweet.likesCount,
      parsed.mainTweet.viewsCount,
    ],
    [17960, 124863, 307941, null],
  );
  assert.equal(parsed.replies.length, 36);
  assert.match(parsed.nextCursor, /^\?cursor=/);

  const photo = parsed.replies.flatMap((tweet) => tweet.media)
    .find((media) => media.kind === 'photo');
  assert.ok(photo);
  assert.match(photo.fetchUrl, /^\/pic\/orig\/media%2F/);
  assert.match(photo.origUrl, /^https:\/\/pbs\.twimg\.com\/media\//);

  const video = parsed.replies.flatMap((tweet) => tweet.media)
    .find((media) => media.kind === 'video');
  assert.ok(video);
  assert.match(video.videoUrl, /^https:\/\/video\.twimg\.com\/.+\.mp4\?/);

  assert.ok(parsed.quotedTweets.length > 0);
  assert.ok(parsed.quotedTweets.every((tweet) => /^\d+$/.test(tweet.id)));
});

test('parses full-resolution main attachments and self-thread/quote edges', async () => {
  const apollo = parseThreadPage(
    await fixture('apollo-thread.html'),
    'https://x.com/ApolloResearch/status/2081805725333082621',
  );
  assert.equal(apollo.mainTweet.media.length, 1);
  assert.equal(apollo.mainTweet.media[0].fetchUrl, '/pic/orig/media%2FHOQOuTAboAAKVNZ.jpg');
  assert.equal(apollo.continuation.length, 4);
  assert.equal(apollo.continuation[0].replyToId, apollo.mainTweet.id);
  assert.equal(apollo.continuation[1].replyToId, apollo.continuation[0].id);

  const gary = parseThreadPage(
    await fixture('garymarcus-thread.html'),
    'https://x.com/GaryMarcus/status/2082159967214489963',
  );
  assert.equal(gary.mainTweet.media.length, 1);
  assert.match(gary.mainTweet.media[0].origUrl, /HOVRRtVbwAAJHsL\.jpg$/);
  assert.equal(gary.mainTweet.quotedId, '2082158585635914104');
  assert.equal(gary.quotedTweets.length, 1);
  assert.equal(gary.quotedTweets[0].id, '2082158585635914104');
  assert.equal(gary.quotedTweets[0].isStub, true);
  assert.deepEqual(gary.quotedTweets[0].links, ['https://chessbench.ai/timeline']);
});

test('extracts real external links in appearance order and de-duplicates them per tweet', async () => {
  const parsed = parseThreadPage(
    await fixture('jack-status-20.html'),
    'https://x.com/jack/status/20',
  );
  const tweets = [
    parsed.mainTweet,
    ...parsed.ancestors,
    ...parsed.continuation,
    ...parsed.replies,
    ...parsed.quotedTweets,
  ].filter(Boolean);
  const linkedTweets = tweets.filter((tweet) => tweet.links.length > 0);

  assert.deepEqual(
    linkedTweets.flatMap((tweet) => tweet.links),
    [
      'https://summit.sfu.ca/item/8129',
      'https://www.newsbreak.com/news/2278004219772/nft-has-entered-the-american-dictionary-yet-many-unknown-pain-points-prevail',
      'https://app.rarible.com/token/0x60f80121c31a0d46b5279700f9df786054aa5ee5:297233:0x1e3c6f4bac19c8b218677a8ba09fcd377518dd52',
    ],
  );
  assert.equal(
    linkedTweets.find((tweet) => tweet.id === '1403995086220709891').links.length,
    1,
  );
  assert.ok(linkedTweets.every((tweet) =>
    tweet.links.every((url) => !/x\.com\/(?:search|[A-Za-z0-9_]+)\/?$/i.test(url))));
});

test('canonicalizes internal content links and parses stat edge cases', () => {
  const html = `
    <div class="main-thread"><div class="main-tweet">
      <div class="timeline-item" data-username="alice">
        <div class="tweet-date"><a href="/alice/status/99" title="Jan 2, 2025 · 3:04 PM UTC"></a></div>
        <a class="fullname" title="Alice"></a><a class="username">@alice</a>
        <div class="tweet-content">
          <a href="/bob">@bob</a>
          <a href="/search?f=tweets&q=%23testing">#testing</a>
          <a href="https://example.com/story">story</a>
          <a href="https://example.com/story">story again</a>
          <a href="https://twitter.com/alice/status/99?s=20">this thread</a>
          <a href="https://x.com/charlie/status/123?s=20">another tweet</a>
          <img src="/pic/foo.jpg"> hello
        </div>
        <div class="tweet-stats">
          <span><span class="icon-heart"></span> 1,234</span>
          <span><span class="icon-views"></span></span>
        </div>
      </div>
    </div>`;
  const parsed = parseThreadPage(html, 'https://x.com/alice/status/99');
  assert.match(parsed.mainTweet.contentHtml, /href="https:\/\/x\.com\/bob"/);
  assert.doesNotMatch(parsed.mainTweet.contentHtml, /<img/);
  assert.equal(parsed.mainTweet.likesCount, 1234);
  assert.equal(parsed.mainTweet.viewsCount, null);
  assert.deepEqual(parsed.mainTweet.links, [
    'https://example.com/story',
    'https://x.com/charlie/status/123?s=20',
  ]);
  assert.equal(parseStatCount(' 1,234'), 1234);
  assert.equal(parseStatCount(''), null);
});

test('parses a real Nitter article card from its announcing tweet', async () => {
  const parsed = parseThreadPage(
    await fixture('loubohan-article-tweet.html'),
    'https://x.com/loubohan/status/2082143914924851449',
  );
  assert.ok(parsed.mainTweet);
  assert.equal(parsed.mainTweet.articleId, '2082143914924851449');
  assert.equal(parsed.mainTweet.card.title, 'How China’s Venture Ecosystem Works');
  assert.match(parsed.mainTweet.card.description, /^I went to China last month/);
});

test('parses a real Nitter article body without author chrome or inline images', async () => {
  const article = parseArticle(
    await fixture('loubohan-article.html'),
    'https://x.com/i/article/2082143914924851449',
  );
  assert.ok(article);
  assert.equal(article.title, 'How China’s Venture Ecosystem Works');
  assert.equal(article.authorUsername, 'loubohan');
  assert.equal(article.coverImageUrl, 'https://pbs.twimg.com/media/HOSuNOXWkAAcN0y.jpg');
  assert.equal(article.announcingTweetId, '2082143914924851449');
  assert.match(article.bodyText, /^I went to China last month/);
  assert.doesNotMatch(article.bodyHtml, /<img/i);
  assert.doesNotMatch(article.bodyHtml, /article-author/);
  assert.doesNotMatch(article.bodyText, /204,477/);
  assert.equal(article.publishedAt, null);
  assert.equal(article.previewText, article.bodyText.slice(0, 280));
});

test('keeps tolerant article date, link, and full-resolution media edge cases', () => {
  const html = `
    <main class="article-page">
      <a href="/pic/orig/pbs.twimg.com%2Fmedia%2FCOVER.jpg">
        <img class="article-cover" src="/pic/pbs.twimg.com%2Fmedia%2FCOVER.jpg%3Fname%3Dsmall">
      </a>
      <article class="article-body">
        <h1 class="article-title">A synthetic long-form article</h1>
        <div class="article-author">
          <a class="username" href="/alice">@alice</a>
          <time datetime="2026-07-20T10:30:00Z"></time>
          <a class="article-date" href="/alice/status/987" title="Jul 20, 2026 · 10:30 AM UTC">9d</a>
        </div>
        <p>First paragraph with <a href="/bob">Bob</a>.</p>
        <a href="/pic/orig/video.twimg.com%2Ftweet_video%2FBODY.mp4">
          <img src="/pic/pbs.twimg.com%2Fmedia%2FBODY.png%3Fname%3Dsmall">
        </a>
      </article>
    </main>`;
  const article = parseArticle(html, 'https://x.com/i/article/123456789');
  assert.ok(article);
  assert.equal(article.id, '123456789');
  assert.equal(article.authorUsername, 'alice');
  assert.equal(article.announcingTweetId, '987');
  assert.equal(article.title, 'A synthetic long-form article');
  assert.equal(article.publishedAt, '2026-07-20T10:30:00.000Z');
  assert.match(article.bodyHtml, /https:\/\/x\.com\/bob/);
  assert.doesNotMatch(article.bodyHtml, /<img/);
  assert.equal(article.media.length, 1);
  assert.equal(article.media[0].origUrl, 'https://video.twimg.com/tweet_video/BODY.mp4');
  assert.equal(article.coverImageUrl, 'https://pbs.twimg.com/media/COVER.jpg');
});
