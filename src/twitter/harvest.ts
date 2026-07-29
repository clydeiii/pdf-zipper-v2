import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { env } from '../config/env.js';
import {
  getTwitterDb,
  insertCapture,
  upsertArticle,
  upsertTweets,
  type TwitterDatabase,
} from './db.js';
import { storeNitterImage } from './imagestore.js';
import { isNitterErrorPage, parseArticle, parseThreadPage } from './parse.js';
import type {
  ArticleHarvestSummary,
  HarvestArticleOptions,
  HarvestTweetOptions,
  ParsedArticle,
  ParsedTweet,
  TweetHarvestSummary,
} from './types.js';

const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

export type TwitterHarvestErrorCode = 'invalid_url' | 'fetch_failed' | 'error_page' | 'parse_failed' | 'database_failed';

export class TwitterHarvestError extends Error {
  readonly code: TwitterHarvestErrorCode;
  readonly cause?: unknown;

  constructor(code: TwitterHarvestErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'TwitterHarvestError';
    this.code = code;
    this.cause = cause;
  }
}

function twitterPath(url: string): { sourceUrl: string; nitterUrl: string } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') {
      throw new Error('not a Twitter/X host');
    }
    return {
      sourceUrl: url,
      nitterUrl: new URL(parsed.pathname, `${env.NITTER_HOST.replace(/\/+$/, '')}/`).toString(),
    };
  } catch (error) {
    throw new TwitterHarvestError('invalid_url', `Invalid Twitter/X URL: ${url}`, error);
  }
}

function articleId(url: string): string | null {
  try {
    return new URL(url).pathname.match(/\/(?:i\/article|[A-Za-z0-9_]+\/article)\/(\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  return response.text();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueTweets(tweets: ParsedTweet[]): ParsedTweet[] {
  const byId = new Map<string, ParsedTweet>();
  for (const tweet of tweets) {
    const existing = byId.get(tweet.id);
    if (!existing || (existing.isStub && !tweet.isStub)) byId.set(tweet.id, tweet);
  }
  return [...byId.values()];
}

async function findLocalVideo(tweet: ParsedTweet): Promise<string | null> {
  if (!tweet.media.some((media) => media.kind === 'video' || media.kind === 'gif')) return null;
  const mediaRoot = path.join(env.DATA_DIR, 'media');
  let weeks: string[];
  try {
    weeks = await readdir(mediaRoot);
  } catch {
    return null;
  }
  const targets = new Set([
    `x.com-${tweet.username}-post-${tweet.id}.mp4`.toLowerCase(),
    `twitter.com-${tweet.username}-post-${tweet.id}.mp4`.toLowerCase(),
  ]);
  for (const week of weeks) {
    const videosDir = path.join(mediaRoot, week, 'videos');
    let files: string[];
    try {
      files = await readdir(videosDir);
    } catch {
      continue;
    }
    const match = files.find((file) => targets.has(file.toLowerCase()));
    if (match) return match;
  }
  return null;
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index++];
      await callback(current);
    }
  });
  await Promise.all(workers);
}

async function hydrateTweetImages(db: TwitterDatabase, tweets: ParsedTweet[]): Promise<number> {
  let downloaded = 0;
  const jobs: Array<() => Promise<void>> = [];
  for (const tweet of tweets) {
    if (tweet.user.avatarFetchUrl && tweet.user.avatarUrl) {
      jobs.push(async () => {
        const result = await storeNitterImage(tweet.user.avatarFetchUrl!, {
          db,
          sourceUrl: tweet.user.avatarUrl!,
        });
        tweet.user.avatarFile = result.file;
        if (result.downloaded) downloaded++;
      });
    }
    for (const media of tweet.media) {
      if (media.fetchUrl) {
        jobs.push(async () => {
          const result = await storeNitterImage(media.fetchUrl!, {
            db,
            sourceUrl: media.origUrl,
          });
          media.file = result.file;
          if (result.downloaded) downloaded++;
        });
      }
      if (media.posterFetchUrl && media.posterUrl) {
        jobs.push(async () => {
          const result = await storeNitterImage(media.posterFetchUrl!, {
            db,
            sourceUrl: media.posterUrl!,
          });
          media.posterFile = result.file;
          if (result.downloaded) downloaded++;
        });
      }
    }
    if (tweet.card?.imageFetchUrl && tweet.card.imageUrl) {
      jobs.push(async () => {
        const result = await storeNitterImage(tweet.card!.imageFetchUrl!, {
          db,
          sourceUrl: tweet.card!.imageUrl!,
        });
        tweet.card!.imageFile = result.file;
        if (result.downloaded) downloaded++;
      });
    }
  }
  await mapWithConcurrency(jobs, 6, (job) => job());

  await mapWithConcurrency(tweets, 6, async (tweet) => {
    const localVideo = await findLocalVideo(tweet);
    if (!localVideo) return;
    for (const media of tweet.media) {
      if (media.kind === 'video' || media.kind === 'gif') media.localVideo = localVideo;
    }
  });
  return downloaded;
}

