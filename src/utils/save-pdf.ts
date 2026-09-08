/**
 * Shared PDF saving helpers for the weekly bin.
 *
 * Used by both the conversion worker (automated captures) and the
 * manual-capture endpoint (Chrome plugin submissions). Keeping this in
 * one place guarantees manual and automatic captures produce
 * byte-compatible, Karpathy-aligned PDFs.
 */

import { writeFile, mkdir, readFile, readdir, unlink, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { setInfoDictFields, readInfoDictField, deleteInfoDictField } from './pdf-info-dict.js';
import { env } from '../config/env.js';
import { getISOWeekNumber } from '../media/organization.js';
import { isUsableEnrichment, type EnrichedMetadata } from '../metadata/enrichment.js';
import { classifyArticle, type DocType } from '../metadata/doc-type.js';

/**
 * Hook invoked after a PDF is written without usable enrichment (no metadata
 * at all, or an unusable reply). The enrichment-repair sweep registers itself
 * here at startup to keep a durable pending set — so a multi-day outage
 * can't age files out of a rolling window before repair gets to them.
 * Kept as an injected listener so this module stays free of Redis.
 */
type BarePdfListener = (filePath: string) => void;
let barePdfListener: BarePdfListener | null = null;
export function setBarePdfListener(listener: BarePdfListener | null): void {
  barePdfListener = listener;
}

const require = createRequire(import.meta.url);
const sanitizeFilename = require('sanitize-filename') as (input: string) => string;

/**
 * Convert a title to a URL-safe slug
 * Lowercase, spaces to dashes, remove special characters
 */
export function slugifyTitle(title: string): string {
  return title
    // Strip common site-name suffixes so all capture paths produce identical filenames
    .replace(/\s*[|–—-]\s*(Hacker News|YouTube|Reddit|Medium|Substack|The Verge|Ars Technica|TechCrunch|Bloomberg|WSJ|NYT|The New York Times)$/i, '')
    .replace(/\s*on X$/i, '')
    .replace(/\s*\/\s*X$/i, '')
    .toLowerCase()
    .replace(/['']/g, '')           // Remove apostrophes
    .replace(/[^a-z0-9\s-]/g, '')   // Remove special characters
    .replace(/\s+/g, '-')           // Spaces to dashes
    .replace(/-+/g, '-')            // Collapse multiple dashes
    .replace(/^-|-$/g, '')          // Trim leading/trailing dashes
    .substring(0, 50);              // Limit length
}

/** Check if URL is a Twitter/X URL */
export function isTwitterUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase()
      .replace(/^www\./, '')
      .replace(/^(?:mobile|m)\./, '');
    return host === 'x.com' || host === 'twitter.com';
  } catch {
    return false;
  }
}

/**
 * Derive a base filename (no extension) from a source URL, matching the
 * convention used for saved PDFs. Shared across PDF and media (MP4, etc.)
 * savers so a tweet's video and its captured-page PDF land with the same
 * base name in parallel `videos/` and `pdfs/` subfolders — the downstream
 * knowledge-base consumer links them by that shared name.
 *
 * - strips leading `www.`
 * - replaces path slashes with dashes
 * - falls back to a slugified title for non-descriptive paths (HN `/item`, etc.)
 * - for Twitter/X URLs, rewrites `-status-` to `-post-` (or `-article-` if known)
 */
/** Generic/placeholder PDF filename stems that carry no meaning on their own. */
const GENERIC_PDF_STEMS = new Set([
  'report', 'reports', 'paper', 'papers', 'document', 'documents', 'doc',
  'file', 'download', 'downloads', 'main', 'fulltext', 'full-text',
  'attachment', 'view', 'viewcontent', 'content', 'output', 'final',
  'draft', 'preprint', 'manuscript', 'pdf', 'untitled', 'index', 'default',
  'whitepaper', 'white-paper', 'ebook', 'slides', 'deck', 'presentation',
  'overview', 'brief', 'latest',
]);

/**
 * True when a filename/segment is a generic PDF name that should be replaced by
 * a content-derived title (e.g. "report.pdf", "report.pdf.pdf", "paper",
 * "main.pdf"). A trailing .pdf (even doubled) is stripped before the check.
 */
export function isGenericPdfBasename(name: string): boolean {
  const stem = name.replace(/(\.pdf)+$/i, '').toLowerCase().trim();
  return stem === '' || GENERIC_PDF_STEMS.has(stem);
}

