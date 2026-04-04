/**
 * General-purpose transcript PDF generator
 *
 * Creates a PDF with:
 * - Header: title, source, date
 * - AI summary
 * - Full transcript text
 * - Rich metadata in PDF Info Dict (Karpathy-compliant)
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { setInfoDictFields } from '../utils/pdf-info-dict.js';

const PAGE_WIDTH = 612;   // Letter
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const FONT_SIZE_TITLE = 16;
const FONT_SIZE_META = 10;
const FONT_SIZE_BODY = 11;
const LINE_HEIGHT_BODY = 16;

/**
 * Sanitize text for WinAnsi encoding (pdf-lib StandardFonts limitation)
 */
function sanitize(text: string): string {
  return text
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013]/g, '-')
    .replace(/[\u2014]/g, '--')
    .replace(/[\u2026]/g, '...')
    .replace(/[\u2022]/g, '*')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[^\x00-\xFF]/g, '');
}

export interface TranscriptPdfOptions {
  title: string;
  sourceUrl: string;
  date?: string;
  summary?: string;
  tags?: string[];
  language?: string;
  author?: string;
  publication?: string;
  transcriptText: string;
}

/**
 * Generate a transcript PDF with embedded Karpathy-compliant metadata
 */
export async function generateTranscriptPdf(opts: TranscriptPdfOptions): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const title = sanitize(opts.title);
  const transcript = sanitize(opts.transcriptText);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  // Helper: wrap text into lines
  function wrapText(text: string, f: typeof font, size: number, maxWidth: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (f.widthOfTextAtSize(test, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  // Helper: draw text, handle page breaks
  function drawLine(text: string, f: typeof font, size: number, color = rgb(0, 0, 0)) {
    if (y < MARGIN + size) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    page.drawText(text, { x: MARGIN, y, font: f, size, color });
    y -= size + 4;
  }

  // === HEADER ===
  for (const line of wrapText(title, fontBold, FONT_SIZE_TITLE, CONTENT_WIDTH)) {
    drawLine(line, fontBold, FONT_SIZE_TITLE);
  }
  y -= 6;

  // Meta line
  const metaParts: string[] = [];
  if (opts.author) metaParts.push(opts.author);
  if (opts.publication) metaParts.push(opts.publication);
  if (opts.date) {
    try {
      const d = new Date(opts.date);
      metaParts.push(d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
    } catch { metaParts.push(opts.date); }
  }
  if (metaParts.length > 0) {
    drawLine(sanitize(metaParts.join(' | ')), font, FONT_SIZE_META, rgb(0.4, 0.4, 0.4));
  }

  // Source URL
  drawLine(sanitize(opts.sourceUrl), font, FONT_SIZE_META, rgb(0.3, 0.3, 0.7));
  y -= 8;

  // === SUMMARY ===
  if (opts.summary) {
    drawLine('Summary', fontBold, 12);
    y -= 2;
    for (const line of wrapText(sanitize(opts.summary), fontItalic, FONT_SIZE_BODY, CONTENT_WIDTH)) {
      drawLine(line, fontItalic, FONT_SIZE_BODY, rgb(0.3, 0.3, 0.3));
    }
    y -= 8;
  }

  // === TAGS ===
  if (opts.tags && opts.tags.length > 0) {
    drawLine(`Topics: ${opts.tags.join(', ')}`, font, FONT_SIZE_META, rgb(0.2, 0.4, 0.7));
    y -= 8;
  }

  // Divider
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });
  y -= 12;

  // === TRANSCRIPT ===
  drawLine(`Transcript (${transcript.length.toLocaleString()} characters)`, fontBold, 12);
  y -= 4;

  // Split transcript into paragraphs, then wrap each
  const paragraphs = transcript.split(/\n\n+/);
  for (const para of paragraphs) {
    const lines = wrapText(para.replace(/\n/g, ' '), font, FONT_SIZE_BODY, CONTENT_WIDTH);
    for (const line of lines) {
      drawLine(line, font, FONT_SIZE_BODY);
    }
    y -= LINE_HEIGHT_BODY * 0.5; // Paragraph spacing
  }

  // === METADATA (Karpathy-compliant) ===
  // Standard fields
  pdfDoc.setTitle(opts.title);
  if (opts.author) pdfDoc.setAuthor(opts.author);
  pdfDoc.setSubject(opts.sourceUrl);
  if (opts.tags && opts.tags.length > 0) pdfDoc.setKeywords(opts.tags);
  if (opts.publication) pdfDoc.setCreator(`${opts.publication} via pdf-zipper v2`);
  pdfDoc.setProducer(`pdf-zipper v2 - captured ${new Date().toISOString()}`);
  if (opts.date) {
    const pubDate = new Date(opts.date);
    if (!isNaN(pubDate.getTime())) pdfDoc.setCreationDate(pubDate);
  }

  // Custom Info Dict fields
  setInfoDictFields(pdfDoc, {
    Summary: opts.summary,
    Language: opts.language,
    Publication: opts.publication,
    PublishDate: opts.date,
    Tags: opts.tags && opts.tags.length > 0 ? opts.tags.join(', ') : undefined,
    EnrichedAt: new Date().toISOString(),
    MediaType: 'video-transcript',
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
