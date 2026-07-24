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
  viewport: { width: 1280, height: 1600 },
  deviceScaleFactor: 2, // crisp text in the rasterized pages
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
});

try {
  const page = await ctx.newPage();
  await page.goto(renderUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(10000); // viz apps animate in

  // Content may live in (cross-origin) iframes — aggregate over ALL frames.
  // Playwright reaches into cross-origin frames where page JS cannot.
  const frameStates = [];
  for (const frame of page.frames()) {
    try {
      frameStates.push(await frame.evaluate(() => ({
        chars: document.body?.innerText.length ?? 0,
        canvases: document.querySelectorAll('canvas').length,
        failed: /failed to load|please refresh/i.test((document.body?.innerText || '').slice(0, 300)),
        text: document.body?.innerText || '',
        scrollHeight: document.documentElement.scrollHeight,
      })));
    } catch { /* frame detached or inaccessible */ }
  }
  const state = {
    chars: frameStates.reduce((a, f) => a + f.chars, 0),
    canvases: frameStates.reduce((a, f) => a + f.canvases, 0),
    failed: frameStates.some(f => f.failed),
    title: await page.title(),
    text: frameStates.map(f => f.text).filter(t => t.length > 40).join('\n\n'),
  };

  if (state.failed || state.chars < 500) {
    console.log(`not ready: chars=${state.chars} failed=${state.failed} title="${state.title}"`);
    process.exit(2);
  }

  // An embedded app usually scrolls INSIDE its iframe; a full-page shot would
  // only capture the visible window. Expand each iframe element to its
  // content height (twice — the inner app may relayout when given room).
  for (let round = 0; round < 2; round++) {
    const frameHeights = {};
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try { frameHeights[frame.url()] = await frame.evaluate(() => document.documentElement.scrollHeight); } catch {}
    }
    await page.evaluate((heights) => {
      document.querySelectorAll('iframe').forEach((f) => {
        const h = heights[f.src];
        if (h && h > f.clientHeight) f.style.height = h + 'px';
      });
      document.documentElement.style.overflow = 'visible';
      document.body.style.overflow = 'visible';
    }, frameHeights);
    await page.waitForTimeout(800);
  }

  // Clip to real content height — fullPage pads to at least the viewport,
  // which slices into trailing blank PDF pages on short content.
  const contentBottom = await page.evaluate(() => {
    let bottom = 0;
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height > 0) bottom = Math.max(bottom, r.bottom + window.scrollY);
    });
    return Math.ceil(bottom);
  });
  const vp = page.viewportSize();
  const png = contentBottom > 100
    ? await page.screenshot({ clip: { x: 0, y: 0, width: vp.width, height: contentBottom + 20 }, type: 'png' })
    : await page.screenshot({ fullPage: true, type: 'png' });
  console.log(`screenshot: ${Math.round(png.length / 1024)}KB, text ${state.chars} chars, ${state.canvases} canvas(es) across ${frameStates.length} frame(s)`);

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
