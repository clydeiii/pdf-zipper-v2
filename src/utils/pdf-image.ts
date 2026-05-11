/**
 * Shared helper for embedding remote images into pdf-lib documents.
 *
 * Used by both the podcast PDF (square cover artwork) and the video transcript
 * PDF (16:9 YouTube thumbnails). Best-effort: never throws — caller treats null
 * as "no artwork available."
 */

import { PDFDocument, PDFImage } from 'pdf-lib';

const FETCH_TIMEOUT_MS = 8000;

/**
 * Fetch a remote image URL and embed it into the PDF.
 * Detects format by sniffing the magic bytes (PNG / JPEG only — pdf-lib's
 * StandardFonts path doesn't support WebP or AVIF).
 *
 * @returns the embedded PDFImage on success, null on any failure
 */
export async function tryEmbedRemoteImage(
  pdfDoc: PDFDocument,
  imageUrl: string | undefined
): Promise<PDFImage | null> {
  if (!imageUrl) return null;

  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'pdf-zipper/2.0' },
    });
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 4) return null;

    // PNG magic: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return await pdfDoc.embedPng(buf);
    }
    // JPEG magic: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
      return await pdfDoc.embedJpg(buf);
    }
    return null;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'pdf_remote_image_embed_failed',
      imageUrl,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));
    return null;
  }
}
