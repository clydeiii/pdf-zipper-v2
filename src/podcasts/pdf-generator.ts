/**
 * Podcast transcript PDF generator
 *
 * Creates nicely formatted PDFs containing:
 * - Podcast and episode metadata (header section)
 * - Full transcript text (body, with pagination)
 */

import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont } from 'pdf-lib';
import type { PodcastMetadata, WhisperResponse, TranscriptSegment } from './types.js';

/**
 * PDF layout constants
 */
const PAGE_WIDTH = 612;   // Letter size
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const FONT_SIZE_TITLE = 18;
const FONT_SIZE_SUBTITLE = 14;
const FONT_SIZE_META = 10;
const FONT_SIZE_BODY = 11;
const LINE_HEIGHT_BODY = 16;
const LINE_HEIGHT_META = 14;

/**
 * Format duration from milliseconds to human readable
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

/**
 * Format date to readable string
 */
function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Wrap text to fit within a given width
 * Returns array of lines
 */
function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = font.widthOfTextAtSize(testLine, fontSize);

      if (testWidth <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Format transcript with optional timestamps
 */
function formatTranscript(transcript: WhisperResponse): string {
  // If we have segments, format with timestamps
  if (transcript.segments && transcript.segments.length > 0) {
    return formatTranscriptWithTimestamps(transcript.segments);
  }

  // Otherwise just use the plain text
  return transcript.text;
}

/**
 * Format transcript segments with timestamps
 * Groups nearby segments into paragraphs
 */
function formatTranscriptWithTimestamps(segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  let currentParagraph: string[] = [];
  let lastTimestamp = 0;

  for (const segment of segments) {
    // Add timestamp marker every 2 minutes or at significant gaps
    const timeDiff = segment.start - lastTimestamp;
    const shouldAddTimestamp = timeDiff >= 120 || (timeDiff >= 30 && currentParagraph.length > 0);

    if (shouldAddTimestamp && currentParagraph.length > 0) {
      lines.push(currentParagraph.join(' '));
      lines.push('');

      const minutes = Math.floor(segment.start / 60);
      const seconds = Math.floor(segment.start % 60);
      lines.push(`[${minutes}:${seconds.toString().padStart(2, '0')}]`);
      currentParagraph = [];
    }

    currentParagraph.push(segment.text.trim());
    lastTimestamp = segment.start;
  }

  // Add remaining paragraph
  if (currentParagraph.length > 0) {
    lines.push(currentParagraph.join(' '));
  }

  return lines.join('\n');
}

/**
 * Draw text and return the new Y position
 */
function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  fontSize: number,
  color = rgb(0, 0, 0)
): number {
  page.drawText(text, { x, y, size: fontSize, font, color });
  return y;
}

/**
 * Generate a PDF containing podcast metadata and transcript
 */
