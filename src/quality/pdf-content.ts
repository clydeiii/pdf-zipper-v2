/**
 * PDF content analysis for detecting truncated articles
 *
 * Problem: Screenshot-based quality check can pass when top of page looks good
 * (headline + hero image) but actual PDF content is truncated (paywall, lazy load failure).
 *
 * Solution: Extract text from PDF and check if content seems complete.
 * A 2.7MB PDF with only 500 chars of text is suspicious - likely a big photo
 * with truncated article body.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// pdf-parse v2.x exports PDFParse as a class
const pdfParseModule = require('pdf-parse') as {
  PDFParse: new (data: Uint8Array) => {
    load(): Promise<void>;
    getInfo(): Promise<{ total: number; info: Record<string, unknown> }>;
    getText(): Promise<{ text: string; pages: Array<{ text: string; num: number }>; total: number }>;
  };
};
const PDFParse = pdfParseModule.PDFParse;

/**
 * Result of PDF content analysis
 */
export interface PdfContentResult {
  /** Whether the PDF appears to have sufficient content */
  passed: boolean;
  /** Number of pages in the PDF */
  pageCount: number;
  /** Total character count (excluding excessive whitespace) */
  charCount: number;
  /** PDF size in bytes */
  pdfSize: number;
  /** Characters per KB ratio */
  charsPerKb: number;
  /** Reason for failure (if failed) */
  reason?: string;
}

/**
 * Minimum characters expected for a legitimate article PDF
 * Very short content suggests truncation
 */
const MIN_ARTICLE_CHARS = 500;

/**
 * For large PDFs (>500KB), expect more text content
 * A big PDF with little text = big images but truncated article
 */
const LARGE_PDF_THRESHOLD = 500 * 1024; // 500KB
const MIN_CHARS_FOR_LARGE_PDF = 1000;

/**
 * Chars-per-KB ratio threshold
 * Normal article PDFs have 50-200+ chars/KB
 * Image-heavy truncated PDFs might have <10 chars/KB
 */
const MIN_CHARS_PER_KB = 5;

/**
 * Absolute character threshold that bypasses ratio check
 * If a PDF has this much text, it's clearly not truncated regardless of ratio
 * (e.g., image-heavy tech articles with lots of screenshots)
 */
const SUFFICIENT_CHARS_BYPASS_RATIO = 3000;

/**
 * Chars-per-page threshold that bypasses ratio check
 * Short announcement pages with images may have low total chars but reasonable per-page content
 * (e.g., ollama.com/blog/launch - 1678 chars / 3 pages = 559 chars/page)
 */
const MIN_CHARS_PER_PAGE_BYPASS = 400;

/**
 * Error page patterns - if any of these appear, the page is likely a 404 or error
 * Case-insensitive matching
 */
const ERROR_PAGE_PATTERNS = [
  /page\s*(can'?t|cannot|could\s*n[o']t)\s*be\s*found/i,
  /404\s*(error|not\s*found)?/i,
  /page\s*not\s*found/i,
  /this\s*page\s*(doesn'?t|does\s*not)\s*exist/i,
  /sorry,?\s*(we\s*)?(can'?t|couldn'?t)\s*find/i,
  /the\s*requested\s*(url|page)\s*(was\s*)?not\s*found/i,
  /nothing\s*(was\s*)?found/i,
  /oops!?\s*(that\s*page|something\s*went\s*wrong)/i,
  /error\s*404/i,
  /we\s*couldn'?t\s*find\s*(that|the)\s*page/i,
];

/**
 * Extract and analyze text content from a PDF buffer
 * Detects truncated articles by checking text-to-size ratio
 *
 * @param pdfBuffer - The PDF file as a Buffer
 * @returns Analysis result with pass/fail and metrics
 */
export async function analyzePdfContent(pdfBuffer: Buffer): Promise<PdfContentResult> {
  const pdfSize = pdfBuffer.length;

  try {
    // Convert Buffer to Uint8Array (required by pdf-parse v2.x)
    const uint8Array = new Uint8Array(pdfBuffer);

    // Create parser instance and load the PDF
    const parser = new PDFParse(uint8Array);
    await parser.load();

    // Get text content
    const textResult = await parser.getText();

    // Normalize text: collapse whitespace, trim
    const normalizedText = textResult.text
      .replace(/\s+/g, ' ')
      .trim();

    const charCount = normalizedText.length;
    const pageCount = textResult.total;
    const charsPerKb = pdfSize > 0 ? (charCount / (pdfSize / 1024)) : 0;

    const baseResult = {
      pageCount,
      charCount,
      pdfSize,
      charsPerKb: Math.round(charsPerKb * 10) / 10,
    };

    // Check 0: Error page detection (404, page not found, etc.)
    // Only flag if content is short - real error pages don't have much content
    // This avoids false positives when "404" appears in article/tweet text
    const MAX_CHARS_FOR_ERROR_PAGE = 2000;
    if (charCount < MAX_CHARS_FOR_ERROR_PAGE) {
      for (const pattern of ERROR_PAGE_PATTERNS) {
        if (pattern.test(normalizedText)) {
          return {
            ...baseResult,
            passed: false,
            reason: `Error page detected: "${normalizedText.match(pattern)?.[0]}". This appears to be a 404 or error page.`,
          };
        }
      }
    }

    // Check 1: Very little text overall
    if (charCount < MIN_ARTICLE_CHARS) {
      return {
        ...baseResult,
        passed: false,
        reason: `PDF has only ${charCount} characters of text (minimum: ${MIN_ARTICLE_CHARS}). Content appears truncated.`,
      };
    }

    // Check 2: Large PDF with suspiciously little text
    // This catches the "big hero image but truncated article" case
    if (pdfSize > LARGE_PDF_THRESHOLD && charCount < MIN_CHARS_FOR_LARGE_PDF) {
      return {
        ...baseResult,
        passed: false,
        reason: `Large PDF (${Math.round(pdfSize / 1024)}KB) has only ${charCount} characters. Likely truncated article with hero image.`,
      };
    }

    // Check 3: Very low chars-per-KB ratio for multi-page PDFs
    // Single-page image-only docs might legitimately have low ratio
    // BUT: if there's substantial text, it's not truncated regardless of ratio
    // (image-heavy articles with many screenshots will have low ratio but real content)
    // ALSO: short announcement pages with images may have reasonable chars-per-page
    const charsPerPage = pageCount > 0 ? charCount / pageCount : 0;
    const hasSufficientChars = charCount >= SUFFICIENT_CHARS_BYPASS_RATIO;
    const hasSufficientCharsPerPage = charsPerPage >= MIN_CHARS_PER_PAGE_BYPASS;

    if (pageCount > 1 && charsPerKb < MIN_CHARS_PER_KB && !hasSufficientChars && !hasSufficientCharsPerPage) {
      return {
        ...baseResult,
        passed: false,
        reason: `PDF has very low text density (${baseResult.charsPerKb} chars/KB). Expected article content may be missing.`,
      };
    }

    // Passed all checks
    return {
      ...baseResult,
      passed: true,
    };

  } catch (error) {
    // PDF parsing failed - might be encrypted or corrupted
    // Don't fail the whole job, just log and pass
    console.warn('PDF content analysis failed:', error instanceof Error ? error.message : error);
    return {
      passed: true,
      pageCount: 0,
      charCount: 0,
      pdfSize,
      charsPerKb: 0,
      reason: 'PDF parsing failed, skipping content check',
    };
  }
}
