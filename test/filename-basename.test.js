import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUrlBaseName } from '../dist/utils/save-pdf.js';

const REPORT_TITLE = 'FrontierMath Batch 2: Evaluating AI Mathematical Reasoning';

test('generic report.pdf falls back to title', () => {
  const base = buildUrlBaseName('https://epoch.ai/report.pdf', { title: REPORT_TITLE });
  assert.ok(base.includes('frontiermath'), `expected title slug, got: ${base}`);
  assert.ok(!base.includes('report.pdf'), `should not keep generic stem: ${base}`);
});

test('generic stem in a deep path still uses title', () => {
  const base = buildUrlBaseName('https://example.org/files/2026/paper.pdf', { title: REPORT_TITLE });
  assert.ok(base.includes('frontiermath'), base);
});

test('no .pdf.pdf double extension for descriptive pdf filenames', () => {
  const base = buildUrlBaseName('https://example.org/annual-ai-report-2026.pdf', {});
  assert.ok(base.endsWith('annual-ai-report-2026'), base);
  assert.ok(!/\.pdf$/i.test(base), `basename must not retain .pdf: ${base}`);
});

test('descriptive arxiv-style pdf path is preserved (not treated generic)', () => {
  const base = buildUrlBaseName('https://arxiv.org/pdf/2310.12345', { title: 'Some Paper' });
  assert.ok(base.includes('2310.12345'), base);
});

test('generic stem with no title falls back to path (single .pdf-stripped)', () => {
  const base = buildUrlBaseName('https://example.org/report.pdf', {});
  assert.ok(!/report\.pdf/i.test(base), base);
  assert.ok(base.includes('example.org'), base);
});

import { isGenericPdfBasename } from '../dist/utils/save-pdf.js';

test('isGenericPdfBasename: catches generic + double-extension names', () => {
  assert.equal(isGenericPdfBasename('report.pdf.pdf'), true);
  assert.equal(isGenericPdfBasename('report.pdf'), true);
  assert.equal(isGenericPdfBasename('paper'), true);
  assert.equal(isGenericPdfBasename('main.pdf'), true);
  assert.equal(isGenericPdfBasename('download.pdf'), true);
});

test('isGenericPdfBasename: leaves descriptive names alone', () => {
  assert.equal(isGenericPdfBasename('frontiermath-batch-2.pdf'), false);
  assert.equal(isGenericPdfBasename('june-2026-threat-report.pdf'), false);
  assert.equal(isGenericPdfBasename('2604.01007v2.pdf'), false);
});
