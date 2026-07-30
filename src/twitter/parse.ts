import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { env } from '../config/env.js';
import type {
  ParsedArticle,
  ParsedArticleMedia,
  ParsedCard,
  ParsedMedia,
  ParsedPollOption,
  ParsedThreadPage,
  ParsedTweet,
  ParsedUser,
} from './types.js';

const STATUS_PATH_RE = /^\/([A-Za-z0-9_]+)\/status\/(\d+)/;
const ARTICLE_PATH_RE = /\/(?:i\/article|[A-Za-z0-9_]+\/article)\/(\d+)/;
const NITTER_ERROR_RE = /tweet not found|user not found|instance has been rate limited|page not found/i;
const TWITTER_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
/**
 * `/i/...` paths that only ever exist on x.com, so a Nitter mirror serving one
 * (under whatever hostname it is configured with) can be re-homed safely.
 */
const TWITTER_ONLY_I_ROUTE_RE =
  /^\/i\/(?:article\/\d+|status\/\d+|grok\/share\/[A-Za-z0-9]+|spaces\/[A-Za-z0-9]+|lists\/\d+|communities\/\d+)(?:[/?#]|$)/;
const NITTER_ROUTE_HOSTS = new Set<string>();
try {
  NITTER_ROUTE_HOSTS.add(new URL(env.NITTER_HOST).hostname.toLowerCase());
} catch {
  // Invalid configuration is reported by the actual fetch path.
}
for (const host of (env.NITTER_PUBLIC_HOSTS ?? '').split(',')) {
  const trimmed = host.trim().toLowerCase();
  if (trimmed) NITTER_ROUTE_HOSTS.add(trimmed);
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function decodeUrl(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function statusParts(href: string | undefined): { username: string; id: string } | null {
  if (!href) return null;
  let pathname = href;
  try {
    pathname = new URL(href, 'https://x.com').pathname;
  } catch {
    // The regex below will reject malformed paths.
  }
  const match = pathname.match(STATUS_PATH_RE);
  return match ? { username: match[1], id: match[2] } : null;
}

/**
 * True for hosts that serve Nitter's rendering of Twitter routes: the instance
 * this deployment fetches through, plus any hostname carrying `nitter` (public
 * mirrors — a Nitter instance renders absolute URLs using ITS configured
 * hostname, which is generally not the address we reach it on). Exported for
 * tests.
 */
export function isNitterHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return NITTER_ROUTE_HOSTS.has(host) || /(?:^|\.)nitter[.-]?/i.test(host);
}

export function canonicalTwitterHref(href: string): string {
  if (/^https?:\/\//i.test(href)) {
    try {
      const parsed = new URL(href);
      // Community-note links arrive wrapped in Nitter's configured hostname.
      const wrappedShort = parsed.pathname.match(/^\/(t\.co\/.+)$/i);
      if (wrappedShort) return `https://${wrappedShort[1]}${parsed.search}${parsed.hash}`;

      // Re-home Twitter routes served by a Nitter mirror. Gate on the HOST
      // being a known mirror rather than on the path shape alone: paths like
      // /<user>/status/<id> or /i/article/<id> can legitimately exist on
      // unrelated sites, and rewriting those to x.com would corrupt the link.
      if (isNitterHost(parsed.hostname) && (
        /^\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:[/?#]|$)/.test(parsed.pathname)
        || TWITTER_ONLY_I_ROUTE_RE.test(parsed.pathname)
        || /^\/[A-Za-z0-9_]{1,15}\/?$/.test(parsed.pathname)
        || /^\/pic\//.test(parsed.pathname)
        || /^\/(?:messages|hashtag|search|settings)(?:[/?#]|$)/.test(parsed.pathname)
      )) {
        return `https://x.com${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
      return href;
    } catch {
      return href;
    }
  }
  if (href.startsWith('/') && !href.startsWith('//')) {
    return `https://x.com${href}`;
  }
  return href;
}

/**
 * Replace a Nitter-rendered display host in an anchor's visible text with
 * `x.com`. Only touches text whose leading token is the host we just rewrote
 * away from, so ordinary link labels are left alone. Exported for tests.
 */
export function canonicalTwitterDisplayText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const leading = trimmed.match(/^([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?=[/\s]|$)/)?.[1];
  if (!leading || !isNitterHost(leading)) return text;
  return trimmed.replace(/^[A-Za-z0-9.-]+/, 'x.com');
}

/** @deprecated use {@link canonicalTwitterDisplayText} — kept for the href-change call sites. */
export function canonicalTwitterLinkText(text: string, _originalHref: string): string {
  return canonicalTwitterDisplayText(text);
}

function canonicalizeHtml($content: Cheerio<AnyNode>): string | null {
  if (!$content.length) return null;
  const clone = $content.clone();
  clone.find('a[href]').each((index) => {
    const link = clone.find('a[href]').eq(index);
    const href = link.attr('href');
    if (!href) return;
    link.attr('href', canonicalTwitterHref(href));
    // Nitter also rewrites the VISIBLE text of a shortened link to its own
    // hostname ("nitter.net/user/status/123…"). Re-home the displayed host too,
    // or the KB stores prose pointing at a mirror the consumer can't reach.
    // Independent of whether the href changed: the text carries its own host.
    const displayText = canonicalTwitterDisplayText(link.text());
    if (displayText !== link.text()) link.text(displayText);
  });
  clone.find('img, video, source, picture').remove();
  return nonEmpty(clone.html());
}

function twitterLinkTarget(url: URL): { kind: 'status' | 'article'; id: string } | null {
  if (!TWITTER_HOSTS.has(url.hostname.toLowerCase())) return null;
  const status = url.pathname.match(/^\/[A-Za-z0-9_]+\/status\/(\d+)(?:[/?#]|$)/);
  if (status) return { kind: 'status', id: status[1] };
  const article = url.pathname.match(
    /^\/(?:i\/article|[A-Za-z0-9_]+\/article)\/(\d+)(?:[/?#]|$)/,
  );
  return article ? { kind: 'article', id: article[1] } : null;
}

export function extractExternalLinksFromHtml(
  html: string | null | undefined,
  options: {
    cardUrl?: string | null;
    sameThreadTweetIds?: Iterable<string>;
    sameThreadArticleIds?: Iterable<string>;
  } = {},
): string[] {
  const candidates: string[] = [];
  if (html) {
    const $ = load(html, null, false);
    $('a[href]').each((_index, element) => {
      const href = $(element).attr('href')?.trim();
      if (href) candidates.push(href);
    });
  }
  if (options.cardUrl) candidates.push(options.cardUrl.trim());

  return filterExternalLinks(candidates, options);
}

export function filterExternalLinks(
  candidates: string[],
  options: {
    sameThreadTweetIds?: Iterable<string>;
    sameThreadArticleIds?: Iterable<string>;
  },
): string[] {
  const tweetIds = new Set(options.sameThreadTweetIds ?? []);
  const articleIds = new Set(options.sameThreadArticleIds ?? []);
  const links: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!/^https?:\/\//i.test(candidate)) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    const target = twitterLinkTarget(parsed);
    if (TWITTER_HOSTS.has(parsed.hostname.toLowerCase())) {
      if (!target) continue;
      if (target.kind === 'status' && tweetIds.has(target.id)) continue;
      if (target.kind === 'article' && (articleIds.has(target.id) || tweetIds.has(target.id))) continue;
    }
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    links.push(url);
  }
  return links;
}

export function excludeSameThreadLinks(tweets: ParsedTweet[]): void {
  const tweetIds = new Set(tweets.map((tweet) => tweet.id));
  const articleIds = new Set(
    tweets.map((tweet) => tweet.articleId).filter((id): id is string => Boolean(id)),
  );
  for (const tweet of tweets) {
    tweet.links = filterExternalLinks(tweet.links, {
      sameThreadTweetIds: tweetIds,
      sameThreadArticleIds: articleIds,
    });
  }
}

function parseDate(title: string | undefined): string | null {
  if (!title) return null;
  const parsed = new Date(title.replace('·', ''));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseStatCount(value: string | null | undefined): number | null {
  if (!value) return null;
  const digits = value.replace(/,/g, '').match(/\d+/)?.[0];
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function statFor($item: Cheerio<AnyNode>, iconClass: string): number | null {
  const icon = $item.find(`.tweet-stats .${iconClass}`).first();
  if (!icon.length) return null;
  return parseStatCount(icon.parent().text());
}

function canonicalTwitterMediaUrl(value: string | undefined): string | null {
  if (!value) return null;
  const picIndex = value.indexOf('/pic/');
  const withoutProxy = (picIndex >= 0 ? value.slice(picIndex + 5) : value)
    .replace(/^\/+/, '')
    .replace(/^orig\//, '');
  const decoded = decodeUrl(withoutProxy);
  if (!decoded) return null;
  if (/^https:\/\//i.test(decoded)) return decoded;
  if (/^(?:pbs|video)\.twimg\.com\//i.test(decoded)) return `https://${decoded}`;
  return `https://pbs.twimg.com/${decoded}`;
}

function verifiedType($scope: Cheerio<AnyNode>): string | null {
  const badge = $scope.find('.verified-icon').first();
  if (!badge.length) return null;
  const type = (badge.attr('class') ?? '')
    .split(/\s+/)
    .find((className) => className !== 'verified-icon');
  return type ?? 'verified';
}

function parseUser($scope: Cheerio<AnyNode>, fallbackUsername?: string): ParsedUser {
  const username = nonEmpty($scope.find('.username').first().text())?.replace(/^@/, '')
    ?? fallbackUsername
    ?? '';
  const avatarFetchUrl = nonEmpty(
    $scope.find('.tweet-avatar img.avatar, img.avatar').first().attr('src'),
  );
  return {
    username,
    fullname: nonEmpty(
      $scope.find('.fullname').first().attr('title') ?? $scope.find('.fullname').first().text(),
    ),
    verified: verifiedType($scope),
    avatarUrl: canonicalTwitterMediaUrl(avatarFetchUrl ?? undefined),
    avatarFetchUrl,
  };
}

function directOutsideQuote(selection: Cheerio<AnyNode>): AnyNode[] {
  return selection.toArray().filter((_element, index) => selection.eq(index).parents('.quote').length === 0);
}

function decodeVideoUrl(href: string | undefined): string | null {
  if (!href) return null;
  const marker = href.match(/^\/video\/[^/]+\/(.+)$/)?.[1];
  if (!marker) return /^https?:\/\/video\.twimg\.com\//i.test(href) ? href : null;
  const decoded = decodeUrl(marker);
  return /^https?:\/\/video\.twimg\.com\//i.test(decoded) ? decoded : null;
}

function decodeGifSource(source: string | undefined): string | null {
  if (!source) return null;
  const decoded = decodeUrl(source);
  if (/^https?:\/\/video\.twimg\.com\//i.test(decoded)) return decoded;
  if (decoded.startsWith('/pic/')) {
    return `https://video.twimg.com/${decoded.slice('/pic/'.length).replace(/^orig\//, '')}`;
  }
  return null;
}

function parseMedia(
  $: CheerioAPI,
  $scope: Cheerio<AnyNode>,
  excludeNestedQuotes = true,
): ParsedMedia[] {
  const media: ParsedMedia[] = [];
  const stillSelection = $scope.find('.attachments a.still-image[href]');
  const stills = excludeNestedQuotes ? directOutsideQuote(stillSelection) : stillSelection.toArray();
  for (const element of stills) {
    const fetchUrl = nonEmpty($(element).attr('href'));
    const origUrl = canonicalTwitterMediaUrl(fetchUrl ?? undefined);
    if (!fetchUrl || !origUrl) continue;
    media.push({
      position: media.length,
      kind: 'photo',
      origUrl,
      fetchUrl,
      posterUrl: null,
      posterFetchUrl: null,
      videoUrl: null,
    });
  }

  const videoSelection = $scope.find('.attachments .attachment').filter((_index, element) =>
    $(element).find('a.video-download[href], video.gif, video source[src]').length > 0,
  );
  const videos = excludeNestedQuotes ? directOutsideQuote(videoSelection) : videoSelection.toArray();
  for (const element of videos) {
    const attachment = $(element);
    const download = attachment.find('a.video-download[href]').first().attr('href');
    const source = attachment.find('video source[src], video.gif[src]').first().attr('src');
    const videoUrl = decodeVideoUrl(download) ?? decodeGifSource(source);
    const posterFetchUrl = nonEmpty(
      attachment.find('video[poster]').first().attr('poster') ?? attachment.find('img[src]').first().attr('src'),
    );
    const isGif = attachment.find('video.gif').length > 0;
    media.push({
      position: media.length,
      kind: isGif ? 'gif' : 'video',
      origUrl: videoUrl ?? canonicalTwitterMediaUrl(posterFetchUrl ?? undefined) ?? '',
      fetchUrl: null,
      posterUrl: canonicalTwitterMediaUrl(posterFetchUrl ?? undefined),
      posterFetchUrl,
      videoUrl,
    });
  }
  return media;
}

function parseCard($scope: Cheerio<AnyNode>): ParsedCard | null {
  const cards = $scope.find(
    '.card:has(.card-title), .card:has(.card-description), .card:has(.card-container)',
  );
  const card = cards.filter((index) => cards.eq(index).parents('.quote').length === 0).first();
  if (!card.length) return null;
  const imageFetchUrl = nonEmpty(card.find('img[src]').first().attr('src'));
  return {
    url: nonEmpty(card.find('a.card-container[href], a[href]').first().attr('href')),
    title: nonEmpty(card.find('.card-title').first().text()),
    description: nonEmpty(card.find('.card-description').first().text()),
    imageUrl: canonicalTwitterMediaUrl(imageFetchUrl ?? undefined),
    imageFetchUrl,
  };
}

function parsePoll($scope: Cheerio<AnyNode>): ParsedPollOption[] {
  const options: ParsedPollOption[] = [];
  const choices = $scope.find('.poll .poll-choice');
  choices.each((index) => {
    const choice = choices.eq(index);
    const percentText = choice.find('.poll-choice-value, .poll-choice-percent').first().text()
      || choice.attr('style')
      || '';
    const percent = percentText.match(/(\d+(?:\.\d+)?)\s*%/);
    const labelNode = choice.find('.poll-choice-label, span').first();
    const label = nonEmpty(labelNode.text()) ?? nonEmpty(choice.clone().children().remove().end().text());
    if (label) {
      options.push({
        optionIndex: index,
        label,
        valuePercent: percent ? Number.parseFloat(percent[1]) : null,
      });
    }
  });
  return options;
}

function parseRetweetedBy($item: Cheerio<AnyNode>): string | null {
  const header = $item.find('.retweet-header').first();
  if (!header.length) return null;
  const href = header.find('a[href]').first().attr('href');
  const username = href?.match(/^\/([A-Za-z0-9_]+)/)?.[1];
  if (username) return username;
  return nonEmpty(header.text().replace(/\bretweeted\b(?:\s+by)?/i, ''));
}

function articleCardId($: CheerioAPI, $scope: Cheerio<AnyNode>): string | null {
  const links = $scope.find('.article-card a.card-container[href*="/i/article/"]');
  const link = directOutsideQuote(links).at(0);
  const href = link ? $(link).attr('href') : undefined;
  return href?.match(/\/i\/article\/(\d+)(?:[/?#]|$)/)?.[1] ?? null;
}

interface TweetElementOptions {
  fallbackId?: string;
  replyToId?: string | null;
  isStub?: boolean;
}

function parseTweetElement(
  $: CheerioAPI,
  element: AnyNode,
  options: TweetElementOptions = {},
): ParsedTweet | null {
  const item = $(element);
  if (item.hasClass('unavailable')) return null;
  const linkParts = statusParts(
    item.children('a.tweet-link').first().attr('href')
      ?? item.find('.tweet-date a[href*="/status/"]').first().attr('href'),
  );
  const id = linkParts?.id ?? options.fallbackId;
  const username = item.attr('data-username') ?? linkParts?.username;
  if (!id || !username) return null;

  const user = parseUser(item, username);
  user.username = username;
  const content = item.find('.tweet-content').first();
  const replyingTo = item.find('.replying-to').first().find('a').toArray()
    .map((anchor) => nonEmpty($(anchor).text())?.replace(/^@/, ''))
    .filter((value): value is string => Boolean(value));
  const quoteParts = statusParts(item.find('.quote a.quote-link[href]').first().attr('href'));
  const dateTitle = item.find('.tweet-date a[title]').first().attr('title');
  const contentHtml = canonicalizeHtml(content);
  const card = parseCard(item);
  const note = item.find('.community-note .community-note-text').first();
  const communityNoteHtml = canonicalizeHtml(note);
  const links = extractExternalLinksFromHtml(contentHtml, {
    cardUrl: card?.url ? canonicalTwitterHref(card.url) : null,
  });
  // Community-note source links (canonicalized so t.co survives the Nitter wrap)
  // are prime capture-linkage candidates — the note usually cites the correction.
  for (const noteLink of extractExternalLinksFromHtml(communityNoteHtml)) {
    if (!links.includes(noteLink)) links.push(noteLink);
  }

  return {
    id,
    articleId: articleCardId($, item),
    username,
    user,
    contentHtml,
    contentText: nonEmpty(content.text()),
    publishedAt: parseDate(dateTitle),
    replyToId: options.replyToId ?? null,
    replyToUsers: replyingTo,
    quotedId: quoteParts?.id ?? null,
    retweetedBy: parseRetweetedBy(item),
    repliesCount: statFor(item, 'icon-comment'),
    retweetsCount: statFor(item, 'icon-retweet'),
    likesCount: statFor(item, 'icon-heart'),
    viewsCount: statFor(item, 'icon-views'),
    sourceUrl: `https://x.com/${username}/status/${id}`,
    isStub: options.isStub ?? false,
    links,
    media: parseMedia($, item),
    card,
    poll: parsePoll(item),
    communityNoteHtml,
    communityNoteText: nonEmpty(note.text()),
  };
}

function parseQuote($: CheerioAPI, quoteElement: AnyNode): ParsedTweet | null {
  const quote = $(quoteElement);
  const parts = statusParts(quote.find('a.quote-link[href]').first().attr('href'));
  if (!parts) return null;
  const user = parseUser(quote, parts.username);
  user.username = parts.username;
  const text = quote.find('.quote-text').first();
  const media = parseMedia($, quote, false);
  const contentHtml = canonicalizeHtml(text);
  const contentText = nonEmpty(text.text());

  // Nitter uses a dedicated quote-media-container in some renderer variants.
  quote.find('.quote-media-container a.still-image[href]').each((_index, element) => {
    const fetchUrl = nonEmpty($(element).attr('href'));
    const origUrl = canonicalTwitterMediaUrl(fetchUrl ?? undefined);
    if (!fetchUrl || !origUrl) return;
    media.push({
      position: media.length,
      kind: 'photo',
      origUrl,
      fetchUrl,
      posterUrl: null,
      posterFetchUrl: null,
      videoUrl: null,
    });
  });

  return {
    id: parts.id,
    articleId: null,
    username: parts.username,
    user,
    contentHtml,
    contentText,
    publishedAt: parseDate(quote.find('.tweet-date a[title]').first().attr('title')),
    replyToId: null,
    replyToUsers: quote.find('.replying-to a').toArray()
      .map((anchor) => nonEmpty($(anchor).text())?.replace(/^@/, ''))
      .filter((value): value is string => Boolean(value)),
    quotedId: null,
    retweetedBy: null,
    repliesCount: null,
    retweetsCount: null,
    likesCount: null,
    viewsCount: null,
    sourceUrl: `https://x.com/${parts.username}/status/${parts.id}`,
    isStub: !contentText && media.length === 0,
    links: extractExternalLinksFromHtml(contentHtml),
    media,
    card: null,
    poll: [],
    communityNoteHtml: null,
    communityNoteText: null,
  };
}

function uniqueTweets(tweets: ParsedTweet[]): ParsedTweet[] {
  const byId = new Map<string, ParsedTweet>();
  for (const tweet of tweets) {
    const previous = byId.get(tweet.id);
    if (!previous || (previous.isStub && !tweet.isStub)) byId.set(tweet.id, tweet);
  }
  return [...byId.values()];
}

export function isNitterErrorPage(html: string): boolean {
  const $ = load(html);
  if ($('.main-thread .main-tweet .timeline-item[data-username], .article-title, .article-body').length > 0) {
    return false;
  }
  return NITTER_ERROR_RE.test($('body').text());
}

export function parseThreadPage(html: string, sourceUrl: string): ParsedThreadPage {
  const $ = load(html);
  const sourceParts = statusParts(new URL(sourceUrl).pathname);
  const ancestorElements = $('.main-thread .before-tweet .timeline-item[data-username]').toArray();
  const ancestors: ParsedTweet[] = [];
  let ancestorParent: string | null = null;
  for (const element of ancestorElements) {
    const tweet = parseTweetElement($, element, { replyToId: ancestorParent });
    if (!tweet) continue;
    ancestors.push(tweet);
    ancestorParent = tweet.id;
  }

  const mainElement = $('.main-thread .main-tweet .timeline-item[data-username]').first();
  const mainTweet = mainElement.length
    ? parseTweetElement($, mainElement.get(0)!, {
        fallbackId: sourceParts?.id,
        replyToId: ancestors.at(-1)?.id ?? null,
      })
    : null;

  const continuation: ParsedTweet[] = [];
  let continuationParent = mainTweet?.id ?? null;
  $('.main-thread .after-tweet .timeline-item[data-username]').each((_index, element) => {
    const tweet = parseTweetElement($, element, { replyToId: continuationParent });
    if (!tweet) return;
    continuation.push(tweet);
    continuationParent = tweet.id;
  });

  const replies: ParsedTweet[] = [];
  $('#r.replies > .reply').each((_replyIndex, replyElement) => {
    let parentId = mainTweet?.id ?? null;
    $(replyElement).find('.timeline-item[data-username]').each((_index, element) => {
      const tweet = parseTweetElement($, element, { replyToId: parentId });
      if (!tweet) return;
      replies.push(tweet);
      parentId = tweet.id;
    });
  });

  const quoteScopes = [
    ...(mainElement.length ? mainElement.find('.quote').toArray() : []),
    ...ancestorElements.flatMap((element) => $(element).find('.quote').toArray()),
    ...$('.main-thread .after-tweet .timeline-item .quote').toArray(),
    ...$('#r.replies > .reply .timeline-item .quote').toArray(),
  ];
  const quotedTweets = uniqueTweets(
    quoteScopes.map((element) => parseQuote($, element)).filter((tweet): tweet is ParsedTweet => Boolean(tweet)),
  );

  const cursorHref = nonEmpty($('#r.replies .show-more a[href], .show-more a[href*="cursor="]').last().attr('href'));
  const nextCursor = cursorHref ? cursorHref.replace(/#.*$/, '') : null;

  const result = {
    mainTweet,
    ancestors: uniqueTweets(ancestors),
    continuation: uniqueTweets(continuation),
    replies: uniqueTweets(replies),
    quotedTweets,
    nextCursor,
  };
  excludeSameThreadLinks(uniqueTweets([
    ...(result.mainTweet ? [result.mainTweet] : []),
    ...result.ancestors,
    ...result.continuation,
    ...result.replies,
    ...result.quotedTweets,
  ]));
  return result;
}

function articleIdFromUrl(sourceUrl: string): string | null {
  try {
    return new URL(sourceUrl).pathname.match(ARTICLE_PATH_RE)?.[1] ?? null;
  } catch {
    return sourceUrl.match(ARTICLE_PATH_RE)?.[1] ?? null;
  }
}

function articleImage(
  fetchUrl: string | null,
  position: number,
): ParsedArticleMedia | null {
  if (!fetchUrl) return null;
  return {
    position,
    origUrl: canonicalTwitterMediaUrl(fetchUrl) ?? fetchUrl,
    fetchUrl: fetchUrl.startsWith('/pic/') ? fetchUrl : null,
  };
}

export function parseArticle(html: string, sourceUrl: string): ParsedArticle | null {
  const id = articleIdFromUrl(sourceUrl);
  if (!id) return null;
  const $ = load(html);
  const body = $('article.article-body').first();
  const title = nonEmpty($('h1.article-title').first().text());
  const bodyContent = body.clone();
  bodyContent.children('h1.article-title, .article-author').remove();
  const bodyText = nonEmpty(bodyContent.text());
  if (!title && !bodyText) return null;

  const dateLink = $('.article-author a.article-date[href]').first();
  const announcingTweet = statusParts(dateLink.attr('href'));
  const authorUsername = nonEmpty($('.article-author .username').first().text())?.replace(/^@/, '')
    ?? announcingTweet?.username
    ?? null;
  const cover = $('.article-page img.article-cover').first();
  const coverFetchUrl = nonEmpty(cover.closest('a[href]').attr('href') ?? cover.attr('src'));
  const media: ParsedArticleMedia[] = [];
  bodyContent.find('img[src]').each((_index, element) => {
    const image = $(element);
    const fetchUrl = nonEmpty(image.closest('a[href]').attr('href') ?? image.attr('src'));
    const parsed = articleImage(fetchUrl, media.length);
    if (parsed) media.push(parsed);
  });
  const dateTitle = $('.article-author time[datetime]').first().attr('datetime')
    ?? dateLink.attr('title');
  const date = dateTitle ? new Date(dateTitle.replace('·', '')) : null;

  return {
    id,
    announcingTweetId: announcingTweet?.id ?? null,
    url: `https://x.com/i/article/${id}`,
    authorUsername,
    title,
    previewText: bodyText?.slice(0, 280) ?? null,
    coverImageUrl: canonicalTwitterMediaUrl(coverFetchUrl ?? undefined),
    coverImageFetchUrl: coverFetchUrl,
    bodyHtml: canonicalizeHtml(bodyContent),
    bodyText,
    publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    harvestedFrom: 'nitter',
    links: extractExternalLinksFromHtml(canonicalizeHtml(bodyContent)),
    media,
  };
}
