import test from 'node:test';
import assert from 'node:assert/strict';
import { isPdfUrl, rewriteToPdfUrl } from '../dist/converters/pdf.js';

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
  assert.equal(isPdfUrl('https://example.com/page.html'), false);
  assert.equal(isPdfUrl('https://arxiv.org/search/?query=llm'), false);
});

test('isPdfUrl detects arxiv abstract pages', () => {
  assert.equal(isPdfUrl('https://arxiv.org/abs/2506.12345'), true);
  assert.equal(isPdfUrl('https://arxiv.org/abs/2506.12345v2'), true);
});

test('isPdfUrl handles invalid URLs gracefully', () => {
  assert.equal(isPdfUrl('not-a-url'), false);
  assert.equal(isPdfUrl(''), false);
});

// rewriteToPdfUrl tests
test('rewriteToPdfUrl converts arxiv abstract to PDF URL', () => {
  assert.equal(
    rewriteToPdfUrl('https://arxiv.org/abs/2506.12345'),
    'https://arxiv.org/pdf/2506.12345'
  );
  assert.equal(
    rewriteToPdfUrl('https://arxiv.org/abs/2506.12345v2'),
    'https://arxiv.org/pdf/2506.12345v2'
  );
});

test('rewriteToPdfUrl converts arxiv HTML to PDF URL', () => {
  assert.equal(
    rewriteToPdfUrl('https://arxiv.org/html/2506.12345'),
    'https://arxiv.org/pdf/2506.12345'
  );
});

test('rewriteToPdfUrl passes through direct PDF URLs unchanged', () => {
  const directPdf = 'https://arxiv.org/pdf/2506.12345';
  assert.equal(rewriteToPdfUrl(directPdf), directPdf);

  const otherPdf = 'https://example.com/paper.pdf';
  assert.equal(rewriteToPdfUrl(otherPdf), otherPdf);
});

test('rewriteToPdfUrl passes through non-arxiv URLs unchanged', () => {
  assert.equal(
    rewriteToPdfUrl('https://example.com/article'),
    'https://example.com/article'
  );
});
