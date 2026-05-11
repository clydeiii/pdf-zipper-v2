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
  /** Extracted text content (for downstream metadata enrichment) */
  extractedText?: string;
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
const SUFFICIENT_CHARS_BYPASS_RATIO = 5000;

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
 * "Stripped page" patterns — site nav/footer chrome rendered without the
 * article body. Reuters' Akamai protection serves a content-less skeleton to
 * automated browsers (no explicit bot wall, no 404), so the vision scorer
 * sees a real page with text and gives it a passing score. The text content
 * is identical across articles (~1700 chars of nav links + boilerplate),
 * which is what these patterns key on. Only checked when char count is low.
 */
const STRIPPED_PAGE_PATTERNS = [
  // Reuters: this exact phrase only appears in the global footer, never in
  // article copy. Combined with low char count it's a reliable failure signal.
  /reuters,?\s+the\s+news\s+and\s+media\s+division\s+of\s+thomson\s+reuters/i,
];

/**
 * Site-template markers that indicate the article body has ended (related
 * articles, author bio, "Most Popular" widget, etc.). Used to detect stealth
 * paywalls — sites that show the lede + 1-2 paragraphs, then drop into the
 * end-of-page boilerplate. No explicit "subscribe to continue" text, so the
 * vision scorer + paywall regex both pass; a real article body would push
 * these markers much further down the page.
 */
const END_OF_ARTICLE_MARKERS = [
  /\babout\s+the\s+author\b/i,
  /\blatest\s+in\s+\w[\w\s]{0,30}\b/i,    // "Latest in Crypto", "Latest in Tech"
  /\bmost\s+popular\b/i,
  /\brecommended\s+(stories|articles|reading)\b/i,
  /\brelated\s+(stories|articles|posts)\b/i,
];

/** Char index before which an end-of-article marker is suspicious (= truncation) */
const TRUNCATED_BODY_PREFIX = 2500;
/** Total char count above which we trust the document is a real full article */
const TRUNCATED_BODY_CEILING = 8000;

/**
 * Firewall/WAF patterns - if any of these appear, the page was blocked by a firewall
 * Common on sites using Cloudflare, Akamai, AWS WAF, etc.
 */
