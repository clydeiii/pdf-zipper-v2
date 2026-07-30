import { Router, type Request, type Response } from 'express';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { load } from 'cheerio';
import { env } from '../../config/env.js';
import {
  getArticleById,
  getArticleByTweetId,
  getArticleMedia,
  getCapturesForSubjectKind,
  getTweetById,
  getTweetCard,
  getTweetMedia,
  getTweetLinks,
  getTweetPoll,
  getTweetReplies,
  getTwitterDb,
  getTwitterStats,
  getUserByUsername,
  listLatestTwitterCaptures,
  type TwitterDatabase,
  type TwitterStats,
} from '../../twitter/db.js';

export const twitterRouter = Router();

type DbRow = Record<string, unknown>;
const SAFE_HTML_ELEMENTS = new Set([
  'p', 'br', 'div', 'span', 'a', 'b', 'strong', 'i', 'em', 'u', 's',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'figure', 'figcaption', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'sub', 'sup', 'small',
]);
const SAFE_HTML_ATTRIBUTES = new Set(['title', 'dir', 'lang', 'colspan', 'rowspan']);
const VIDEO_INDEX_TTL_MS = 60_000;
let cachedVideoIndex: { expiresAt: number; index: Map<string, string> } | null = null;

const EMPTY_STATS: TwitterStats = {
  tweets: 0,
  users: 0,
  articles: 0,
  captures: 0,
  images: 0,
  imagestoreBytes: 0,
};

/**
 * Nitter escapes tweet text before placing it in these fragments. This pass is
 * deliberately independent of that guarantee so a poisoned historic row
 * cannot introduce active content into the viewer.
 */
export function sanitizeTwitterHtml(html: unknown): string | null {
  if (typeof html !== 'string' || !html.trim()) return null;
  const $ = load(html, null, false);

  $('*').each((_index, element) => {
    if (!('name' in element) || !element.name || !('attribs' in element)) return;
    const name = element.name.toLowerCase();
    if (!SAFE_HTML_ELEMENTS.has(name)) {
      $(element).replaceWith($(element).contents());
      return;
    }

    for (const [attribute, rawValue] of Object.entries(element.attribs ?? {})) {
      const normalizedAttribute = attribute.toLowerCase();
      if (normalizedAttribute === 'href' && name === 'a') {
        const cleaned = rawValue.replace(/[\u0000-\u0020\u007f]/g, '');
        try {
          const resolved = new URL(cleaned, 'https://sanitizer.invalid/');
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            $(element).attr(attribute, cleaned);
            continue;
          }
        } catch {
          // Invalid hrefs are removed below.
        }
      } else if (SAFE_HTML_ATTRIBUTES.has(normalizedAttribute)) {
        continue;
      }
      $(element).removeAttr(attribute);
    }
  });
  return $.root().html() || null;
}

