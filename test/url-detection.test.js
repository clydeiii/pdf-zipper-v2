import test from 'node:test';
import assert from 'node:assert/strict';
import { isPdfUrl } from '../dist/converters/pdf.js';

// isPdfUrl tests
test('isPdfUrl detects .pdf extension', () => {
  assert.equal(isPdfUrl('https://example.com/paper.pdf'), true);
  assert.equal(isPdfUrl('https://example.com/docs/report.PDF'), true);
});

test('isPdfUrl detects arxiv PDF URLs without extension', () => {
  assert.equal(isPdfUrl('https://arxiv.org/pdf/2506.06299'), true);
  assert.equal(isPdfUrl('https://arxiv.org/pdf/2506.06299v2'), true);
});

test('isPdfUrl rejects non-PDF URLs', () => {
  assert.equal(isPdfUrl('https://example.com/article'), false);
  assert.equal(isPdfUrl('https://arxiv.org/abs/2506.06299'), false);
  assert.equal(isPdfUrl('https://example.com/page.html'), false);
});

test('isPdfUrl handles invalid URLs gracefully', () => {
  assert.equal(isPdfUrl('not-a-url'), false);
  assert.equal(isPdfUrl(''), false);
});
