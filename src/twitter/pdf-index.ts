import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { env } from '../config/env.js';
import { normalizeBookmarkUrl } from '../urls/normalizer.js';
import type { TwitterDatabase } from './db.js';

const WEEK_RE = /^\d{4}-W\d{2}$/;
const PDF_DIRECTORIES = ['pdfs', 'transcripts', 'videos', 'podcasts'] as const;

export interface PdfIndexRefreshResult {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  skippedTooLarge: number;
}

interface ExistingPdfIndexRow {
  pdf_path: string;
  mtime_ms: number | null;
}

export function normalizeIndexedUrl(url: string): string | null {
  try {
    return normalizeBookmarkUrl(url);
  } catch {
    return null;
  }
}

export function stripUrlQuery(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function httpSubject(subject: string | undefined): string | null {
  if (!subject) return null;
  try {
    const parsed = new URL(subject.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? subject.trim()
      : null;
  } catch {
    return null;
  }
}

async function subjectFromPdf(pdfPath: string): Promise<string | null> {
  try {
    const bytes = await readFile(pdfPath);
    const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
    return httpSubject(pdfDoc.getSubject());
  } catch {
    return null;
  }
}

async function weeklyPdfPaths(dataDir: string): Promise<Array<{
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
}>> {
  const mediaRoot = path.join(dataDir, 'media');
  let weeks;
  try {
    weeks = await readdir(mediaRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const files: Array<{
    absolutePath: string;
    relativePath: string;
    mtimeMs: number;
    size: number;
  }> = [];
  for (const week of weeks) {
    if (!week.isDirectory() || !WEEK_RE.test(week.name)) continue;
    for (const directory of PDF_DIRECTORIES) {
      const directoryPath = path.join(mediaRoot, week.name, directory);
      let entries;
      try {
        entries = await readdir(directoryPath, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pdf')) continue;
        const absolutePath = path.join(directoryPath, entry.name);
        try {
          const metadata = await stat(absolutePath);
          files.push({
            absolutePath,
            relativePath: path.posix.join('media', week.name, directory, entry.name),
            mtimeMs: metadata.mtimeMs,
            size: metadata.size,
          });
        } catch {
          // A file may disappear between readdir and stat; the next refresh will see it.
        }
      }
    }
  }
  return files;
}

export async function refreshPdfIndex(
  db: TwitterDatabase,
  options: { dataDir?: string; maxBytes?: number } = {},
): Promise<PdfIndexRefreshResult> {
  const dataDir = options.dataDir ?? env.DATA_DIR;
  const configuredMaxBytes = Number.parseInt(
    process.env.TWITTER_PDF_INDEX_MAX_BYTES ?? String(64 * 1024 * 1024),
    10,
  );
  const maxBytes = options.maxBytes ?? (
    Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes >= 0
      ? configuredMaxBytes
      : 64 * 1024 * 1024
  );
  const existingRows = db.prepare(
    'SELECT pdf_path, mtime_ms FROM pdf_index',
  ).all() as ExistingPdfIndexRow[];
  const existing = new Map(existingRows.map((row) => [row.pdf_path, row]));
  const files = await weeklyPdfPaths(dataDir);
  const present = new Set(files.map((file) => file.relativePath));
  const result: PdfIndexRefreshResult = {
    scanned: 0,
    added: 0,
    updated: 0,
    removed: 0,
    skippedTooLarge: 0,
  };

  const upsert = db.prepare(`
    INSERT INTO pdf_index (
      pdf_path, url, url_normalized, url_no_query, mtime_ms, indexed_at
    ) VALUES (
      @pdfPath, @url, @urlNormalized, @urlNoQuery, @mtimeMs, @indexedAt
    )
    ON CONFLICT(pdf_path) DO UPDATE SET
      url = excluded.url,
      url_normalized = excluded.url_normalized,
      url_no_query = excluded.url_no_query,
      mtime_ms = excluded.mtime_ms,
      indexed_at = excluded.indexed_at
  `);

  for (const file of files) {
    const previous = existing.get(file.relativePath);
    if (previous?.mtime_ms === file.mtimeMs) continue;
    result.scanned++;
    const tooLarge = file.size > maxBytes;
    const url = tooLarge ? null : await subjectFromPdf(file.absolutePath);
    if (tooLarge) result.skippedTooLarge++;
    const urlNormalized = url ? normalizeIndexedUrl(url) : null;
    const urlNoQuery = urlNormalized ? stripUrlQuery(urlNormalized) : null;
    upsert.run({
      pdfPath: file.relativePath,
      url,
      urlNormalized,
      urlNoQuery,
      mtimeMs: file.mtimeMs,
      indexedAt: new Date().toISOString(),
    });
    if (previous) result.updated++;
    else result.added++;
  }

  if (files.length === 0 && existingRows.length > 0) {
    console.warn(JSON.stringify({
      event: 'twitter_pdf_index_prune_skipped',
      reason: 'scan returned zero files while index is non-empty',
      indexedRows: existingRows.length,
      timestamp: new Date().toISOString(),
    }));
  } else {
    const remove = db.prepare('DELETE FROM pdf_index WHERE pdf_path = ?');
    for (const row of existingRows) {
      if (present.has(row.pdf_path)) continue;
      result.removed += remove.run(row.pdf_path).changes;
    }
  }
  if (result.skippedTooLarge > 0) {
    console.warn(JSON.stringify({
      event: 'twitter_pdf_index_large_files_skipped',
      count: result.skippedTooLarge,
      maxBytes,
      timestamp: new Date().toISOString(),
    }));
  }
  return result;
}
