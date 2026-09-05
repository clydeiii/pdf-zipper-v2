/**
 * Backfill enrichment metadata for PDFs that were saved bare.
 *
 * A PDF lands without enrichment when the AI step failed or lost a deadline
 * race at capture time — most commonly the manual-capture path, whose
 * synchronous request gives up on Ollama after 75s (see manual-capture.ts) and
 * the conversion worker's non-fatal enrichment catch. The salvage path (#1)
 * fixes future stragglers; this sweep (#4) repairs the ones already on disk.
 *
 * Each saved PDF is self-describing (Karpathy KB pattern): the source URL lives
 * in the Subject field and the page title in Title, so we can re-run the exact
 * same enrichment pipeline from the file alone — no BullMQ/job state required.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { env } from '../config/env.js';
import { analyzePdfContent } from '../quality/pdf-content.js';
import { enrichDocumentMetadata, isUsableEnrichment } from './enrichment.js';
import { reembedEnrichmentInPlace } from '../utils/save-pdf.js';
import { readInfoDictField } from '../utils/pdf-info-dict.js';

export interface BackfillOptions {
  /** Find + report candidates but don't modify any files. */
  dryRun?: boolean;
  /** Stop after enriching this many files (candidates beyond it are left for a later run). */
  limit?: number;
  /** Restrict to a single weekly bin, e.g. "2026-W23". Omit to sweep all weeks. */
  week?: string;
  /**
   * Only consider files modified at/after this epoch-ms timestamp. The
   * scheduled repair sweep uses a 48h window so it never touches history
   * (exports are forward-looking; old files live on the airgapped side).
   */
  sinceMs?: number;
  /**
   * Also treat a PDF whose EnrichedAt is set but whose Summary is empty as
   * bare. That is what a malformed LLM reply left behind before enrichment
   * switched to structured JSON output — the file looks enriched to the
   * EnrichedAt check and ships with no summary/tags.
   */
  includeEmptySummary?: boolean;
  /**
   * Explicit file list instead of a directory scan (the repair sweep's
   * durable pending set). `week`/`sinceMs` are ignored when this is given.
   */
  files?: string[];
  /** Progress sink (defaults to console.log). */
  onProgress?: (msg: string) => void;
}

/**
 * Classify a loaded PDF for the sweep: `bare` = never enriched, `empty` =
 * enriched but the summary is blank, `ok` = carries a summary,
 * `transcript` = not an article (left alone). Exported for the auditor so
 * both agree on what "unenriched" means.
 */
export function classifyEnrichmentState(pdfDoc: PDFDocument): 'ok' | 'bare' | 'empty' | 'transcript' {
  if (readInfoDictField(pdfDoc, 'DocType') === 'transcript') return 'transcript';
  if (!readInfoDictField(pdfDoc, 'EnrichedAt')) return 'bare';
  const summary = readInfoDictField(pdfDoc, 'Summary');
  return isUsableEnrichment({ summary: summary ?? '' }) ? 'ok' : 'empty';
}

export interface BackfillResult {
  scanned: number;
  /** Bare = no EnrichedAt field (enrichment never completed). */
  bare: number;
  /** Successfully backfilled (or would be, in dry-run). */
  enriched: number;
  /** Bare but too little extractable text to enrich (likely image-only / truncated). */
  skippedNoText: number;
  /** Bare but parse/enrich/write errored. */
  failed: number;
  /** Per-file detail for the enriched set (plus `gone` entries for listed files that no longer exist). */
  details: Array<{ file: string; title: string; language: string; gone?: boolean }>;
}

/** Min extractable chars to bother enriching — matches the capture-path gate. */
const MIN_TEXT_CHARS = 100;

const WEEK_DIR_PATTERN = /^\d{4}-W\d{2}$/;

/**
 * Collect every `*.pdf` under `{DATA_DIR}/media/{year-week}/pdfs/`, optionally
 * limited to a single week.
 */
