/**
 * Re-run captured-PDF matching and repair structured Twitter metadata.
 *
 * Run on the HOST (never in Docker; the native SQLite binary is host-built):
 *   KARAKEEP_API_BASE=http://localhost:3001 NITTER_HOST=http://localhost:8080 \
 *     npx tsx --env-file=.env scripts/rematch-twitter-links.ts
 *   KARAKEEP_API_BASE=http://localhost:3001 NITTER_HOST=http://localhost:8080 \
 *     npx tsx --env-file=.env scripts/rematch-twitter-links.ts --repair-hosts --dry-run
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { load } from 'cheerio';
import { env } from '../src/config/env.js';
import { canonicalTwitterHref } from '../src/twitter/parse.js';
import { normalizeIndexedUrl } from '../src/twitter/pdf-index.js';
import type { TwitterDatabase } from '../src/twitter/db.js';

interface Options {
  dryRun: boolean;
  repairHosts: boolean;
}

function parseArgs(argv: string[]): Options {
  const options = { dryRun: false, repairHosts: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--repair-hosts') options.repairHosts = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function repairHtml(html: string): string {
  const $ = load(html, null, false);
  let changed = false;
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const repaired = canonicalTwitterHref(href);
    if (repaired !== href) {
      $(element).attr('href', repaired);
      changed = true;
    }
  });
  return changed ? $.root().html() ?? html : html;
}

async function repairHosts(
  db: TwitterDatabase,
  dryRun: boolean,
  matchUrlToPdf: (db: TwitterDatabase, url: string) => string | null,
): Promise<{ links: number; tweetHtml: number; articleHtml: number; rematched: number }> {
  const summary = { links: 0, tweetHtml: 0, articleHtml: 0, rematched: 0 };
  const linkRows = db.prepare(
    'SELECT tweet_id, position, url FROM tweet_links ORDER BY tweet_id, position',
  ).all() as Array<{ tweet_id: string; position: number; url: string }>;
  const changedLinks = linkRows.flatMap((row) => {
    const url = canonicalTwitterHref(row.url);
    return url === row.url ? [] : [{ ...row, repairedUrl: url }];
  });
  summary.links = changedLinks.length;

  const htmlTables = [
    { table: 'tweets', id: 'id', column: 'content_html', counter: 'tweetHtml' as const },
    { table: 'articles', id: 'id', column: 'body_html', counter: 'articleHtml' as const },
  ];
  const changedHtml: Array<{
    table: string;
    idColumn: string;
    htmlColumn: string;
    id: string;
    html: string;
  }> = [];
  for (const item of htmlTables) {
    const rows = db.prepare(
      `SELECT ${item.id} AS id, ${item.column} AS html FROM ${item.table} WHERE ${item.column} IS NOT NULL`,
    ).all() as Array<{ id: string; html: string }>;
    for (const row of rows) {
      const repaired = repairHtml(row.html);
      if (repaired === row.html) continue;
      summary[item.counter]++;
      changedHtml.push({
        table: item.table,
        idColumn: item.id,
        htmlColumn: item.column,
        id: row.id,
        html: repaired,
      });
    }
  }

  for (const row of changedLinks) {
    if (matchUrlToPdf(db, row.repairedUrl)) summary.rematched++;
  }
  if (!dryRun) {
    const updateLink = db.prepare(`
      UPDATE tweet_links
      SET url = @url,
          url_normalized = @urlNormalized,
          pdf_path = @pdfPath,
          matched_at = CASE WHEN @pdfPath IS NULL THEN NULL ELSE @matchedAt END
      WHERE tweet_id = @tweetId AND position = @position
    `);
    db.transaction(() => {
      for (const row of changedLinks) {
        const pdfPath = matchUrlToPdf(db, row.repairedUrl);
        updateLink.run({
          url: row.repairedUrl,
          urlNormalized: normalizeIndexedUrl(row.repairedUrl),
          pdfPath,
          matchedAt: new Date().toISOString(),
          tweetId: row.tweet_id,
          position: row.position,
        });
      }
      for (const row of changedHtml) {
        db.prepare(
          `UPDATE ${row.table} SET ${row.htmlColumn} = ? WHERE ${row.idColumn} = ?`,
        ).run(row.html, row.id);
      }
    })();
  }
  return summary;
}

async function localVideoFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const mediaRoot = path.join(env.DATA_DIR, 'media');
  let weeks;
  try {
    weeks = await readdir(mediaRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw error;
  }
  for (const week of weeks) {
    if (!week.isDirectory()) continue;
    let entries;
    try {
      entries = await readdir(path.join(mediaRoot, week.name, 'videos'), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
        files.set(entry.name.toLowerCase(), entry.name);
      }
    }
  }
  return files;
}

async function backfillLocalVideos(
  db: TwitterDatabase,
  dryRun: boolean,
): Promise<number> {
  const files = await localVideoFiles();
  const rows = db.prepare(`
    SELECT tm.tweet_id, tm.position, t.username
    FROM tweet_media tm
    JOIN tweets t ON t.id = tm.tweet_id
    WHERE tm.kind IN ('video', 'gif')
      AND tm.local_video IS NULL
      AND t.username IS NOT NULL
  `).all() as Array<{ tweet_id: string; position: number; username: string }>;
  const hits = rows.flatMap((row) => {
    const candidates = [
      `x.com-${row.username}-post-${row.tweet_id}.mp4`,
      `twitter.com-${row.username}-post-${row.tweet_id}.mp4`,
    ];
    const file = candidates.map((candidate) => files.get(candidate.toLowerCase())).find(Boolean);
    return file ? [{ ...row, file }] : [];
  });
  if (!dryRun && hits.length > 0) {
    const update = db.prepare(
      'UPDATE tweet_media SET local_video = ? WHERE tweet_id = ? AND position = ? AND local_video IS NULL',
    );
    db.transaction(() => {
      for (const hit of hits) update.run(hit.file, hit.tweet_id, hit.position);
    })();
  }
  return hits.length;
}

async function main(): Promise<void> {
  if (existsSync('/.dockerenv')) {
    throw new Error(
      'Refusing to run in Docker: this script must use the host-built better-sqlite3 binary. Run it on the host with KARAKEEP_API_BASE=http://localhost:3001 and NITTER_HOST=http://localhost:8080.',
    );
  }
  const options = parseArgs(process.argv.slice(2));
  const [{ closeTwitterDb, getTwitterDb }, linkMatch, { refreshPdfIndex }] = await Promise.all([
    import('../src/twitter/db.js'),
    import('../src/twitter/link-match.js'),
    import('../src/twitter/pdf-index.js'),
  ]);
  const db = getTwitterDb();
  if (options.dryRun) db.exec('BEGIN');
  try {
    await refreshPdfIndex(db);
    let hostSummary = { links: 0, tweetHtml: 0, articleHtml: 0, rematched: 0 };
    if (options.repairHosts) {
      hostSummary = await repairHosts(db, options.dryRun, linkMatch.matchUrlToPdf);
    }
    const localVideos = await backfillLocalVideos(db, options.dryRun);
    const result = await linkMatch.rematchTweetLinks(db, {
      dryRun: options.dryRun,
      onMatch: options.dryRun
        ? (row) => {
            console.log(
              `would-match tweet=${row.tweetId} position=${row.position} pdf=${row.pdfPath} url=${row.url}`,
            );
          }
        : undefined,
    });
    console.log(
      `${options.dryRun ? 'Dry-run' : 'Rematch'} summary: checked=${result.checked} matched=${result.matched}`
      + ` repaired_links=${hostSummary.links} repaired_tweet_html=${hostSummary.tweetHtml}`
      + ` repaired_article_html=${hostSummary.articleHtml} repaired_and_matched=${hostSummary.rematched}`
      + ` local_videos=${localVideos}`,
    );
  } finally {
    if (options.dryRun && db.inTransaction) db.exec('ROLLBACK');
    closeTwitterDb();
  }
}

main().catch((error) => {
  console.error(
    'Twitter link rematch failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