function integerQuery(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Number.parseInt(value, 10)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingDatabaseError(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException & { code?: string };
  return candidate?.code === 'ENOENT'
    || candidate?.code === 'SQLITE_CANTOPEN'
    || /unable to open database file/i.test(errorMessage(error));
}

async function localVideoIndex(): Promise<Map<string, string>> {
  const now = Date.now();
  if (cachedVideoIndex && cachedVideoIndex.expiresAt > now) {
    return cachedVideoIndex.index;
  }
  const index = new Map<string, string>();
  const mediaRoot = path.join(env.DATA_DIR, 'media');
  let entries;
  try {
    entries = await readdir(mediaRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cachedVideoIndex = { expiresAt: now + VIDEO_INDEX_TTL_MS, index };
      return index;
    }
    throw error;
  }

  const weeks = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
  for (const week of weeks) {
    let files;
    try {
      files = await readdir(path.join(mediaRoot, week, 'videos'), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files) {
      if (!file.isFile()) continue;
      const key = file.name.toLowerCase();
      if (!index.has(key)) {
        index.set(key, path.posix.join('media', week, 'videos', file.name));
      }
    }
  }
  cachedVideoIndex = { expiresAt: now + VIDEO_INDEX_TTL_MS, index };
  return index;
}

function mediaWithLocalPaths(
  db: TwitterDatabase,
  tweetId: string,
  username: string | null,
  videos: Map<string, string>,
): DbRow[] {
  return getTweetMedia(db, tweetId).map((media) => {
    const localVideo = typeof media.local_video === 'string' ? media.local_video : null;
    let localVideoPath = localVideo
      ? videos.get(path.basename(localVideo).toLowerCase()) ?? null
      : null;
    // The MP4 usually lands via media-collection AFTER the tweet harvest ran,
    // so local_video is often NULL in the row. Resolve at read time from the
    // shared filename convention instead of requiring a re-harvest.
    if (!localVideoPath && username && (media.kind === 'video' || media.kind === 'gif')) {
      localVideoPath = videos.get(`x.com-${username}-post-${tweetId}.mp4`.toLowerCase())
        ?? videos.get(`twitter.com-${username}-post-${tweetId}.mp4`.toLowerCase())
        ?? null;
    }
    return { ...media, localVideoPath };
  });
}

function tweetView(
  db: TwitterDatabase,
  tweet: DbRow,
  videos: Map<string, string>,
  includeExtras = false,
): DbRow {
  const id = String(tweet.id);
  const username = typeof tweet.username === 'string' ? tweet.username : null;
  return {
    ...tweet,
    content_html: sanitizeTwitterHtml(tweet.content_html),
    community_note_html: sanitizeTwitterHtml(tweet.community_note_html),
    user: username ? getUserByUsername(db, username) ?? null : null,
    media: mediaWithLocalPaths(db, id, username, videos),
    links: getTweetLinks(db, id),
    ...(includeExtras
      ? {
          card: getTweetCard(db, id) ?? null,
          poll: getTweetPoll(db, id),
        }
      : {}),
  };
}

function quotedTweetView(
  db: TwitterDatabase,
  tweetId: string,
  videos: Map<string, string>,
  remainingDepth: number,
): DbRow | null {
  const tweet = getTweetById(db, tweetId);
  if (!tweet) return null;
  const view = tweetView(db, tweet, videos, true);
  const nestedId = typeof tweet.quoted_id === 'string' ? tweet.quoted_id : null;
  return {
    ...view,
    quoted: nestedId && remainingDepth > 0
      ? quotedTweetView(db, nestedId, videos, remainingDepth - 1)
      : null,
  };
}

twitterRouter.get('/stats', (_req: Request, res: Response): void => {
  try {
    res.json(getTwitterStats(getTwitterDb()));
  } catch (error) {
    if (isMissingDatabaseError(error)) {
      res.json(EMPTY_STATS);
      return;
    }
    console.error('Failed to query Twitter stats:', errorMessage(error));
    res.status(500).json({ error: 'Failed to query Twitter database' });
  }
});

twitterRouter.get('/captures', (req: Request, res: Response): void => {
  const limit = integerQuery(req.query.limit, 50, 1, 200);
  const offset = integerQuery(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 500) : '';
  try {
    res.json(listLatestTwitterCaptures(getTwitterDb(), { limit, offset, query }));
  } catch (error) {
    if (isMissingDatabaseError(error)) {
      res.json({ items: [], total: 0 });
      return;
    }
    console.error('Failed to list Twitter captures:', errorMessage(error));
    res.status(500).json({ error: 'Failed to query Twitter database' });
  }
});

twitterRouter.get('/thread/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const db = getTwitterDb();
    const subject = getTweetById(db, req.params.id);
    if (!subject) {
      res.status(404).json({ error: 'Tweet not found' });
      return;
    }
    const videos = await localVideoIndex();

    const ancestors: DbRow[] = [];
    const seen = new Set([String(subject.id)]);
    let parentId = typeof subject.reply_to_id === 'string' ? subject.reply_to_id : null;
    while (parentId && ancestors.length < 100 && !seen.has(parentId)) {
      seen.add(parentId);
      const ancestor = getTweetById(db, parentId);
      if (!ancestor) break;
      ancestors.push(tweetView(db, ancestor, videos));
      parentId = typeof ancestor.reply_to_id === 'string' ? ancestor.reply_to_id : null;
    }
    ancestors.reverse();

    const replies = getTweetReplies(db, String(subject.id)).map((reply) => ({
      ...tweetView(db, reply, videos),
      replies: getTweetReplies(db, String(reply.id)).map((nested) => ({
        ...tweetView(db, nested, videos),
        replies: [],
      })),
    }));
    const quotedId = typeof subject.quoted_id === 'string' ? subject.quoted_id : null;
    const linkedArticle = getArticleByTweetId(db, String(subject.id));
    const article = linkedArticle
      ? {
          id: linkedArticle.id,
          title: linkedArticle.title,
          preview_text: linkedArticle.preview_text,
          cover_image_file: linkedArticle.cover_image_file,
          ...('pdf_path' in linkedArticle ? { pdf_path: linkedArticle.pdf_path } : {}),
        }
      : null;

    res.json({
      subject: tweetView(db, subject, videos, true),
      ancestors,
      replies,
      quoted: quotedId ? quotedTweetView(db, quotedId, videos, 1) : null,
      article,
      captures: getCapturesForSubjectKind(db, 'tweet', String(subject.id)),
    });
  } catch (error) {
    if (isMissingDatabaseError(error)) {
      res.status(404).json({ error: 'Tweet not found' });
      return;
    }
    console.error(`Failed to query Twitter thread ${req.params.id}:`, errorMessage(error));
    res.status(500).json({ error: 'Failed to query Twitter database' });
  }
});

twitterRouter.get('/article/:id', (req: Request, res: Response): void => {
  try {
    const db = getTwitterDb();
    const article = getArticleById(db, req.params.id);
    if (!article) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    const authorUsername = typeof article.author_username === 'string'
      ? article.author_username
      : null;
    const announcingTweetId = typeof article.tweet_id === 'string'
      ? article.tweet_id
      : req.params.id;
    res.json({
      article: {
        ...article,
        body_html: sanitizeTwitterHtml(article.body_html),
      },
      media: getArticleMedia(db, req.params.id),
      links: getTweetLinks(db, announcingTweetId),
      captures: getCapturesForSubjectKind(db, 'article', req.params.id),
      author: authorUsername ? getUserByUsername(db, authorUsername) ?? null : null,
    });
  } catch (error) {
    if (isMissingDatabaseError(error)) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    console.error(`Failed to query X Article ${req.params.id}:`, errorMessage(error));
    res.status(500).json({ error: 'Failed to query Twitter database' });
  }
});
