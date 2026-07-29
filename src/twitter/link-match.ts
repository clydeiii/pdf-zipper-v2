import { normalizeIndexedUrl, refreshPdfIndex, stripUrlQuery } from './pdf-index.js';
import type { TwitterDatabase } from './db.js';

const SHORTENER_HOSTS = new Set([
  't.co',
  'bit.ly',
  'buff.ly',
  'apple.news',
  'trib.al',
  'dlvr.it',
  'ow.ly',
  'tinyurl.com',
]);
const TWITTER_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);

export type ShortUrlResolver = (url: string) => Promise<string>;

interface ResolvedLink {
  url: string;
  originalUrl: string;
}

interface UnmatchedLinkRow {
  tweet_id: string;
  position: number;
  url: string;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isKnownShortUrl(value: string): boolean {
  try {
    return SHORTENER_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export async function resolveShortUrl(url: string): Promise<string> {
  if (!isKnownShortUrl(url)) return url;
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000),
    });
    return isHttpUrl(response.url) ? response.url : url;
  } catch {
    return url;
  }
}

function twitterStatusVariants(value: string): string[] {
  try {
    const url = new URL(value);
    if (!TWITTER_HOSTS.has(url.hostname.toLowerCase())) return [];
    const match = url.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:[/?#]|$)/);
    if (!match) return [];
    const pathname = `/${match[1]}/status/${match[2]}`;
    return [
      `https://x.com${pathname}`,
      `https://twitter.com${pathname}`,
    ];
  } catch {
    return [];
  }
}

function lookupNormalized(
  db: TwitterDatabase,
  column: 'url_normalized' | 'url_no_query',
  value: string | null,
): string | null {
  if (!value) return null;
  const row = db.prepare(`
    SELECT pdf_path
    FROM pdf_index
    WHERE ${column} = ?
    ORDER BY indexed_at DESC, pdf_path
    LIMIT 1
  `).get(value) as { pdf_path: string } | undefined;
  return row?.pdf_path ?? null;
}

function matchNormalizedLayers(db: TwitterDatabase, url: string): string | null {
  const normalized = normalizeIndexedUrl(url);
  if (!normalized) return null;
  return lookupNormalized(db, 'url_normalized', normalized)
    ?? lookupNormalized(db, 'url_no_query', stripUrlQuery(normalized));
}

export function matchUrlToPdf(db: TwitterDatabase, url: string): string | null {
  if (!isHttpUrl(url)) return null;
  const direct = matchNormalizedLayers(db, url);
  if (direct) return direct;
  for (const variant of twitterStatusVariants(url)) {
    const match = matchNormalizedLayers(db, variant);
    if (match) return match;
  }
  return null;
}

async function resolveLinks(
  links: string[],
  resolver: ShortUrlResolver,
): Promise<ResolvedLink[]> {
  const resolved: ResolvedLink[] = [];
  const seen = new Set<string>();
  for (const originalUrl of links) {
    let url = originalUrl;
    if (isKnownShortUrl(originalUrl)) {
      try {
        const candidate = await resolver(originalUrl);
        if (isHttpUrl(candidate)) url = candidate;
      } catch {
        // Resolution is opportunistic; retain the short URL on any failure.
      }
    }
    if (seen.has(url)) continue;
    seen.add(url);
    resolved.push({ url, originalUrl });
  }
  return resolved;
}

export async function upsertTweetLinks(
  db: TwitterDatabase,
  tweetId: string,
  links: string[],
  options: { resolver?: ShortUrlResolver; timestamp?: string } = {},
): Promise<void> {
  if (links.length === 0) return;
  let resolved: ResolvedLink[];
  if (links.some(isKnownShortUrl)) {
    resolved = await resolveLinks(links, options.resolver ?? resolveShortUrl);
  } else {
    const seen = new Set<string>();
    resolved = links.flatMap((url) => {
      if (seen.has(url)) return [];
      seen.add(url);
      return [{ url, originalUrl: url }];
    });
  }
  if (resolved.length === 0) return;
  const timestamp = options.timestamp ?? new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO tweet_links (
      tweet_id, position, url, url_normalized, pdf_path, matched_at
    ) VALUES (
      @tweetId, @position, @url, @urlNormalized, @pdfPath, @matchedAt
    )
    ON CONFLICT(tweet_id, position) DO UPDATE SET
      url = excluded.url,
      url_normalized = excluded.url_normalized,
      pdf_path = CASE
        WHEN tweet_links.url = excluded.url
          THEN COALESCE(tweet_links.pdf_path, excluded.pdf_path)
        ELSE excluded.pdf_path
      END,
      matched_at = CASE
        WHEN tweet_links.url = excluded.url
          THEN COALESCE(tweet_links.matched_at, excluded.matched_at)
        ELSE excluded.matched_at
      END
  `);
  const replace = db.transaction(() => {
    for (const [position, link] of resolved.entries()) {
      const pdfPath = matchUrlToPdf(db, link.url)
        ?? (link.originalUrl === link.url ? null : matchUrlToPdf(db, link.originalUrl));
      upsert.run({
        tweetId,
        position,
        url: link.url,
        urlNormalized: normalizeIndexedUrl(link.url),
        pdfPath,
        matchedAt: pdfPath ? timestamp : null,
      });
    }
    db.prepare(
      'DELETE FROM tweet_links WHERE tweet_id = ? AND position >= ?',
    ).run(tweetId, resolved.length);
  });
  replace();
}

export async function rematchTweetLinks(
  db: TwitterDatabase,
  options: {
    dataDir?: string;
    dryRun?: boolean;
    onMatch?: (row: { tweetId: string; position: number; url: string; pdfPath: string }) => void;
  } = {},
): Promise<{ checked: number; matched: number }> {
  await refreshPdfIndex(db, { dataDir: options.dataDir });
  const rows = db.prepare(`
    SELECT tweet_id, position, url
    FROM tweet_links
    WHERE pdf_path IS NULL
    ORDER BY tweet_id, position
  `).all() as UnmatchedLinkRow[];
  const hits: Array<UnmatchedLinkRow & { pdfPath: string }> = [];
  for (const row of rows) {
    const pdfPath = matchUrlToPdf(db, row.url);
    if (!pdfPath) continue;
    hits.push({ ...row, pdfPath });
    options.onMatch?.({
      tweetId: row.tweet_id,
      position: row.position,
      url: row.url,
      pdfPath,
    });
  }
  if (!options.dryRun && hits.length > 0) {
    const matchedAt = new Date().toISOString();
    const update = db.prepare(`
      UPDATE tweet_links
      SET pdf_path = ?, matched_at = ?
      WHERE tweet_id = ? AND position = ? AND pdf_path IS NULL
    `);
    db.transaction(() => {
      for (const hit of hits) {
        update.run(hit.pdfPath, matchedAt, hit.tweet_id, hit.position);
      }
    })();
  }
  return { checked: rows.length, matched: hits.length };
}
