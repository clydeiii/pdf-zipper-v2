/**
 * Manual capture endpoint for the PDF Zipper Chrome plugin.
 *
 * Use case: the automated worker hits a paywall / captcha / bot wall.
 * User opens the page in their authenticated browser, clicks the extension,
 * the extension generates a clean PDF via Chrome DevTools Page.printToPDF
 * and POSTs it here. The server then runs the SAME enrichment pipeline as
 * the automated worker so manual captures are byte-compatible with auto
 * captures (same filename convention, same Info Dict fields, same weekly bin).
 *
 * Auth: protected by Cloudflare Access in production (and requireApiToken
 * as defense-in-depth if API_AUTH_TOKEN is set).
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import * as path from 'node:path';
import { requireApiToken } from '../auth.js';
import { savePdfToWeeklyBin } from '../../utils/save-pdf.js';
import { analyzePdfContent } from '../../quality/pdf-content.js';
import { enrichDocumentMetadata, type EnrichedMetadata } from '../../metadata/enrichment.js';
import { conversionQueue } from '../../queues/conversion.queue.js';
import { normalizeBookmarkUrl } from '../../urls/normalizer.js';
import { getISOWeekNumber } from '../../media/organization.js';

export const manualCaptureRouter = Router();

/** Plugin creator tag embedded in PDF Creator field — includes extension-reported version. */
const CREATOR_PREFIX = 'pdf-zipper-v2-chrome-plugin';

/** Body size limit for the JSON payload (PDF is base64-encoded). 25MB = ~18MB raw PDF. */
const BODY_LIMIT = '25mb';

interface ReadabilityInfo {
  title?: string | null;
  byline?: string | null;
  siteName?: string | null;
  lang?: string | null;
  publishedTime?: string | null;
  excerpt?: string | null;
  length?: number;
}

interface ManualCaptureBody {
  url: string;
  title?: string;
  originalUrl?: string;
  /** Base64-encoded PDF bytes (from chrome.debugger Page.printToPDF .data) */
  pdfBase64: string;
  /** Reader-view Markdown extracted client-side via Readability + Turndown (Obsidian Web Clipper pattern) */
  markdown?: string;
  /** Metadata from Mozilla Readability — title, byline, siteName, lang, publishedTime, excerpt, length */
  readability?: ReadabilityInfo;
  /** Chrome extension version string (e.g., "3.2.0") — embedded in PDF Creator */
  extensionVersion?: string;
  /** "page" (whole page) or "selection" (user highlighted a portion) */
  captureScope?: 'page' | 'selection';
  /** For selection scope: number of chars in the selected text */
  selectionChars?: number;
  /** For selection scope: first ~120 chars of the selection for reference */
  selectionPreview?: string;
}

