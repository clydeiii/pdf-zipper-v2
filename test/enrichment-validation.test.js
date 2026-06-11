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

test('rejects near-miss author whose token is a substring of a real word', () => {
  const meta = {
    title: 'T', author: 'Daniela Amode', publication: null, publishDate: null,
    language: 'en', summary: '', tags: [],
  };
  const out = validateFactualFields(meta, 'Anthropic CEO Daniela Amodei spoke today.', 'https://example.com');
  assert.equal(out.author, null);
});

test('keeps exactly-spelled author at word boundaries', () => {
  const meta = {
    title: 'T', author: 'Daniela Amodei', publication: null, publishDate: null,
    language: 'en', summary: '', tags: [],
  };
  const out = validateFactualFields(meta, 'By Daniela Amodei.', 'https://example.com');
  assert.equal(out.author, 'Daniela Amodei');
});

import { unsupportedSummaryName } from '../dist/metadata/enrichment.js';

test('summary ghost-name: flags a person not in source/title', () => {
  const hay = "mike krieger talks with dan shipper about claude fable 5".toLowerCase();
  assert.equal(unsupportedSummaryName("This interview with Dan O'Toole explores Claude Fable 5.", hay), "Dan O'Toole");
});

test('summary ghost-name: passes when all name tokens are in source', () => {
  const hay = "mike krieger talks with dan shipper about claude fable 5".toLowerCase();
  assert.equal(unsupportedSummaryName("Mike Krieger discusses Claude Fable with Dan Shipper.", hay), null);
});

test('summary ghost-name: passes when name token in title only', () => {
  const hay = "...transcript body without the name...\nhow anthropic uses claude fable 5 with mike krieger\nhttps://youtube.com/watch?v=x".toLowerCase();
  assert.equal(unsupportedSummaryName("Mike Krieger explains the workflow shift.", hay), null);
});