export async function harvestTweetToDb(options: HarvestTweetOptions): Promise<TweetHarvestSummary> {
  const { sourceUrl, nitterUrl } = twitterPath(options.url);
  let firstHtml: string;
  try {
    firstHtml = await fetchHtml(nitterUrl);
  } catch (error) {
    throw new TwitterHarvestError('fetch_failed', `Unable to fetch Nitter thread for ${options.url}`, error);
  }
  if (isNitterErrorPage(firstHtml)) {
    throw new TwitterHarvestError('error_page', `Nitter returned an error page for ${options.url}`);
  }

  const pages = [parseThreadPage(firstHtml, sourceUrl)];
  if (!pages[0].mainTweet) {
    throw new TwitterHarvestError('parse_failed', `Nitter page did not contain the subject tweet for ${options.url}`);
  }
  let pagesFetched = 1;
  let cursor = pages[0].nextCursor;
  for (let pageIndex = 0; cursor && pageIndex < env.TWITTER_DB_REPLY_PAGES; pageIndex++) {
    if (env.TWITTER_DB_FETCH_DELAY_MS > 0) await delay(env.TWITTER_DB_FETCH_DELAY_MS);
    try {
      const cursorUrl = new URL(cursor, nitterUrl).toString();
      const html = await fetchHtml(cursorUrl);
      if (isNitterErrorPage(html)) break;
      const page = parseThreadPage(html, sourceUrl);
      pages.push(page);
      pagesFetched++;
      cursor = page.nextCursor;
    } catch {
      // A cursor page is optional once the subject page was successfully parsed.
      break;
    }
  }

  const subject = pages[0].mainTweet;
  const tweets = uniqueTweets(pages.flatMap((page) => [
    ...(page.mainTweet ? [page.mainTweet] : []),
    ...page.ancestors,
    ...page.continuation,
    ...page.replies,
    ...page.quotedTweets,
  ]));
  try {
    const db = getTwitterDb();
    const imagesDownloaded = await hydrateTweetImages(db, tweets);
    upsertTweets(db, tweets);
    const repliesCaptured = new Set(pages.flatMap((page) => page.replies.map((tweet) => tweet.id))).size;
    insertCapture(db, {
      kind: 'tweet',
      subjectId: subject.id,
      sourceUrl,
      bookmarkedAt: options.bookmarkedAt,
      pdfPath: options.pdfPath,
      repliesCaptured,
      pagesFetched,
      origin: options.origin,
    });
    return {
      tweetId: subject.id,
      tweetsUpserted: tweets.length,
      imagesDownloaded,
      pagesFetched,
    };
  } catch (error) {
    if (error instanceof TwitterHarvestError) throw error;
    throw new TwitterHarvestError('database_failed', `Unable to persist Twitter thread for ${options.url}`, error);
  }
}

function fallbackArticle(options: HarvestArticleOptions, id: string): ParsedArticle | null {
  const fallback = options.fallbackContent;
  if (!fallback) return null;
  const title = fallback.title?.trim() || null;
  const bodyHtml = fallback.bodyHtml?.trim() || null;
  const bodyText = fallback.bodyText?.trim() || null;
  if (!title && !bodyHtml && !bodyText) return null;
  return {
    id,
    url: `https://x.com/i/article/${id}`,
    authorUsername: fallback.authorUsername?.replace(/^@/, '').trim() || null,
    title,
    previewText: bodyText?.slice(0, 280) ?? null,
    coverImageUrl: null,
    coverImageFetchUrl: null,
    bodyHtml,
    bodyText,
    publishedAt: null,
    harvestedFrom: 'x.com',
    media: [],
  };
}

async function hydrateArticleImages(db: TwitterDatabase, article: ParsedArticle): Promise<number> {
  let downloaded = 0;
  if (article.coverImageFetchUrl && article.coverImageUrl) {
    const result = await storeNitterImage(article.coverImageFetchUrl, {
      db,
      sourceUrl: article.coverImageUrl,
    });
    article.coverImageFile = result.file;
    if (result.downloaded) downloaded++;
  }
  await mapWithConcurrency(article.media, 6, async (media) => {
    if (!media.fetchUrl) return;
    const result = await storeNitterImage(media.fetchUrl, {
      db,
      sourceUrl: media.origUrl,
    });
    media.file = result.file;
    if (result.downloaded) downloaded++;
  });
  return downloaded;
}

export async function harvestArticleToDb(options: HarvestArticleOptions): Promise<ArticleHarvestSummary> {
  const id = articleId(options.url);
  if (!id) throw new TwitterHarvestError('invalid_url', `Invalid X Article URL: ${options.url}`);
  const { sourceUrl, nitterUrl } = twitterPath(options.url);
  let article: ParsedArticle | null = null;
  let failure: TwitterHarvestError | null = null;
  try {
    const html = await fetchHtml(nitterUrl);
    if (isNitterErrorPage(html)) {
      failure = new TwitterHarvestError('error_page', `Nitter returned an error page for ${options.url}`);
    } else {
      article = parseArticle(html, sourceUrl);
      if (!article) {
        failure = new TwitterHarvestError('parse_failed', `Nitter article renderer had no title or body for ${options.url}`);
      }
    }
  } catch (error) {
    failure = new TwitterHarvestError('fetch_failed', `Unable to fetch Nitter article for ${options.url}`, error);
  }
  article ??= fallbackArticle(options, id);
  if (!article) throw failure ?? new TwitterHarvestError('parse_failed', `No article content for ${options.url}`);

  try {
    const db = getTwitterDb();
    const imagesDownloaded = await hydrateArticleImages(db, article);
    upsertArticle(db, article);
    insertCapture(db, {
      kind: 'article',
      subjectId: id,
      sourceUrl,
      bookmarkedAt: options.bookmarkedAt,
      pdfPath: options.pdfPath,
      pagesFetched: article.harvestedFrom === 'nitter' ? 1 : 0,
      origin: options.origin,
    });
    return {
      articleId: id,
      imagesDownloaded,
      pagesFetched: article.harvestedFrom === 'nitter' ? 1 : 0,
      harvestedFrom: article.harvestedFrom,
    };
  } catch (error) {
    throw new TwitterHarvestError('database_failed', `Unable to persist X Article ${options.url}`, error);
  }
}
