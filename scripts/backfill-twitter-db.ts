/**
 * Backfill the structured Twitter/X database from recent Karakeep bookmarks.
 *
 * The normal conversion worker harvests new captures as they arrive. This
 * script fills the same database for bookmarks created before that integration
 * existed, preserving any matching weekly-bin PDF as capture provenance.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/backfill-twitter-db.ts
 *   npx tsx --env-file=.env scripts/backfill-twitter-db.ts --days 7 --limit 5 --dry-run
 *   npx tsx --env-file=.env scripts/backfill-twitter-db.ts --include-existing --delay-ms 1500
 *
 * In Docker:
 *   docker exec -w /home/clyde/pdf-zipper-v2 pdfzipper-v2 npx tsx scripts/backfill-twitter-db.ts
 */
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { env } from '../src/config/env.js';
import {
  getTwitterDb,
  hasCaptureForSubject,
} from '../src/twitter/db.js';
import {
  harvestArticleToDb,
  harvestTweetToDb,
  TwitterHarvestError,
} from '../src/twitter/harvest.js';
import { buildUrlBaseName } from '../src/utils/save-pdf.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 10_000;
const TWITTER_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);

interface Options {
  days: number;
  limit?: number;
  dryRun: boolean;
  delayMs: number;
  includeExisting: boolean;
}

interface KarakeepBookmark {
  id: string;
  createdAt: string;
  content?: {
    type?: string;
    url?: string;
  };
}

interface KarakeepPage {
  bookmarks?: KarakeepBookmark[];
  nextCursor?: string;
}

interface ClassifiedTwitterUrl {
  kind: 'tweet' | 'article';
  subjectId: string;
  url: string;
}

interface Summary {
  harvested: number;
  tweetsUpserted: number;
  imagesDownloaded: number;
  skipped: number;
  failed: number;
  attempted: number;
}

let stopRequested = false;

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    days: 7,
    dryRun: false,
    delayMs: 1500,
    includeExisting: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--include-existing') options.includeExisting = true;
    else if (arg === '--days') options.days = Number(valueAfter(argv, index++, arg));
    else if (arg === '--limit') options.limit = Number(valueAfter(argv, index++, arg));
    else if (arg === '--delay-ms') options.delayMs = Number(valueAfter(argv, index++, arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.days) || options.days <= 0) {
    throw new Error('--days must be a positive number');
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error('--delay-ms must be a non-negative integer');
  }
  return options;
}

function twitterUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return TWITTER_HOSTS.has(url.hostname.toLowerCase()) ? url.toString() : null;
  } catch {
    return null;
  }
}

function classifyTwitterUrl(value: string): ClassifiedTwitterUrl | null {
  const url = new URL(value);
  const article = url.pathname.match(
    /^\/(?:i\/article|[A-Za-z0-9_]+\/article)\/(\d+)(?:\/|$)/,
  );
  if (article) return { kind: 'article', subjectId: article[1], url: value };
  const status = url.pathname.match(/^\/[A-Za-z0-9_]+\/status\/(\d+)(?:\/|$)/);
  if (status) return { kind: 'tweet', subjectId: status[1], url: value };
  return null;
}

