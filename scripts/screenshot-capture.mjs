/**
 * Screenshot-based page capture for canvas/WebGL-heavy visualization pages
 * that Page.printToPDF renders incorrectly (blank canvases, broken theming).
 *
 * Takes a full-page screenshot (which rasterizes canvases faithfully), slices
 * it into A4 pages, enriches metadata from the page text, and saves through
 * the normal weekly-bin pipeline. The PDF body is an image (no text layer) —
 * summary/tags in the Info Dict carry the KB semantics.
 *
 * Usage (inside the container):
 *   node scripts/screenshot-capture.mjs <renderUrl> <sourceUrl> [title]
 *
 * renderUrl — the page to actually render (e.g. an inner iframe URL)
 * sourceUrl — the canonical URL for filename/metadata/dedup
 * Exit codes: 0 = saved, 2 = page did not load usable content (retry later)
 */

import { PDFDocument } from 'pdf-lib';

const [renderUrl, sourceUrl, titleArg] = process.argv.slice(2);
if (!renderUrl || !sourceUrl) {
  console.error('usage: node scripts/screenshot-capture.mjs <renderUrl> <sourceUrl> [title]');
  process.exit(1);
}

const { initBrowser, closeBrowser } = await import('../dist/browsers/manager.js');
const { savePdfToWeeklyBin } = await import('../dist/utils/save-pdf.js');
const { enrichDocumentMetadata } = await import('../dist/metadata/enrichment.js');

const browser = await initBrowser();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 1000 },
  deviceScaleFactor: 2, // crisp text in the rasterized pages
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
});

try {
  const page = await ctx.newPage();
  await page.goto(renderUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(10000); // viz apps animate in

  const state = await page.evaluate(() => ({
    chars: document.body.innerText.length,
    canvases: document.querySelectorAll('canvas').length,
    failed: /failed to load|please refresh/i.test(document.body.innerText.slice(0, 300)),
    title: document.title,
    text: document.body.innerText,
  }));

  if (state.failed || state.chars < 500) {
    console.log(`not ready: chars=${state.chars} failed=${state.failed} title="${state.title}"`);
    process.exit(2);
  }

  const png = await page.screenshot({ fullPage: true, type: 'png' });
  console.log(`screenshot: ${Math.round(png.length / 1024)}KB, text ${state.chars} chars, ${state.canvases} canvas(es)`);

  // Slice the tall screenshot into A4 pages (same image drawn with a
  // per-page vertical offset; page bounds clip the rest).
  const A4W = 595.28, A4H = 841.89;
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  const scale = A4W / img.width;
  const imgHpts = img.height * scale;
  const pageCount = Math.max(1, Math.ceil(imgHpts / A4H));
  for (let i = 0; i < pageCount; i++) {
    const p = doc.addPage([A4W, A4H]);
    p.drawImage(img, { x: 0, y: A4H - imgHpts + i * A4H, width: A4W, height: imgHpts });
  }

  const title = titleArg || state.title;
  let enrichedMetadata;
  try {
    enrichedMetadata = await enrichDocumentMetadata(state.text, sourceUrl, title);
  } catch (e) { console.warn('enrichment failed (non-fatal):', e.message); }

  const pdfBuffer = Buffer.from(await doc.save());
  const filePath = await savePdfToWeeklyBin(pdfBuffer, {
    url: sourceUrl,
    title,
    originalUrl: sourceUrl,
    enrichedMetadata,
    creatorOverride: 'pdf-zipper-v2-screenshot',
  });
  console.log(`saved: ${filePath} (${pageCount} pages, ${Math.round(pdfBuffer.length / 1024)}KB)`);
} finally {
  await ctx.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
process.exit(0);