async function collectPdfPaths(week?: string): Promise<string[]> {
  const mediaDir = path.join(env.DATA_DIR || './data', 'media');
  let weekDirs: string[];
  try {
    weekDirs = (await readdir(mediaDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && WEEK_DIR_PATTERN.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  if (week) weekDirs = weekDirs.filter((w) => w === week);

  const paths: string[] = [];
  for (const w of weekDirs) {
    const pdfsDir = path.join(mediaDir, w, 'pdfs');
    try {
      const files = await readdir(pdfsDir);
      for (const f of files) {
        if (f.toLowerCase().endsWith('.pdf')) paths.push(path.join(pdfsDir, f));
      }
    } catch {
      /* no pdfs/ subdir this week */
    }
  }
  return paths.sort();
}

/**
 * Sweep saved PDFs and backfill enrichment for any that are missing it.
 */
export async function backfillBarePdfs(options: BackfillOptions = {}): Promise<BackfillResult> {
  const { dryRun = false, limit, week, sinceMs, includeEmptySummary = false, files } = options;
  const log = options.onProgress ?? ((m: string) => console.log(m));

  const result: BackfillResult = {
    scanned: 0,
    bare: 0,
    enriched: 0,
    skippedNoText: 0,
    failed: 0,
    details: [],
  };

  const pdfPaths = files ?? await collectPdfPaths(week);
  log(`[backfill] Scanning ${pdfPaths.length} PDF(s)${week ? ` in ${week}` : ''}${dryRun ? ' (dry-run)' : ''}`);

  for (const filePath of pdfPaths) {
    if (limit !== undefined && result.enriched >= limit) {
      log(`[backfill] Reached limit of ${limit}; stopping (more candidates may remain)`);
      break;
    }
    const name = path.basename(filePath);

    // Window filter first — it's a stat, not a parse, so an all-weeks sweep
    // with a 48h window costs almost nothing.
    if (sinceMs !== undefined && !files) {
      try {
        if ((await stat(filePath)).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
    }
    result.scanned++;

    let buffer: Buffer;
    let pdfDoc: PDFDocument;
    try {
      buffer = await readFile(filePath);
      pdfDoc = await PDFDocument.load(buffer);
    } catch (error) {
      // A file from the explicit list that no longer exists (rerun renamed it,
      // retention swept it) is simply not a candidate any more.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        result.details.push({ file: name, title: '', language: '', gone: true });
        continue;
      }
      result.failed++;
      log(`[backfill] FAILED to read/parse ${name}: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    // Already enriched? EnrichedAt is written on every successful enrichment.
    // Transcript PDFs are left alone — they're not articles and article-style
    // enrichment mislabels them (see the "Video Transcript" title issue).
    const state = classifyEnrichmentState(pdfDoc);
    if (state === 'ok' || state === 'transcript') continue;
    if (state === 'empty' && !includeEmptySummary) continue;

    result.bare++;

    // Reconstruct enrichment inputs from the self-describing PDF.
    const sourceUrl = pdfDoc.getSubject() || '';
    const pageTitle = pdfDoc.getTitle() || undefined;
    if (!sourceUrl) {
      result.failed++;
      log(`[backfill] SKIP ${name}: no source URL in Subject field`);
      continue;
    }

    let extractedText: string | undefined;
    try {
      const content = await analyzePdfContent(buffer);
      extractedText = content.extractedText;
    } catch {
      /* fall through to no-text handling */
    }

    if (!extractedText || extractedText.length <= MIN_TEXT_CHARS) {
      result.skippedNoText++;
      log(`[backfill] SKIP ${name}: only ${extractedText?.length ?? 0} chars of text`);
      continue;
    }

    if (dryRun) {
      result.enriched++;
      log(`[backfill] WOULD enrich ${name} (${extractedText.length} chars, url=${sourceUrl})`);
      continue;
    }

    try {
      const metadata = await enrichDocumentMetadata(extractedText, sourceUrl, pageTitle);
      const ok = await reembedEnrichmentInPlace(filePath, metadata);
      if (!ok) {
        result.failed++;
        log(`[backfill] FAILED to write ${name}`);
        continue;
      }
      result.enriched++;
      result.details.push({ file: filePath, title: metadata.title, language: metadata.language });
      log(`[backfill] Enriched ${name}: "${metadata.title}" [${metadata.language}]`);
    } catch (error) {
      result.failed++;
      log(`[backfill] FAILED to enrich ${name}: ${error instanceof Error ? error.message : error}`);
    }
  }

  log(
    `[backfill] Done: scanned=${result.scanned} bare=${result.bare} ` +
      `enriched=${result.enriched} skippedNoText=${result.skippedNoText} failed=${result.failed}`
  );
  return result;
}
