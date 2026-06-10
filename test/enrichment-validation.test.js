import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFactualFields } from '../dist/metadata/enrichment.js';

const base = {
  title: 'Some Article',
  author: null,
  publication: 'Example',
  publishDate: null,
  language: 'en',
  summary: 'A summary.',
  tags: ['tag'],
};

test('keeps author present verbatim in source text', () => {
  const meta = { ...base, author: 'Marc Andreessen' };
  const out = validateFactualFields(meta, 'An essay by Marc Andreessen about technology.', 'https://example.com/a');
  assert.equal(out.author, 'Marc Andreessen');
});

test('keeps author regardless of case', () => {
  const meta = { ...base, author: 'Jane Doe' };
  const out = validateFactualFields(meta, 'WRITTEN BY JANE DOE', 'https://example.com/a');
  assert.equal(out.author, 'Jane Doe');
});

test('rejects hallucinated author not in source text', () => {
  const meta = { ...base, author: 'John Smith' };
  const out = validateFactualFields(meta, 'An anonymous essay about AI policy and tools.', 'https://example.com/a');
  assert.equal(out.author, null);
});

test('rejects author when only one name token matches', () => {
  const meta = { ...base, author: 'Elon Musk' };
  const out = validateFactualFields(meta, 'Tesla and musk ox were not mentioned together. No byline.', 'https://example.com/a');
  // "musk" appears but "elon" does not — reject
  assert.equal(out.author, null);
});

test('keeps publishDate when year appears in text', () => {
  const meta = { ...base, publishDate: '2025-01-15' };
  const out = validateFactualFields(meta, 'Published January 15, 2025 by the desk.', 'https://example.com/a');
  assert.equal(out.publishDate, '2025-01-15');
});

test('keeps publishDate when year appears only in URL', () => {
  const meta = { ...base, publishDate: '2024-07-01' };
  const out = validateFactualFields(meta, 'No date in the body at all.', 'https://example.com/2024/07/article');
  assert.equal(out.publishDate, '2024-07-01');
});

test('rejects fabricated publishDate with no year evidence', () => {
  const meta = { ...base, publishDate: '2024-01-15' };
  const out = validateFactualFields(meta, 'Timeless essay with no dates whatsoever.', 'https://example.com/a');
  assert.equal(out.publishDate, null);
});

test('publication is exempt (URL-inferred by design)', () => {
  const meta = { ...base, publication: 'The New York Times' };
  const out = validateFactualFields(meta, 'Text never naming the publication.', 'https://nytimes.com/a');
  assert.equal(out.publication, 'The New York Times');
});

test('null author and date pass through untouched', () => {
  const out = validateFactualFields({ ...base }, 'whatever text', 'https://example.com');
  assert.equal(out.author, null);
  assert.equal(out.publishDate, null);
});
