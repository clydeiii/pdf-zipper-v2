/**
 * PDF conversion options
 */
export interface PDFOptions {
  /** Navigation timeout in ms (default: 30000) */
  timeout?: number;
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
}

/**
 * Failed PDF conversion result
 */
export interface PDFFailureResult {
  success: false;
  url: string;
  error: string; // human-readable error message
  reason: 'timeout' | 'navigation_error' | 'bot_detected' | 'unknown';
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