const FIREWALL_PATTERNS = [
  /attention\s+required!?\s*\|?\s*cloudflare/i,
  /checking\s+(your\s+)?browser\s+before\s+accessing/i,
  /please\s+(wait\s+while\s+we\s+)?verify\s+(you\s+are|you're)\s+(a\s+)?human/i,
  /ray\s+id:\s*[0-9a-f]+/i,
  /performance\s+&?\s*security\s+by\s+cloudflare/i,
  /access\s+(to\s+this\s+)?(page|site|resource)\s+(has\s+been\s+)?(denied|blocked|forbidden)/i,
  /you\s+(have\s+been|are)\s+blocked/i,
  /this\s+website\s+is\s+using\s+a\s+security\s+service/i,
  /sorry,?\s+you\s+have\s+been\s+blocked/i,
  /web\s+application\s+firewall/i,
  /automated\s+access\s+to\s+this\s+(page|site)\s+has\s+been\s+(denied|blocked)/i,
  /enable\s+(javascript\s+and\s+)?cookies\s+to\s+continue/i,
  /please\s+turn\s+javascript\s+on/i,
  /just\s+a\s+moment\s*\.{3}/i,
  /verifying\s+(you|that\s+you)\s+are\s+(not\s+a\s+)?(a\s+)?robot/i,
  /403\s+forbidden/i,
  /access\s+denied/i,
  // Reuters bot detection
  /access\s+is\s+temporarily\s+restricted/i,
  /we\s+detected\s+unusual\s+activity\s+from\s+your/i,
  /automated\s+\(bot\)\s+activity\s+on\s+your\s+network/i,
];

/**
 * HARD paywall patterns - these definitively indicate a paywall gate
 * and should ALWAYS flag regardless of total text length.
 * (News sites have lots of nav/sidebar/footer text that inflates char count
 * even when the actual article is truncated behind a paywall.)
 */
const HARD_PAYWALL_PATTERNS = [
  // Explicit "continue reading" gates
  /continue\s+reading\s+(your\s+)?(article|story)\s+with\s+a/i,
  /subscribe\s+to\s+(continue|keep)\s+reading/i,
  // "Subscribe to <site name> to continue reading" — e.g. The Verge, Wired.
  // Bounded & non-greedy so the site-name gap can't span sentences.
  /subscribe\s+to\s+[^.!?]{1,60}?\s+to\s+(continue|keep)\s+reading/i,
  /sign\s+up\s+to\s+(continue|keep)\s+reading/i,
  /create\s+(a\s+)?free\s+account\s+to\s+(continue|read)/i,
  /already\s+a\s+subscriber\?\s*sign\s+in/i,
  /subscribers\s+only/i,
  /this\s+(article|content)\s+is\s+(only\s+)?(available|accessible)\s+to\s+subscribers/i,
  /you('ve|'re|\s+have)\s+(reached|hit)\s+(your|the)\s+(article|story|free)\s+(limit|cap)/i,

  // Site-specific hard gates
  /subscribe\s+to\s+wsj/i,
  /continue\s+reading\s+with\s+a\s+wsj\s+subscription/i,
  /subscribe\s+to\s+(the\s+)?new\s+york\s+times/i,
  /unlock\s+the\s+global\s+benchmark/i, // Bloomberg
  /get\s+unlimited\s+access\s+to/i,
  // Atlantic
  /to\s+read\s+this\s+story,?\s*sign\s+in\s+or\s+start\s+a\s+digital/i,
  /start\s+a\s+digital\s+trial\s+or\s+digital\s+subscription/i,
  // Fortune
  /to\s+(continue|keep)\s+reading,?\s*(please\s+)?(subscribe|sign\s+in|log\s+in)/i,
  // Generic "sign in to read/continue" gates
  /sign\s+in\s+to\s+(read|continue|access)\s+(this|the)\s+(article|story|content)/i,
];

/**
 * SOFT paywall patterns - these suggest a paywall but could also appear
 * in legitimate article text (e.g., "subscribe to my newsletter for $7/month").
 * Only checked when content is short (<5000 chars).
 */
const SOFT_PAYWALL_PATTERNS = [
  /unlock\s+(this\s+)?(article|story|content)/i,
  /premium\s+(content|article|story)/i,
  /member(\s+|-)?exclusive/i,

  // Price-based prompts
  /\$\d+\.?\d*\s+(per|a|your|\/)\s*(week|month|year|first)/i,
  /for\s+just\s+\$\d+\.?\d*/i,
  /starting\s+at\s+\$\d+\.?\d*/i,

  // Bloomberg
  /bloomberg\s+(terminal|professional)/i,

  // WSJ
  /wall\s+street\s+journal\s+membership/i,

  // NYT
  /times\s+insider/i,

  // Generic
  /become\s+a\s+(subscriber|member)/i,
  /join\s+(now\s+)?to\s+(continue|unlock|access)/i,
];

/**
 * Options for `analyzePdfContent`.
 */
export interface AnalyzePdfContentOptions {
  /**
   * Skip body-length / truncation checks. Hostile-page checks (firewall,
   * 404, hard paywall) still run. Used for content where short body is
   * legitimate (Nitter tweet captures with no replies, single-status posts) —
   * those should only fail when the PDF is truly blank.
   */
  lenient?: boolean;
}

/**
 * Extract and analyze text content from a PDF buffer
 * Detects truncated articles by checking text-to-size ratio
 *
 * @param pdfBuffer - The PDF file as a Buffer
 * @param options - Optional analysis flags (e.g. lenient for tweets)
 * @returns Analysis result with pass/fail and metrics
 */
export async function analyzePdfContent(
  pdfBuffer: Buffer,
  options: AnalyzePdfContentOptions = {}
): Promise<PdfContentResult> {
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
      extractedText: normalizedText,
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

    // Check 0.5: Firewall/WAF detection
    // These pages are typically short — real articles with substantial content
    // that mention "access denied" etc. in their text should not be flagged
    const MAX_CHARS_FOR_FIREWALL = 3000;
    if (charCount < MAX_CHARS_FOR_FIREWALL) {
      for (const pattern of FIREWALL_PATTERNS) {
        if (pattern.test(normalizedText)) {
          const match = normalizedText.match(pattern)?.[0];
          return {
            ...baseResult,
            passed: false,
            reason: `Firewall/WAF blocked: "${match}". Page was blocked by a security service.`,
          };
        }
      }

      // Stripped page: footer chrome rendered without article body.
      for (const pattern of STRIPPED_PAGE_PATTERNS) {
        if (pattern.test(normalizedText)) {
          return {
            ...baseResult,
            passed: false,
            reason: `Stripped page: only nav/footer rendered (${charCount} chars). Article body missing — likely silently bot-throttled.`,
          };
        }
      }
    }

    // Check 0.75: Paywall detection (two tiers)
    //
    // HARD patterns: Always checked. These definitively indicate a paywall gate
    // (e.g., "Continue reading your article with a WSJ subscription").
    // News sites have tons of nav/sidebar/footer/recommendation text that inflates
    // char count well above 5000 even when the actual article is truncated.
    for (const pattern of HARD_PAYWALL_PATTERNS) {
      if (pattern.test(normalizedText)) {
        const match = normalizedText.match(pattern)?.[0];
        return {
          ...baseResult,
          passed: false,
          reason: `Paywall detected: "${match}". Article content is behind a subscription wall.`,
        };
      }
    }

    // SOFT patterns: Only checked when content is short (<5000 chars).
    // These could legitimately appear in article text (e.g., a blog post mentioning
    // "subscribe to my newsletter for $7/month").
    const MAX_CHARS_FOR_SOFT_PAYWALL = 5000;
    if (!options.lenient && charCount < MAX_CHARS_FOR_SOFT_PAYWALL) {
      for (const pattern of SOFT_PAYWALL_PATTERNS) {
        if (pattern.test(normalizedText)) {
          const match = normalizedText.match(pattern)?.[0];
          return {
            ...baseResult,
            passed: false,
            reason: `Paywall detected: "${match}". Article content is behind a subscription wall.`,
          };
        }
      }
    }

    // Check 0.9: Stealth paywall via early end-of-article markers.
    // Some sites (Fortune, etc.) silently truncate the article body and drop
    // straight into "Recommended Video → About the Author → Latest in X →
    // Most Popular" boilerplate. No "subscribe" text, so the paywall regex
    // misses it and the vision scorer sees a real-looking page. Heuristic:
    // when an end-of-article marker appears very early in a short doc, the
    // body got cut off. Skipped above the ceiling so legit medium-length
    // articles aren't flagged.
    if (!options.lenient && charCount < TRUNCATED_BODY_CEILING) {
      for (const pattern of END_OF_ARTICLE_MARKERS) {
        const match = pattern.exec(normalizedText);
        if (match && match.index < TRUNCATED_BODY_PREFIX) {
          return {
            ...baseResult,
            passed: false,
            reason: `Truncated body: site-template marker "${match[0]}" appears at char ${match.index} (before normal article-body length). Likely stealth paywall.`,
          };
        }
      }
    }

    // Check 1: Very little text overall.
    // Lenient mode (Nitter tweet captures) only fails when truly blank —
    // a status with no replies legitimately has very little body text.
    const minChars = options.lenient ? 1 : MIN_ARTICLE_CHARS;
    if (charCount < minChars) {
      return {
        ...baseResult,
        passed: false,
        reason: options.lenient
          ? `PDF is blank (0 chars of text).`
          : `PDF has only ${charCount} characters of text (minimum: ${MIN_ARTICLE_CHARS}). Content appears truncated.`,
      };
    }

    // Check 2: Large PDF with suspiciously little text
    // This catches the "big hero image but truncated article" case
    if (!options.lenient && pdfSize > LARGE_PDF_THRESHOLD && charCount < MIN_CHARS_FOR_LARGE_PDF) {
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

    if (!options.lenient && pageCount > 1 && charsPerKb < MIN_CHARS_PER_KB && !hasSufficientChars && !hasSufficientCharsPerPage) {
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
