import test from 'node:test';
import assert from 'node:assert/strict';
import { pickEmbeddedPdfUrl } from '../dist/converters/pdf.js';

const PAGE_URL = 'https://xbow.com/whitepapers/mid-year-2026-ai-model-security-research-report';

const emptyScan = () => ({ embeds: [], pdfAnchorHrefs: [], hasViewerCanvas: false });

// The real case behind this feature: xbow.com whitepaper pages render the
// report in a canvas-based viewer with a "Download PDF" link. The printed
// capture is intro text + blank viewer pages, so the source PDF must be
// recoverable from the download anchor.
test('canvas viewer + download anchor resolves the PDF URL', () => {
  const url = pickEmbeddedPdfUrl({
    ...emptyScan(),
    pdfAnchorHrefs: ['/downloads/XBOW-WHITEPAPER-Mid-Year-2026-AI-Model-Security-Research-Report.pdf'],
    hasViewerCanvas: true,
  }, PAGE_URL);
  assert.equal(url, 'https://xbow.com/downloads/XBOW-WHITEPAPER-Mid-Year-2026-AI-Model-Security-Research-Report.pdf');
});

test('a bare PDF link without a viewer canvas never matches', () => {
  // An article that merely links a court filing / paper must keep its normal
  // capture path — swapping in the linked PDF would save the wrong document.
  const url = pickEmbeddedPdfUrl({
    ...emptyScan(),
    pdfAnchorHrefs: ['https://example.com/court-filing.pdf'],
    hasViewerCanvas: false,
  }, 'https://news.example.com/story');
  assert.equal(url, undefined);
});

test('large native embed with declared PDF type matches even without .pdf path', () => {
  const url = pickEmbeddedPdfUrl({
    ...emptyScan(),
    embeds: [{ raw: '/api/documents/1234/view', isPdfType: true, large: true }],
  }, 'https://docs.example.com/report');
  assert.equal(url, 'https://docs.example.com/api/documents/1234/view');
});

test('large iframe with .pdf src matches without declared type', () => {
  const url = pickEmbeddedPdfUrl({
    ...emptyScan(),
    embeds: [{ raw: 'https://cdn.example.com/files/report.pdf?rev=2', isPdfType: false, large: true }],
  }, 'https://example.com/page');
  assert.equal(url, 'https://cdn.example.com/files/report.pdf?rev=2');
});

test('small (icon-sized) embeds are ignored', () => {
  const url = pickEmbeddedPdfUrl({
    ...emptyScan(),
    embeds: [{ raw: '/files/report.pdf', isPdfType: false, large: false }],
  }, 'https://example.com/page');
  assert.equal(url, undefined);
});

test('non-http(s) sources (blob:, data:) are rejected', () => {
  const url = pickEmbeddedPdfUrl({
    ...emptyScan(),
    embeds: [{ raw: 'blob:https://example.com/1c9dd7a0', isPdfType: true, large: true }],
    pdfAnchorHrefs: ['data:application/pdf;base64,JVBERi.pdf'],
    hasViewerCanvas: true,
  }, 'https://example.com/page');
  assert.equal(url, undefined);
});

test('.pdf must be in the pathname, not just the query string', () => {
  const url = pickEmbeddedPdfUrl({
    ...emptyScan(),
    pdfAnchorHrefs: ['/viewer?file=report.pdf'],
    hasViewerCanvas: true,
  }, 'https://example.com/page');
  assert.equal(url, undefined);
});

test('first viable candidate wins across embeds before anchors', () => {
  const url = pickEmbeddedPdfUrl({
    embeds: [
      { raw: '/ignored-small.pdf', isPdfType: false, large: false },
      { raw: '/primary.pdf', isPdfType: false, large: true },
    ],
    pdfAnchorHrefs: ['/secondary.pdf'],
    hasViewerCanvas: true,
  }, 'https://example.com/page');
  assert.equal(url, 'https://example.com/primary.pdf');
});
