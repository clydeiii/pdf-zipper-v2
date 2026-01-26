/**
 * PDF to image conversion for quality verification
 * Extracts first page as image for vision model analysis
 */

import { convert } from 'pdf-img-convert';

/**
 * PDF to image conversion options
 */
export interface PdfToImageOptions {
  /** Page number to extract (1-indexed, default: 1) */
  page?: number;
}

/**
 * Convert PDF buffer to image buffer
 * Extracts a single page (first page by default) for performance
 * Vision model analysis takes 2-7s per image, so we only process first page
 *
 * @param pdfBuffer - PDF file as Buffer
 * @param options - Conversion options
 * @returns Image as Buffer, or null if conversion fails
 */
export async function pdfToImage(
  pdfBuffer: Buffer,
  options?: PdfToImageOptions
): Promise<Buffer | null> {
  const pageNumber = options?.page ?? 1;

  try {
    // pdf-img-convert expects Uint8Array or path
    const pdfData = new Uint8Array(pdfBuffer);

    // Convert PDF to array of page images
    const images = await convert(pdfData, {
      // Return specific page only (1-indexed in our API, but library uses 0-indexed internally)
      page_numbers: [pageNumber],
    });

    // Check if requested page exists
    if (!images || images.length === 0) {
      console.error(
        `[pdf-to-image] No images generated from PDF (requested page ${pageNumber})`
      );
      return null;
    }

    // Return first (and only) image as Buffer
    const imageData = images[0];
    return Buffer.from(imageData);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pdf-to-image] Conversion failed: ${message}`);
    return null;
  }
}
