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

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { env } from '../config/env.js';
import { analyzePdfContent } from '../quality/pdf-content.js';
import { enrichDocumentMetadata } from './enrichment.js';
import { reembedEnrichmentInPlace } from '../utils/save-pdf.js';
import { readInfoDictField } from '../utils/pdf-info-dict.js';

export interface BackfillOptions {
  /** Find + report candidates but don't modify any files. */
  dryRun?: boolean;
  /** Stop after enriching this many files (candidates beyond it are left for a later run). */
  limit?: number;
  /** Restrict to a single weekly bin, e.g. "2026-W23". Omit to sweep all weeks. */
  week?: string;
  /** Progress sink (defaults to console.log). */
  onProgress?: (msg: string) => void;
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
  /** Per-file detail for the enriched set. */
  details: Array<{ file: string; title: string; language: string }>;
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
  const { dryRun = false, limit, week } = options;
  const log = options.onProgress ?? ((m: string) => console.log(m));

  const result: BackfillResult = {
    scanned: 0,
    bare: 0,
    enriched: 0,
    skippedNoText: 0,
    failed: 0,
    details: [],
  };

  const pdfPaths = await collectPdfPaths(week);
  log(`[backfill] Scanning ${pdfPaths.length} PDF(s)${week ? ` in ${week}` : ''}${dryRun ? ' (dry-run)' : ''}`);

  for (const filePath of pdfPaths) {
    if (limit !== undefined && result.enriched >= limit) {
      log(`[backfill] Reached limit of ${limit}; stopping (more candidates may remain)`);
      break;
    }
    result.scanned++;
    const name = path.basename(filePath);

    let buffer: Buffer;
    let pdfDoc: PDFDocument;
    try {
      buffer = await readFile(filePath);
      pdfDoc = await PDFDocument.load(buffer);
    } catch (error) {
      result.failed++;
      log(`[backfill] FAILED to read/parse ${name}: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    // Already enriched? EnrichedAt is written on every successful enrichment.
    if (readInfoDictField(pdfDoc, 'EnrichedAt')) continue;

    // Leave transcript PDFs alone — they're not articles and article-style
    // enrichment mislabels them (see the "Video Transcript" title issue).
    if (readInfoDictField(pdfDoc, 'DocType') === 'transcript') continue;

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
      result.details.push({ file: name, title: metadata.title, language: metadata.language });
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