export async function generateTranscriptPdf(
  metadata: PodcastMetadata,
  transcript: WhisperResponse
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();

  // Embed fonts
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // Create first page
  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  // === HEADER SECTION ===

  // Podcast name (title)
  const podcastLines = wrapText(metadata.podcastName, fontBold, FONT_SIZE_TITLE, CONTENT_WIDTH);
  for (const line of podcastLines) {
    y = drawText(page, line, MARGIN, y, fontBold, FONT_SIZE_TITLE);
    y -= FONT_SIZE_TITLE + 4;
  }

  // Episode title (subtitle)
  y -= 8;
  const titleLines = wrapText(metadata.episodeTitle, fontBold, FONT_SIZE_SUBTITLE, CONTENT_WIDTH);
  for (const line of titleLines) {
    y = drawText(page, line, MARGIN, y, fontBold, FONT_SIZE_SUBTITLE, rgb(0.2, 0.2, 0.2));
    y -= FONT_SIZE_SUBTITLE + 2;
  }

  // Metadata line 1: Host(s) and Genre
  y -= 12;
  const metaLine1 = `Host: ${metadata.podcastAuthor}  |  Genre: ${metadata.genre}`;
  drawText(page, metaLine1, MARGIN, y, fontRegular, FONT_SIZE_META, rgb(0.4, 0.4, 0.4));
  y -= LINE_HEIGHT_META;

  // Metadata line 2: Duration and Date
  const duration = formatDuration(metadata.duration);
  const date = formatDate(metadata.publishedAt);
  const metaLine2 = `Duration: ${duration}  |  Published: ${date}`;
  drawText(page, metaLine2, MARGIN, y, fontRegular, FONT_SIZE_META, rgb(0.4, 0.4, 0.4));
  y -= LINE_HEIGHT_META;

  // Metadata line 3: Source URL
  const metaLine3 = `Source: ${metadata.episodeUrl}`;
  const urlLines = wrapText(metaLine3, fontRegular, FONT_SIZE_META, CONTENT_WIDTH);
  for (const line of urlLines) {
    drawText(page, line, MARGIN, y, fontRegular, FONT_SIZE_META, rgb(0.3, 0.3, 0.6));
    y -= LINE_HEIGHT_META;
  }

  // === SHOW NOTES SECTION (with clickable links) ===
  if (metadata.showNotes && metadata.showNotes.links.length > 0) {
    y -= 16;
    drawText(page, 'Show Notes', MARGIN, y, fontBold, FONT_SIZE_META + 1);
    y -= LINE_HEIGHT_META + 4;

    // Summary paragraph
    if (metadata.showNotes.summary) {
      const summaryLines = wrapText(metadata.showNotes.summary, fontItalic, FONT_SIZE_META, CONTENT_WIDTH);
      for (const line of summaryLines) {
        if (y < MARGIN + 40) {
          page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
          y = PAGE_HEIGHT - MARGIN;
        }
        drawText(page, line, MARGIN, y, fontItalic, FONT_SIZE_META, rgb(0.3, 0.3, 0.3));
        y -= LINE_HEIGHT_META;
      }
      y -= 8;
    }

    // Links with clickable annotations
    for (const link of metadata.showNotes.links) {
      if (y < MARGIN + 40) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }

      // Draw bullet point
      const bulletText = '•';
      drawText(page, bulletText, MARGIN, y, fontRegular, FONT_SIZE_META);

      // Draw link text in blue
      const linkText = link.source ? `${link.text} (${link.source})` : link.text;
      const linkX = MARGIN + 12;
      const linkWidth = fontRegular.widthOfTextAtSize(linkText, FONT_SIZE_META);

      drawText(page, linkText, linkX, y, fontRegular, FONT_SIZE_META, rgb(0.1, 0.3, 0.7));

      // Add clickable link annotation
      const linkAnnot = pdfDoc.context.register(
        pdfDoc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [linkX, y - 2, linkX + linkWidth, y + FONT_SIZE_META],
          Border: [0, 0, 0],
          A: {
            Type: 'Action',
            S: 'URI',
            URI: pdfDoc.context.obj(link.url),
          },
        })
      );
      page.node.addAnnot(linkAnnot);

      y -= LINE_HEIGHT_META + 2;
    }
  } else if (metadata.shortDescription || metadata.description) {
    // Fallback to description if no show notes with links
    y -= 16;
    drawText(page, 'Episode Summary', MARGIN, y, fontBold, FONT_SIZE_META + 1);
    y -= LINE_HEIGHT_META + 4;

    let desc = metadata.shortDescription || metadata.description;
    if (desc.length > 500) {
      desc = desc.substring(0, 497) + '...';
    }

    const descLines = wrapText(desc, fontItalic, FONT_SIZE_META, CONTENT_WIDTH);
    for (const line of descLines) {
      if (y < MARGIN + 40) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
      drawText(page, line, MARGIN, y, fontItalic, FONT_SIZE_META, rgb(0.3, 0.3, 0.3));
      y -= LINE_HEIGHT_META;
    }
  }

  // === TRANSCRIPT SECTION ===
  y -= 24;

  // Transcript header
  const transcriptHeader = `Transcript (${transcript.text.length.toLocaleString()} characters)`;
  drawText(page, transcriptHeader, MARGIN, y, fontBold, FONT_SIZE_SUBTITLE);
  y -= FONT_SIZE_SUBTITLE + 8;

  // Horizontal line
  page.drawLine({
    start: { x: MARGIN, y: y + 4 },
    end: { x: PAGE_WIDTH - MARGIN, y: y + 4 },
    thickness: 1,
    color: rgb(0.7, 0.7, 0.7),
  });
  y -= 16;

  // Format and wrap transcript
  const formattedTranscript = formatTranscript(transcript);
  const transcriptLines = wrapText(formattedTranscript, fontRegular, FONT_SIZE_BODY, CONTENT_WIDTH);

  // Draw transcript with pagination
  for (const line of transcriptLines) {
    if (y < MARGIN + 20) {
      // Need new page
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }

    // Timestamp markers in bold
    if (line.match(/^\[\d+:\d{2}\]$/)) {
      drawText(page, line, MARGIN, y, fontBold, FONT_SIZE_BODY, rgb(0.4, 0.4, 0.4));
    } else if (line === '') {
      // Empty line, just reduce Y
    } else {
      drawText(page, line, MARGIN, y, fontRegular, FONT_SIZE_BODY);
    }

    y -= LINE_HEIGHT_BODY;
  }

  // === FOOTER: Set PDF metadata ===
  pdfDoc.setTitle(`${metadata.episodeTitle} - ${metadata.podcastName}`);
  pdfDoc.setAuthor(metadata.podcastAuthor);
  pdfDoc.setSubject(metadata.episodeUrl);  // For rerun feature
  pdfDoc.setProducer(`pdf-zipper v2 podcast transcriber - ${new Date().toISOString()}`);
  pdfDoc.setCreator('Whisper ASR + pdf-zipper');

  // Save PDF
  const pdfBytes = await pdfDoc.save();

  console.log(JSON.stringify({
    event: 'transcript_pdf_generated',
    episodeTitle: metadata.episodeTitle,
    pageCount: pdfDoc.getPageCount(),
    transcriptLength: transcript.text.length,
    pdfSize: pdfBytes.length,
    timestamp: new Date().toISOString(),
  }));

  return Buffer.from(pdfBytes);
}