async function recentTwitterBookmarks(cutoff: Date): Promise<KarakeepBookmark[]> {
  const apiBase = process.env.KARAKEEP_API_BASE;
  const apiToken = process.env.KARAKEEP_API_TOKEN;
  if (!apiBase || !apiToken) {
    throw new Error('KARAKEEP_API_BASE and KARAKEEP_API_TOKEN must be set');
  }

  const bookmarks: KarakeepBookmark[] = [];
  let cursor: string | undefined;
  let pageNumber = 0;
  let reachedCutoff = false;
  do {
    if (stopRequested) break;
    const url = new URL('/api/v1/bookmarks', apiBase);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Karakeep list failed: ${response.status} ${response.statusText}`);
    }
    const page = await response.json() as KarakeepPage;
    pageNumber++;
    for (const bookmark of page.bookmarks ?? []) {
      const createdAt = new Date(bookmark.createdAt);
      if (!Number.isNaN(createdAt.getTime()) && createdAt < cutoff) {
        reachedCutoff = true;
        break;
      }
      if (twitterUrl(bookmark.content?.url)) bookmarks.push(bookmark);
    }
    console.log(`[page ${pageNumber}] ${page.bookmarks?.length ?? 0} bookmarks scanned · ${bookmarks.length} recent Twitter/X`);
    cursor = page.nextCursor;
  } while (cursor && !reachedCutoff && pageNumber < MAX_PAGES);

  if (pageNumber >= MAX_PAGES && cursor && !reachedCutoff) {
    console.warn(`Karakeep pagination hit the safety limit (${MAX_PAGES} pages)`);
  }
  return bookmarks;
}

async function pdfIndex(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const mediaRoot = path.join(env.DATA_DIR, 'media');
  let entries;
  try {
    entries = await readdir(mediaRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw error;
  }
  const weeks = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
  for (const week of weeks) {
    let pdfs;
    try {
      pdfs = await readdir(path.join(mediaRoot, week, 'pdfs'), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const pdf of pdfs) {
      if (!pdf.isFile() || !pdf.name.toLowerCase().endsWith('.pdf')) continue;
      const key = pdf.name.toLowerCase();
      if (!files.has(key)) {
        files.set(key, path.posix.join('media', week, 'pdfs', pdf.name));
      }
    }
  }
  return files;
}

function alternateTwitterHost(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hostname = host === 'x.com' ? 'twitter.com' : 'x.com';
  return url.toString();
}

function findPdfPath(
  index: Map<string, string>,
  item: ClassifiedTwitterUrl,
): string | undefined {
  const options = item.kind === 'tweet' ? { isXArticle: false } : { isXArticle: true };
  const candidates = [
    `${buildUrlBaseName(item.url, options)}.pdf`,
    `${buildUrlBaseName(alternateTwitterHost(item.url), options)}.pdf`,
  ];
  for (const candidate of candidates) {
    const match = index.get(candidate.toLowerCase());
    if (match) return match;
  }

  // Handles canonical /i/... forms and historic host variations while still
  // requiring the conventional Twitter kind + exact subject ID suffix.
  const suffix = `-${item.kind === 'tweet' ? 'post' : 'article'}-${item.subjectId}.pdf`;
  for (const [basename, relativePath] of index) {
    if (
      (basename.startsWith('x.com-') || basename.startsWith('twitter.com-'))
      && basename.endsWith(suffix.toLowerCase())
    ) {
      return relativePath;
    }
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logSummary(summary: Summary, dryRun: boolean, interrupted: boolean): void {
  console.log([
    dryRun ? 'Dry-run summary:' : 'Backfill summary:',
    `harvested=${summary.harvested}`,
    `tweetsUpserted=${summary.tweetsUpserted}`,
    `imagesDownloaded=${summary.imagesDownloaded}`,
    `skipped=${summary.skipped}`,
    `failed=${summary.failed}`,
    `attempted=${summary.attempted}`,
    interrupted ? 'interrupted=true' : '',
  ].filter(Boolean).join(' '));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cutoff = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
  const summary: Summary = {
    harvested: 0,
    tweetsUpserted: 0,
    imagesDownloaded: 0,
    skipped: 0,
    failed: 0,
    attempted: 0,
  };

  console.log(`Twitter/X backfill: cutoff=${cutoff.toISOString()} delay=${options.delayMs}ms${options.dryRun ? ' dry-run' : ''}`);
  const [bookmarks, pdfs] = await Promise.all([
    recentTwitterBookmarks(cutoff),
    pdfIndex(),
  ]);
  const db = getTwitterDb();
  let eligible = 0;

  for (let index = 0; index < bookmarks.length; index++) {
    if (stopRequested) break;
    const bookmark = bookmarks[index];
    const sourceUrl = twitterUrl(bookmark.content?.url);
    const label = `[${index + 1}/${bookmarks.length}]`;
    const classified = sourceUrl ? classifyTwitterUrl(sourceUrl) : null;
    if (!classified) {
      summary.skipped++;
      console.log(`${label} skip unsupported Twitter/X URL ${sourceUrl ?? bookmark.content?.url ?? '(missing URL)'}`);
      continue;
    }
    if (!options.includeExisting && hasCaptureForSubject(db, classified.kind, classified.subjectId)) {
      summary.skipped++;
      console.log(`${label} skip already captured ${classified.kind} ${classified.subjectId}`);
      continue;
    }
    if (options.limit !== undefined && eligible >= options.limit) {
      console.log(`${label} stop --limit ${options.limit} reached`);
      break;
    }
    eligible++;
    const pdfPath = findPdfPath(pdfs, classified);
    if (options.dryRun) {
      console.log(`${label} ok dry-run ${classified.kind} ${classified.subjectId} pdf=${pdfPath ?? 'none'} ${classified.url}`);
      continue;
    }

    summary.attempted++;
    try {
      if (classified.kind === 'tweet') {
        const result = await harvestTweetToDb({
          url: classified.url,
          bookmarkedAt: bookmark.createdAt,
          pdfPath,
          origin: 'backfill',
        });
        summary.harvested++;
        summary.tweetsUpserted += result.tweetsUpserted;
        summary.imagesDownloaded += result.imagesDownloaded;
        console.log(`${label} ok tweet ${result.tweetId} tweets=${result.tweetsUpserted} images=${result.imagesDownloaded} pages=${result.pagesFetched} pdf=${pdfPath ?? 'none'}`);
      } else {
        const result = await harvestArticleToDb({
          url: classified.url,
          bookmarkedAt: bookmark.createdAt,
          pdfPath,
          origin: 'backfill',
        });
        summary.harvested++;
        summary.imagesDownloaded += result.imagesDownloaded;
        console.log(`${label} ok article ${result.articleId} images=${result.imagesDownloaded} pages=${result.pagesFetched} from=${result.harvestedFrom} pdf=${pdfPath ?? 'none'}`);
      }
    } catch (error) {
      summary.failed++;
      const code = error instanceof TwitterHarvestError ? error.code : 'unexpected';
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${label} fail ${classified.kind} ${classified.subjectId} [${code}] ${message}`);
    }

    if (!stopRequested && options.delayMs > 0 && index < bookmarks.length - 1) {
      await delay(options.delayMs);
    }
  }

  logSummary(summary, options.dryRun, stopRequested);
  if (!options.dryRun && summary.attempted > 0 && summary.failed === summary.attempted) {
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => {
  if (!stopRequested) {
    stopRequested = true;
    console.log('\nSIGINT received; finishing the current item before summarizing…');
  }
});

main().catch((error) => {
  console.error('Twitter/X backfill failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
