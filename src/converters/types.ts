/**
 * PDF conversion options
 */
export interface PDFOptions {
  /** Navigation timeout in ms (default: 30000) */
  timeout?: number;
  /** PDF generation timeout in ms (default: 90000) */
  pdfTimeout?: number;
  /** Wait time after domcontentloaded for JS rendering in ms (default: 1000) */
  waitAfterLoad?: number;
  /** Page format (default: 'A4') */
  format?: 'A4' | 'Letter';
  /** Page margins */
  margin?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
}

/**
 * Successful PDF conversion result
 */
export interface PDFSuccessResult {
  success: true;
  pdfBuffer: Buffer;
  screenshotBuffer: Buffer; // For quality verification
  url: string;
  size: number; // buffer length in bytes
  pageTitle?: string; // Extracted page title for filename generation
  isXArticle?: boolean; // True if this was an X Article captured directly (not via Nitter)
  expandedUrl?: string; // Final URL after expanding short URLs (t.co, apple.news, etc.)
  /**
   * Structured relationships lifted from the Nitter DOM (tweet captures only).
   * Embedded in the PDF Info Dict so timeline reconstruction downstream gets
   * real graph edges instead of re-deriving them from rendered text.
   */
  tweetRelations?: {
    quotedTweet?: string; // canonical x.com URL of the quoted status
    inReplyTo?: string;   // canonical x.com URL of the reply parent
    tweetDate?: string;   // exact publish time (ISO 8601) from Nitter's DOM
  };
}

/**
 * Failed PDF conversion result
 */
export interface PDFFailureResult {
  success: false;
  url: string;
  error: string; // human-readable error message
  reason: 'timeout' | 'navigation_error' | 'bot_detected' | 'rate_limited' | 'unknown';
}

/**
 * PDF conversion result (discriminated union)
 */
export type PDFResult = PDFSuccessResult | PDFFailureResult;

/**
 * Successful PDF pass-through (direct download) result
 */
export interface PDFPassthroughSuccessResult {
  success: true;
  pdfBuffer: Buffer;
  url: string;
  size: number;
  suggestedFilename?: string; // From Content-Disposition header
  isPassthrough: true; // Marker to distinguish from converted PDFs
}

/**
 * Failed PDF pass-through result
 */
export interface PDFPassthroughFailureResult {
  success: false;
  url: string;
  error: string;
  reason: 'download_failed' | 'not_pdf';
}

/**
 * PDF pass-through result (discriminated union)
 */
export type PDFPassthroughResult = PDFPassthroughSuccessResult | PDFPassthroughFailureResult;
