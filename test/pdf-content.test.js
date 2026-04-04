import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { analyzePdfContent } from '../dist/quality/pdf-content.js';

/**
 * Helper: create a PDF with given text content
 */
async function createPdfWithText(text, { pageCount = 1 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const chunkSize = Math.ceil(text.length / pageCount);
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792]);
    const chunk = text.slice(i * chunkSize, (i + 1) * chunkSize);
    page.drawText(chunk.slice(0, 2000), { // pdf-lib limit per drawText
      x: 50, y: 700, size: 10, font, maxWidth: 500,
    });
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/**
 * Helper: generate filler text of a given length
 */
function filler(length) {
  const base = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
  return base.repeat(Math.ceil(length / base.length)).slice(0, length);
}

// --- Passing cases ---

test('analyzePdfContent passes normal article with sufficient text', async () => {
  const text = filler(2000);
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true);
  assert.ok(result.charCount > 500);
});

test('analyzePdfContent passes image-heavy article with >5000 chars (ratio bypass)', async () => {
  const text = filler(6000);
  const pdf = await createPdfWithText(text, { pageCount: 3 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, 'Should pass via SUFFICIENT_CHARS_BYPASS_RATIO');
});

// --- Failing cases ---

test('analyzePdfContent fails on very short content', async () => {
  const text = 'Short page.';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('characters'));
});

test('analyzePdfContent detects error page patterns', async () => {
  const text = 'Oops! The page you are looking for could not be found. Error 404.';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('rror page') || result.reason?.includes('404'));
});

test('analyzePdfContent detects firewall/WAF blocks', async () => {
  const text = 'Attention Required! | Cloudflare. Checking your browser before accessing the site.';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Firewall') || result.reason?.includes('WAF'));
});

test('analyzePdfContent detects hard paywall patterns', async () => {
  // Hard paywall should trigger regardless of text length.
  // Put the paywall text at the START so it fits within drawText limits.
  const text = 'Subscribe to continue reading this article with a WSJ subscription. ' + filler(6000);
  const pdf = await createPdfWithText(text, { pageCount: 2 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Paywall'));
});

test('analyzePdfContent detects soft paywall on short content', async () => {
  const text = 'This is a premium article. Unlock this article for just $4.99 per month to read more.';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Paywall'));
});

test('analyzePdfContent ignores soft paywall patterns in long content', async () => {
  // A long article that mentions pricing shouldn't be flagged
  const text = filler(6000) + ' Our service starts at $9.99 per month for premium features.';
  const pdf = await createPdfWithText(text, { pageCount: 2 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, 'Soft paywall in long content should not trigger');
});

test('analyzePdfContent ignores error page patterns in long content', async () => {
  // A tweet mentioning "404 error" shouldn't be flagged
  const text = filler(5000) + ' The server returned a 404 error when I tried to access the API.';
  const pdf = await createPdfWithText(text, { pageCount: 2 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, '404 mention in long content should not trigger');
});

// --- Extracted text ---

test('analyzePdfContent returns extracted text for downstream use', async () => {
  const text = filler(1000);
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.ok(result.extractedText);
  assert.ok(result.extractedText.length > 0);
});

// --- Corrupted/empty PDF ---

test('analyzePdfContent passes gracefully on corrupted PDF', async () => {
  const garbage = Buffer.from('not a pdf at all');
  const result = await analyzePdfContent(garbage);
  // Should not throw, should pass (fail-open for unparseable PDFs)
  assert.equal(result.passed, true);
  assert.ok(result.reason?.includes('parsing failed'));
});