function isValidUrl(urlString: string): boolean {
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find and remove failed BullMQ jobs whose URL matches the captured URL.
 * Matches on canonical (normalized) URL so www./protocol/trailing-slash
 * differences don't prevent removal.
 */
async function removeMatchingFailedJobs(capturedUrl: string): Promise<number> {
  const targetCanonical = normalizeBookmarkUrl(capturedUrl);
  let removed = 0;

  // Scan failed jobs (reasonable cap — BullMQ keeps ~2000 failed by default)
  const failedJobs = await conversionQueue.getFailed(0, 2000);
  for (const job of failedJobs) {
    const jobUrl = job.data?.url;
    const jobOriginalUrl = job.data?.originalUrl;
    if (!jobUrl) continue;

    const jobCanonical = normalizeBookmarkUrl(jobUrl);
    const jobOriginalCanonical = jobOriginalUrl ? normalizeBookmarkUrl(jobOriginalUrl) : null;

    if (jobCanonical === targetCanonical || jobOriginalCanonical === targetCanonical) {
      try {
        await job.remove();
        removed++;
        console.log(`[manual-capture] Removed matching failed job ${job.id} for ${jobUrl}`);
      } catch (error) {
        console.warn(`[manual-capture] Failed to remove job ${job.id}:`, error);
      }
    }
  }

  return removed;
}

manualCaptureRouter.post(
  '/',
  express.json({ limit: BODY_LIMIT }),
  requireApiToken,
  async (req: Request, res: Response): Promise<void> => {
    const startMs = Date.now();
    const body = req.body as Partial<ManualCaptureBody>;

    // Validate input
    if (!body.url || typeof body.url !== 'string' || !isValidUrl(body.url)) {
      res.status(400).json({ error: 'url is required and must be a valid URL' });
      return;
    }
    if (!body.pdfBase64 || typeof body.pdfBase64 !== 'string') {
      res.status(400).json({ error: 'pdfBase64 is required' });
      return;
    }

    // Decode PDF
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = Buffer.from(body.pdfBase64, 'base64');
    } catch (error) {
      res.status(400).json({ error: 'Invalid base64 in pdfBase64' });
      return;
    }

    if (pdfBuffer.length < 1024) {
      res.status(400).json({ error: `PDF too small (${pdfBuffer.length} bytes) — likely empty capture` });
      return;
    }

    // Quick magic-number check (PDF files start with %PDF-)
    if (pdfBuffer.slice(0, 5).toString() !== '%PDF-') {
      res.status(400).json({ error: 'Body does not appear to be a PDF (missing %PDF- header)' });
      return;
    }

    console.log(
      `[manual-capture] Received ${pdfBuffer.length} bytes for ${body.url}` +
        (body.title ? ` ("${body.title}")` : '')
    );

    try {
      // Extract text + run enrichment (same pipeline as the worker)
      let enrichedMetadata: EnrichedMetadata | undefined;
      try {
        const contentResult = await analyzePdfContent(pdfBuffer);
        console.log(
          `[manual-capture] Content: ${contentResult.charCount} chars, ${contentResult.pageCount} pages`
        );
        if (contentResult.extractedText && contentResult.extractedText.length > 100) {
          enrichedMetadata = await enrichDocumentMetadata(
            contentResult.extractedText,
            body.url,
            body.title
          );
          console.log(
            `[manual-capture] Enriched: "${enrichedMetadata.title}" [${enrichedMetadata.language}]`
          );
        }
      } catch (error) {
        console.warn(
          '[manual-capture] Enrichment failed (non-fatal):',
          error instanceof Error ? error.message : error
        );
      }

      // Archive wrapper handling: when the user captures an archive.is URL,
      // the extension sends originalUrl = the real article URL (e.g. ft.com).
      // Use that real URL for filename generation so the saved PDF reflects
      // the article, not the archive wrapper. Archive wrapper URL is
      // preserved in Info Dict `ViaArchive` for reference.
      let urlForSave = body.url;
      let archiveWrapperUrl: string | undefined;
      if (body.originalUrl && body.originalUrl !== body.url) {
        try {
          const viewed = new URL(body.url).hostname;
          const original = new URL(body.originalUrl).hostname;
          if (viewed !== original) {
            archiveWrapperUrl = body.url;
            urlForSave = body.originalUrl;
          }
        } catch { /* invalid URL, skip swap */ }
      }

      // Assemble extra Info Dict fields from client-side extraction
      const extraFields: Record<string, string | undefined> = {};
      const captureScope = body.captureScope === 'selection' ? 'selection' : 'page';
      extraFields.CaptureScope = captureScope;
      if (archiveWrapperUrl) extraFields.ViaArchive = archiveWrapperUrl;
      if (body.markdown && typeof body.markdown === 'string' && body.markdown.length > 0) {
        extraFields.Markdown = body.markdown;
        extraFields.MarkdownLength = String(body.markdown.length);
        extraFields.MarkdownExtractedBy = captureScope === 'selection' ? 'selection+turndown' : 'readability+turndown';
      }
      if (body.readability) {
        const r = body.readability;
        if (r.byline) extraFields.ReadabilityByline = r.byline;
        if (r.siteName) extraFields.ReadabilitySiteName = r.siteName;
        if (r.publishedTime) extraFields.ReadabilityPublishedTime = r.publishedTime;
        if (r.excerpt) extraFields.ReadabilityExcerpt = r.excerpt;
        if (r.lang) extraFields.ReadabilityLang = r.lang;
      }
      if (captureScope === 'selection') {
        if (body.selectionChars) extraFields.SelectionChars = String(body.selectionChars);
        if (body.selectionPreview) extraFields.SelectionPreview = body.selectionPreview;
      }

      // Selection captures get a distinct filename suffix so they don't overwrite
      // the full-page capture (and so multiple selections from the same URL don't
      // overwrite each other). Slug derived from first few words of selection.
      let filenameSuffix: string | undefined;
      if (captureScope === 'selection' && body.selectionPreview) {
        const slug = body.selectionPreview
          .toLowerCase()
          .replace(/['']/g, '')
          .replace(/[^a-z0-9\s-]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 1)
          .slice(0, 6)
          .join('-')
          .substring(0, 40);
        filenameSuffix = slug ? `-selection-${slug}` : '-selection';
      }

      // Compose Creator tag with extension-reported version (e.g. pdf-zipper-v2-chrome-plugin-v3.1.0)
      const versionSuffix =
        body.extensionVersion && /^[\d.]+$/.test(body.extensionVersion)
          ? `-v${body.extensionVersion}`
          : '-v3';
      const creatorTag = `${CREATOR_PREFIX}${versionSuffix}`;

      // Save to weekly bin — overwrites on filename collision (per product decision).
      // For archive.is captures, urlForSave == originalUrl (the real article URL),
      // so both filename AND Subject field reflect the source article, not the wrapper.
      const filePath = await savePdfToWeeklyBin(pdfBuffer, {
        url: urlForSave,
        title: body.title,
        originalUrl: urlForSave,
        enrichedMetadata,
        creatorOverride: creatorTag,
        extraInfoDictFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
        filenameSuffix,
      });

      // Compute weekId from the saved path
      const { year, week } = getISOWeekNumber(new Date());
      const weekId = `${year}-W${week.toString().padStart(2, '0')}`;

      // Remove matching failed jobs — check both the viewed URL (archive wrapper)
      // and the original article URL, since the failed job could have been
      // submitted under either
      let removedFailedJobs = await removeMatchingFailedJobs(body.url);
      if (archiveWrapperUrl) {
        removedFailedJobs += await removeMatchingFailedJobs(urlForSave);
      }

      const filename = path.basename(filePath);
      const durationMs = Date.now() - startMs;

      const mdLen = body.markdown ? body.markdown.length : 0;
      console.log(
        `[manual-capture] Saved ${filename} in ${durationMs}ms` +
          ` (enrichment: ${enrichedMetadata ? 'yes' : 'no'},` +
          ` markdown: ${mdLen > 0 ? `${mdLen} chars` : 'no'},` +
          ` removed ${removedFailedJobs} failed job(s))`
      );

      res.json({
        success: true,
        filename,
        filePath,
        weekId,
        removedFailedJobs,
        durationMs,
        markdownChars: mdLen,
        metadata: enrichedMetadata
          ? {
              title: enrichedMetadata.title,
              author: enrichedMetadata.author,
              publication: enrichedMetadata.publication,
              language: enrichedMetadata.language,
              tags: enrichedMetadata.tags,
              summary: enrichedMetadata.summary,
            }
          : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[manual-capture] Failed:', message);
      res.status(500).json({ error: 'Manual capture failed', detail: message });
    }
  }
);