/**
 * Delete copies of the same file (same basename, same type subdir) left in
 * OTHER week bins by an earlier capture of this URL. Basenames derive from
 * the canonical URL, so a same-basename file in another week IS a stale
 * capture of the same article — the just-written file is the fresh copy and
 * is never touched. Returns the number of stale copies removed.
 */
export async function deleteStaleCopiesInOtherWeeks(filePath: string): Promise<number> {
  const basename = path.basename(filePath);
  const typeDir = path.basename(path.dirname(filePath)); // pdfs / podcasts / …
  const mediaRoot = path.dirname(path.dirname(path.dirname(filePath)));
  let deleted = 0;
  let weekDirs: string[] = [];
  try {
    weekDirs = (await readdir(mediaRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^\d{4}-W\d{2}$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return 0;
  }
  for (const week of weekDirs) {
    const candidate = path.join(mediaRoot, week, typeDir, basename);
    if (path.resolve(candidate) === path.resolve(filePath)) continue;
    try {
      await unlink(candidate);
      deleted++;
      console.log(`Deleted stale copy from earlier week: ${candidate}`);
    } catch {
      // ENOENT for most weeks — expected
    }
  }
  return deleted;
}

/**
 * The `Replaces` value for a save that supersedes an earlier file: the old
 * basename when it differs from the new one, undefined otherwise (a same-name
 * overwrite needs no hint). Exported for testing.
 */
/**
 * Add/overwrite Info Dict fields on a finished PDF buffer (e.g. `Replaces` on
 * a transcript PDF generated by the media path, which doesn't go through
 * savePdfToWeeklyBin). Returns the original buffer if the PDF can't be loaded.
 */
export async function stampInfoDictFields(
  pdfBuffer: Buffer,
  fields: Record<string, string | null | undefined>
): Promise<Buffer> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
    setInfoDictFields(pdfDoc, fields);
    return Buffer.from(await pdfDoc.save());
  } catch {
    return pdfBuffer;
  }
}

export function replacesFor(oldFilePath: string | undefined, newFilename: string): string | undefined {
  if (!oldFilePath) return undefined;
  const oldBase = path.basename(oldFilePath);
  return oldBase && oldBase !== path.basename(newFilename) ? oldBase : undefined;
}

