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
import { tryEmbedRemoteImage } from '../utils/pdf-image.js';

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
  /** YouTube channel name (rendered alongside upload date) */
  channel?: string;
  /** Channel page URL (embedded in Info Dict) */
  channelUrl?: string;
  /** Original upload date from yt-dlp (ISO YYYY-MM-DD) */
  uploadDate?: string;
  /** Original platform description (rendered before AI summary) */
  description?: string;
  /** Thumbnail/poster image URL (embedded top-right of the header) */
  thumbnail?: string;
  transcriptText: string;
}

/** Cap for rendered description; full text still goes into MP4 metadata. */
const MAX_DESCRIPTION_CHARS_PDF = 1500;

/** Thumbnail dimensions (16:9 — matches YouTube poster aspect ratio) */
const THUMBNAIL_WIDTH = 144;
const THUMBNAIL_HEIGHT = 81;
const THUMBNAIL_GAP = 12;

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
  // Try thumbnail first; if present, narrow header text width so it doesn't
  // run under the image. Falls back silently to full width on fetch failure.
  const thumbnail = await tryEmbedRemoteImage(pdfDoc, opts.thumbnail);
  let headerWidth = CONTENT_WIDTH;
  if (thumbnail) {
    const thumbX = PAGE_WIDTH - MARGIN - THUMBNAIL_WIDTH;
    const thumbY = PAGE_HEIGHT - MARGIN - THUMBNAIL_HEIGHT;
    page.drawImage(thumbnail, {
      x: thumbX,
      y: thumbY,
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
    });
    headerWidth = CONTENT_WIDTH - THUMBNAIL_WIDTH - THUMBNAIL_GAP;
  }

  for (const line of wrapText(title, fontBold, FONT_SIZE_TITLE, headerWidth)) {
    drawLine(line, fontBold, FONT_SIZE_TITLE);
  }
  y -= 6;

  // Meta line — prefer channel + uploadDate when available (YouTube), else
  // fall back to the AI-enriched author/publication/date.
  const metaParts: string[] = [];
  if (opts.channel) {
    metaParts.push(opts.channel);
  } else {
    if (opts.author) metaParts.push(opts.author);
    if (opts.publication && opts.publication !== opts.author) metaParts.push(opts.publication);
  }
  const dateForMeta = opts.uploadDate || opts.date;
  if (dateForMeta) {
    try {
      const d = new Date(dateForMeta);
      if (!isNaN(d.getTime())) {
        metaParts.push(d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
      } else {
        metaParts.push(dateForMeta);
      }
    } catch { metaParts.push(dateForMeta); }
  }
  if (metaParts.length > 0) {
    drawLine(sanitize(metaParts.join(' | ')), font, FONT_SIZE_META, rgb(0.4, 0.4, 0.4));
  }

  // Source URL — full width once we're below the thumbnail
  const thumbnailBottomY = PAGE_HEIGHT - MARGIN - THUMBNAIL_HEIGHT;
  const urlWidth = thumbnail && y > thumbnailBottomY ? headerWidth : CONTENT_WIDTH;
  for (const line of wrapText(sanitize(opts.sourceUrl), font, FONT_SIZE_META, urlWidth)) {
    drawLine(line, font, FONT_SIZE_META, rgb(0.3, 0.3, 0.7));
  }
  // If the header was shorter than the thumbnail, drop y past the bottom edge
  // so the next block (Description / Summary / Transcript) doesn't run under
  // the image and clip behind it.
  if (thumbnail && y > thumbnailBottomY) {
    y = thumbnailBottomY - 4;
  }
  y -= 8;

  // === DESCRIPTION (original platform description, e.g. YouTube) ===
  if (opts.description && opts.description.trim().length > 0) {
    drawLine('Description', fontBold, 12);
    y -= 2;
    let desc = opts.description.trim();
    if (desc.length > MAX_DESCRIPTION_CHARS_PDF) {
      desc = desc.slice(0, MAX_DESCRIPTION_CHARS_PDF - 3).trimEnd() + '...';
    }
    // Preserve paragraph breaks from the original description
    for (const para of desc.split(/\n\n+/)) {
      const flat = para.replace(/\n/g, ' ').trim();
      if (!flat) continue;
      for (const line of wrapText(sanitize(flat), font, FONT_SIZE_BODY, CONTENT_WIDTH)) {
        drawLine(line, font, FONT_SIZE_BODY, rgb(0.25, 0.25, 0.25));
      }
      y -= LINE_HEIGHT_BODY * 0.4;
    }
    y -= 8;
  }

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

  // Custom Info Dict fields. DocType=transcript marks this as a derived
  // transcript document (sibling of an MP3/MP4) so the KB can group it with
  // its source media rather than treating it as a standalone article.
  setInfoDictFields(pdfDoc, {
    Summary: opts.summary,
    Language: opts.language,
    Publication: opts.publication,
    PublishDate: opts.uploadDate || opts.date,
    Tags: opts.tags && opts.tags.length > 0 ? opts.tags.join(', ') : undefined,
    Channel: opts.channel,
    ChannelUrl: opts.channelUrl,
    UploadDate: opts.uploadDate,
    Description: opts.description,
    EnrichedAt: new Date().toISOString(),
    DocType: 'transcript',
    MediaType: 'video-transcript',
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
