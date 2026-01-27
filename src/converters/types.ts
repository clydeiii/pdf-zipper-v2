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