export function buildUrlBaseName(
  url: string,
  options: { title?: string; isXArticle?: boolean } = {}
): string {
  const { title, isXArticle } = options;
  try {
    const parsed = new URL(url);
    let hostname = parsed.hostname;
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    let pathname = parsed.pathname.replace(/\//g, '-');
    if (pathname.endsWith('-')) {
      pathname = pathname.slice(0, -1);
    }
    if (pathname.startsWith('-')) {
      pathname = pathname.substring(1);
    }
    // Strip a trailing .pdf so a direct-PDF URL (e.g. /report.pdf) doesn't
    // become "report.pdf" and then "report.pdf.pdf" when the save appends .pdf.
    pathname = pathname.replace(/\.pdf$/i, '');

    // Generic/placeholder PDF filenames carry no meaning — fall back to the
    // (enriched) title. An org publishing "report.pdf" / "paper.pdf" / "main.pdf"
    // is the motivating case; arxiv IDs and slugged filenames stay descriptive.
    const lastSeg = parsed.pathname.split('/').filter(Boolean).pop() || '';
    // Whole-path matches only: a bare section index that identifies the post
    // through the query string instead (qwen.ai/blog?id=qwen3.8 — every post
    // on the site would otherwise be saved as "qwen.ai-blog.pdf", each one
    // overwriting the last). A real slug under the same section
    // (replit.com/blog/defense-in-depth) reads as "blog-defense-in-depth" and
    // is untouched.
    const nonDescriptivePaths = ['item', 'comments', 'post', 'p', 'a', 'article', 'story', 's',
      'blog', 'blogs', 'news', 'posts', 'index', 'view', 'read'];
    const isNonDescriptive =
      !pathname ||
      nonDescriptivePaths.includes(pathname.toLowerCase()) ||
      isGenericPdfBasename(lastSeg);

    let baseName: string;
    if (isNonDescriptive && title) {
      const titleSlug = slugifyTitle(title);
      if (titleSlug) {
        baseName = `${hostname}-${titleSlug}`;
      } else {
        baseName = pathname ? `${hostname}-${pathname}` : hostname;
      }
    } else {
      baseName = pathname ? `${hostname}-${pathname}` : hostname;
    }

    // Filenames are lowercase everywhere. URL path segments preserve the
    // author's capitalisation (x.com/JeffLadish, github.com/Danau5tin), which
    // used to leak into PDF names while getMediaFilename lowercased the
    // matching MP4 — so `x.com-JeffLadish-post-123.pdf` and
    // `x.com-jeffladish-post-123.mp4` never paired, and the KB's
    // link-by-basename convention silently missed them.
    baseName = baseName.toLowerCase();

    if (isTwitterUrl(url) && baseName.includes('-status-')) {
      if (isXArticle === true) {
        baseName = baseName.replace('-status-', '-article-');
      } else if (isXArticle === false) {
        baseName = baseName.replace('-status-', '-post-');
      }
      // isXArticle === undefined: keep `-status-` (historical behavior for
      // paths that can't distinguish tweet vs article, e.g. manual capture)
    }

    return baseName;
  } catch {
    return 'document';
  }
}

/**
 * Embed source URL and enriched metadata in PDF document properties.
 *
 * Standard PDF Info Dict fields:
 *   Title, Author, Subject, Keywords, Creator, Producer, CreationDate
 *
 * Custom Info Dict fields (via getInfoDict):
 *   Summary, Language, Publication, PublishDate, Tags, Translation, EnrichedAt
 *
 * `creatorOverride` lets manual-capture paths set Creator to e.g.
 * "pdf-zipper-v2-chrome-plugin-v3" for version tracking.
 */
/**
 * Apply enrichment-derived metadata to an open PDFDocument.
 *
 * Writes only the fields that come from `enrichDocumentMetadata` (title,
 * author, tags, publish date, summary, language, publication, translation).
 * Leaves capture-context fields (Subject, Producer, DocType, Markdown, etc.)
 * and Creator untouched so this is safe to call on an already-saved PDF for
 * in-place backfill/salvage — `setInfoDictFields` merges rather than
 * replacing. Creator policy differs per caller, so it's handled outside.
 */
function applyEnrichedMetadata(
  pdfDoc: PDFDocument,
  metadata: EnrichedMetadata,
  options: { preserveExisting?: boolean } = {}
): void {
  // Repair mode: fields the original save may have set from a STRONGER
  // source than the LLM — the tweet's exact DOM timestamp (PublishDate),
  // smry's byline (Author) — must survive a re-enrichment. The capture path
  // writes those AFTER enrichment (extras win), but an in-place repair
  // calling this directly would have overwritten them with a guess.
  const keep = (field: string) => options.preserveExisting && !!readInfoDictField(pdfDoc, field);
  const keepAuthor = options.preserveExisting && !!pdfDoc.getAuthor();

  if (metadata.title) pdfDoc.setTitle(metadata.title);
  if (metadata.author && !keepAuthor) pdfDoc.setAuthor(metadata.author);
  if (metadata.tags.length > 0) pdfDoc.setKeywords(metadata.tags);
  if (metadata.publishDate && !keep('PublishDate')) {
    const pubDate = new Date(metadata.publishDate);
    if (!isNaN(pubDate.getTime())) pdfDoc.setCreationDate(pubDate);
  }

  // EnrichedAt means "validated enrichment is embedded" — it is only written
  // when there is a real summary. An attempt that produced nothing usable is
  // recorded as EnrichmentStatus=unusable_reply instead, so the auditor, the
  // repair sweep and the KB consumer can all tell "tried and failed" from
  // "enriched" (before 2026-09-04 both wrote EnrichedAt, and 16 empty-summary
  // tweet PDFs in one week looked enriched to every check).
  const usable = isUsableEnrichment(metadata);
  setInfoDictFields(pdfDoc, {
    Summary: metadata.summary,
    Language: metadata.language,
    Publication: metadata.publication,
    PublishDate: keep('PublishDate') ? undefined : metadata.publishDate,
    Tags: metadata.tags.length > 0 ? metadata.tags.join(', ') : undefined,
    Translation: metadata.translation,
    EnrichedAt: usable ? new Date().toISOString() : undefined,
    EnrichmentStatus: usable ? 'ok' : 'unusable_reply',
  });
  // setInfoDictFields skips falsy values, so a stale stamp from a legacy
  // file has to be removed explicitly.
  if (!usable) deleteInfoDictField(pdfDoc, 'EnrichedAt');
}

export async function embedPdfMetadata(
  pdfBuffer: Buffer,
  sourceUrl: string,
  originalUrl?: string,
  metadata?: EnrichedMetadata,
  creatorOverride?: string,
  extraInfoDictFields?: Record<string, string | null | undefined>,
  docTypeOverride?: DocType
): Promise<Buffer> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);

    // Enrichment-derived fields (title/author/tags/summary/…)
    if (metadata) {
      applyEnrichedMetadata(pdfDoc, metadata);
    }

    // Creator: explicit override wins, otherwise derived from publication
    if (creatorOverride) {
      pdfDoc.setCreator(creatorOverride);
    } else if (metadata?.publication) {
      pdfDoc.setCreator(`${metadata.publication} via pdf-zipper v2`);
    }

    // Store the original URL (with www preserved) in Subject field for rerun feature
    pdfDoc.setSubject(originalUrl || sourceUrl);

    // Add producer info with capture timestamp
    pdfDoc.setProducer(`pdf-zipper v2 - captured ${new Date().toISOString()}`);

    // DocType is always written (defaults to URL-based article classification —
    // research/news/blog) so the downstream KB can sort/filter without parsing
    // hostnames or filenames. Caller can override (e.g. transcript PDFs).
    const docType: DocType = docTypeOverride ?? classifyArticle(originalUrl || sourceUrl);
    setInfoDictFields(pdfDoc, { DocType: docType });

    // Caller-provided extra fields (e.g., Markdown from Chrome plugin's Readability extraction)
    if (extraInfoDictFields) {
      setInfoDictFields(pdfDoc, extraInfoDictFields);
    }

    const modifiedPdf = await pdfDoc.save();
    return Buffer.from(modifiedPdf);
  } catch (error) {
    console.warn(`Failed to embed PDF metadata for ${sourceUrl}:`, error);
    return pdfBuffer;
  }
}

