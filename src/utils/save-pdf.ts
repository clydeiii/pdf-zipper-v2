/**
 * Shared PDF saving helpers for the weekly bin.
 *
 * Used by both the conversion worker (automated captures) and the
 * manual-capture endpoint (Chrome plugin submissions). Keeping this in
 * one place guarantees manual and automatic captures produce
 * byte-compatible, Karpathy-aligned PDFs.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { setInfoDictFields } from './pdf-info-dict.js';
import { env } from '../config/env.js';
import { getISOWeekNumber } from '../media/organization.js';
import type { EnrichedMetadata } from '../metadata/enrichment.js';
import { classifyArticle, type DocType } from '../metadata/doc-type.js';

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
    const host = parsed.hostname.toLowerCase();
    return host === 'x.com' || host === 'twitter.com' || host === 'www.x.com' || host === 'www.twitter.com';
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

    const nonDescriptivePaths = ['item', 'comments', 'post', 'p', 'a', 'article', 'story', 's'];
    const isNonDescriptive = !pathname || nonDescriptivePaths.includes(pathname.toLowerCase());

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

    // Standard fields from enrichment
    if (metadata) {
      if (metadata.title) pdfDoc.setTitle(metadata.title);
      if (metadata.author) pdfDoc.setAuthor(metadata.author);
      if (metadata.tags.length > 0) pdfDoc.setKeywords(metadata.tags);
      if (metadata.publishDate) {
        const pubDate = new Date(metadata.publishDate);
        if (!isNaN(pubDate.getTime())) pdfDoc.setCreationDate(pubDate);
      }
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

    // Custom fields via Info Dict (for data that doesn't map to standard fields).
    // DocType is always written (defaults to URL-based article classification —
    // research/news/blog) so the downstream KB can sort/filter without parsing
    // hostnames or filenames. Caller can override (e.g. transcript PDFs).
    const docType: DocType = docTypeOverride ?? classifyArticle(originalUrl || sourceUrl);
    if (metadata) {
      setInfoDictFields(pdfDoc, {
        Summary: metadata.summary,
        Language: metadata.language,
        Publication: metadata.publication,
        PublishDate: metadata.publishDate,
        Tags: metadata.tags.length > 0 ? metadata.tags.join(', ') : undefined,
        Translation: metadata.translation,
        DocType: docType,
        EnrichedAt: new Date().toISOString(),
      });
    } else {
      setInfoDictFields(pdfDoc, { DocType: docType });
    }

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
  const { url, title, bookmarkedAt, originalUrl, isXArticle, enrichedMetadata, creatorOverride, extraInfoDictFields, filenameSuffix, docType } = options;

  // Embed source URL and enriched metadata in PDF
  const pdfWithMetadata = await embedPdfMetadata(
    pdfBuffer,
    url,
    originalUrl,
    enrichedMetadata,
    creatorOverride,
    extraInfoDictFields,
    docType
  );

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
  // Shared helper so media enclosures (MP4s) produce matching base names and
  // the downstream KB consumer can link them.
  let baseName = buildUrlBaseName(url, { title, isXArticle });

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

  // Write PDF with all metadata embedded directly (writeFile overwrites)
  await writeFile(filePath, pdfWithMetadata);

  return filePath;
}
