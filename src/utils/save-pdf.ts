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

const require = createRequire(import.meta.url);
const sanitizeFilename = require('sanitize-filename') as (input: string) => string;

/**
 * Convert a title to a URL-safe slug
 * Lowercase, spaces to dashes, remove special characters
 */
export function slugifyTitle(title: string): string {
  return title
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
  extraInfoDictFields?: Record<string, string | null | undefined>
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

    // Custom fields via Info Dict (for data that doesn't map to standard fields)
    if (metadata) {
      setInfoDictFields(pdfDoc, {
        Summary: metadata.summary,
        Language: metadata.language,
        Publication: metadata.publication,
        PublishDate: metadata.publishDate,
        Tags: metadata.tags.length > 0 ? metadata.tags.join(', ') : undefined,
        Translation: metadata.translation,
        EnrichedAt: new Date().toISOString(),
      });
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
  const { url, title, bookmarkedAt, originalUrl, isXArticle, enrichedMetadata, creatorOverride, extraInfoDictFields, filenameSuffix } = options;

  // Embed source URL and enriched metadata in PDF
  const pdfWithMetadata = await embedPdfMetadata(
    pdfBuffer,
    url,
    originalUrl,
    enrichedMetadata,
    creatorOverride,
    extraInfoDictFields
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

  // Generate filename from URL, with title fallback for non-descriptive paths
  let baseName: string;
  try {
    const parsed = new URL(url);
    // Strip www. prefix for cleaner names
    let hostname = parsed.hostname;
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    // Replace slashes with dashes, remove trailing dash
    let pathname = parsed.pathname.replace(/\//g, '-');
    if (pathname.endsWith('-')) {
      pathname = pathname.slice(0, -1);
    }
    // Remove leading dash if present (from leading /)
    if (pathname.startsWith('-')) {
      pathname = pathname.substring(1);
    }

    // Check if pathname is non-descriptive (needs title fallback)
    const nonDescriptivePaths = ['item', 'comments', 'post', 'p', 'a', 'article', 'story', 's'];
    const isNonDescriptive = !pathname || nonDescriptivePaths.includes(pathname.toLowerCase());

    // Use title for non-descriptive paths or empty paths
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

    // For Twitter/X URLs, replace "status" with more descriptive term
    if (isTwitterUrl(url) && baseName.includes('-status-')) {
      if (isXArticle === true) {
        baseName = baseName.replace('-status-', '-article-');
      } else if (isXArticle === false) {
        baseName = baseName.replace('-status-', '-post-');
      }
    }
  } catch {
    baseName = 'document';
  }

  // Apply optional suffix before sanitization (e.g., "-selection-quote-slug")
  if (filenameSuffix) {
    baseName = `${baseName}${filenameSuffix}`;
  }

  // Sanitize and truncate filename
  baseName = sanitizeFilename(baseName).substring(0, 140);
  const filename = `${baseName}.pdf`;
  const filePath = path.join(pdfDir, filename);

  // Write PDF with all metadata embedded directly (writeFile overwrites)
  await writeFile(filePath, pdfWithMetadata);

  return filePath;
}
