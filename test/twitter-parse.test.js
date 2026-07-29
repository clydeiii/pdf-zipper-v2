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
});

test('canonicalizes internal content links and parses stat edge cases', () => {
  const html = `
    <div class="main-thread"><div class="main-tweet">
      <div class="timeline-item" data-username="alice">
        <div class="tweet-date"><a href="/alice/status/99" title="Jan 2, 2025 · 3:04 PM UTC"></a></div>
        <a class="fullname" title="Alice"></a><a class="username">@alice</a>
        <div class="tweet-content"><a href="/bob">@bob</a><img src="/pic/foo.jpg"> hello</div>
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
  assert.equal(parseStatCount(' 1,234'), 1234);
  assert.equal(parseStatCount(''), null);
});

test('parses a synthetic Nitter article renderer fixture', () => {
  // Synthetic: class names mirror Nitter's article.nim renderer contract.
  const html = `
    <main>
      <h1 class="article-title">A synthetic long-form article</h1>
      <div class="article-author-meta">
        <a href="/alice">@alice</a>
        <time datetime="2026-07-20T10:30:00Z"></time>
      </div>
      <div class="article-cover"><img src="/pic/orig/media%2FCOVER.jpg"></div>
      <p class="article-preview">A short preview.</p>
      <article class="article-body">
        <p>First paragraph with <a href="/bob">Bob</a>.</p>
        <img src="/pic/orig/media%2FBODY.png">
      </article>
    </main>`;
  const article = parseArticle(html, 'https://x.com/i/article/123456789');
  assert.ok(article);
  assert.equal(article.id, '123456789');
  assert.equal(article.authorUsername, 'alice');
  assert.equal(article.title, 'A synthetic long-form article');
  assert.equal(article.publishedAt, '2026-07-20T10:30:00.000Z');
  assert.match(article.bodyHtml, /https:\/\/x\.com\/bob/);
  assert.doesNotMatch(article.bodyHtml, /<img/);
  assert.equal(article.media.length, 1);
  assert.equal(article.coverImageUrl, 'https://pbs.twimg.com/media/COVER.jpg');
});