/**
 * Re-embed enrichment metadata into a PDF that's already on disk, in place.
 *
 * Used when enrichment finishes *after* the synchronous request already saved
 * the PDF bare (manual-capture deadline salvage, #1) and by the backfill sweep
 * (#4). Only enrichment fields are touched; all existing Info Dict data
 * (Subject, DocType, Markdown, Readability*, CaptureScope…) is preserved.
 *
 * Returns true on success, false if the file couldn't be read/parsed.
 */
export async function reembedEnrichmentInPlace(
  filePath: string,
  metadata: EnrichedMetadata,
  options: { expectedMtimeMs?: number } = {}
): Promise<boolean> {
  try {
    const existing = await readFile(filePath);
    const pdfDoc = await PDFDocument.load(existing);
    applyEnrichedMetadata(pdfDoc, metadata, { preserveExisting: true });
    // Preserve whatever Creator the original save wrote (e.g. the Chrome-plugin
    // tag); only derive from publication when the field is genuinely empty.
    if (metadata.publication && !pdfDoc.getCreator()) {
      pdfDoc.setCreator(`${metadata.publication} via pdf-zipper v2`);
    }
    const out = await pdfDoc.save();
    // Lost-update guard: the caller read this file, spent ~30s on an LLM
    // call, and is about to write bytes derived from that read. If a rerun
    // or re-bookmark replaced the file meanwhile, writing would resurrect the
    // OLD capture with new metadata. Compare against the mtime the caller
    // observed and refuse the write if it moved.
    if (options.expectedMtimeMs !== undefined) {
      const now = await stat(filePath);
      if (Math.abs(now.mtimeMs - options.expectedMtimeMs) > 1) {
        console.warn(JSON.stringify({
          event: 'reembed_skipped_file_changed',
          file: filePath,
          expectedMtimeMs: options.expectedMtimeMs,
          actualMtimeMs: now.mtimeMs,
          timestamp: new Date().toISOString(),
        }));
        return false;
      }
    }
    await writeFile(filePath, Buffer.from(out));
    return true;
  } catch (error) {
    console.warn(`Failed to re-embed enrichment for ${filePath}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

export interface SavePdfOptions {
  url: string;
  title?: string;
  bookmarkedAt?: string;
  originalUrl?: string;
  isXArticle?: boolean;
  enrichedMetadata?: EnrichedMetadata;
  creatorOverride?: string;
  /** Additional Info Dict fields to embed (e.g., Markdown from client-side extraction) */
  extraInfoDictFields?: Record<string, string | null | undefined>;
  /** Optional suffix appended to the generated baseName before .pdf (e.g., "-selection-key-quote") */
  filenameSuffix?: string;
  /** Override the URL-based DocType classification (e.g. 'transcript' for video/podcast transcripts) */
  docType?: DocType;
  /**
   * Path of the earlier capture of this URL that this save supersedes (rerun
   * flows thread it through). When the new filename differs, its basename is
   * written to the `Replaces` Info Dict field so the KB consumer can drop the
   * old file; a same-name overwrite needs no hint.
   */
  oldFilePath?: string;
}

/**
 * Save PDF to weekly bin directory
 * Path: {DATA_DIR}/media/{year}-W{week}/pdfs/{filename}.pdf
 *
 * Filename format: {hostname}{pathname}.pdf
 * - Slashes replaced with dashes
 * - Trailing dashes removed
 * - www. prefix stripped from hostname
 * - Non-descriptive paths (item/comments/post/…) replaced with slugified title
 * - Twitter/X URLs get -post- or -article- instead of -status-
 */
export async function savePdfToWeeklyBin(
  pdfBuffer: Buffer,
  options: SavePdfOptions
): Promise<string> {
  const { url, title, bookmarkedAt, originalUrl, isXArticle, enrichedMetadata, creatorOverride, extraInfoDictFields, filenameSuffix, docType, oldFilePath } = options;

  // Use bookmarkedAt or current date for week calculation
  const date = bookmarkedAt ? new Date(bookmarkedAt) : new Date();
  const { year, week } = getISOWeekNumber(date);
  const weekStr = week.toString().padStart(2, '0');

  // Build directory path
  const dataDir = env.DATA_DIR || './data';
  const pdfDir = path.join(dataDir, 'media', `${year}-W${weekStr}`, 'pdfs');

  // Ensure directory exists
  await mkdir(pdfDir, { recursive: true });

  // Generate filename from URL, with title fallback for non-descriptive paths.
  // Prefer the enriched title (the real document headline) over the raw job
  // title/Content-Disposition for that fallback — it's what makes a generic
  // "report.pdf" become a meaningful, unique name.
  // Shared helper so media enclosures (MP4s) produce matching base names and
  // the downstream KB consumer can link them.
  const filenameTitle = enrichedMetadata?.title || title;
  let baseName = buildUrlBaseName(url, { title: filenameTitle, isXArticle });

  // Sanitize and truncate baseName, reserving room for the optional suffix so
  // a long URL can't truncate the suffix off and collide with the full-page capture.
  const suffix = filenameSuffix ?? '';
  const budget = Math.max(1, 140 - suffix.length);
  baseName = sanitizeFilename(baseName).substring(0, budget);
  if (suffix) {
    baseName = `${baseName}${suffix}`;
  }
  const filename = `${baseName}.pdf`;
  const filePath = path.join(pdfDir, filename);

  // Embed source URL and enriched metadata in PDF. The filename is settled
  // first so a rerun that lands under a new name can record the old one.
  const replaces = replacesFor(oldFilePath, filename);
  const pdfWithMetadata = await embedPdfMetadata(
    pdfBuffer,
    url,
    originalUrl,
    enrichedMetadata,
    creatorOverride,
    replaces ? { ...(extraInfoDictFields ?? {}), Replaces: replaces } : extraInfoDictFields,
    docType
  );

  // Write PDF with all metadata embedded directly (writeFile overwrites)
  await writeFile(filePath, pdfWithMetadata);

  // Transcript PDFs are not article-enriched; everything else that landed
  // without a usable summary is queued for the repair sweep.
  if (docType !== 'transcript' && (!enrichedMetadata || !isUsableEnrichment(enrichedMetadata))) {
    try { barePdfListener?.(filePath); } catch { /* never fail a save over bookkeeping */ }
  }

  // Re-capture freshness: the same URL captured in an earlier ISO week left a
  // same-basename copy in that week's bin. One canonical copy wins (this one);
  // without this, a rerun or re-bookmark that crosses a week boundary leaves
  // the stale version exportable from the old week forever. Non-fatal.
  try {
    await deleteStaleCopiesInOtherWeeks(filePath);
  } catch { /* cleanup is best-effort */ }

  return filePath;
}
