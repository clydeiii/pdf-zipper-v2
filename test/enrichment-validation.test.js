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

import { reconcileTitle } from '../dist/metadata/enrichment.js';

test('reconcileTitle: falls back to page headline when LLM swaps the subject', () => {
  const out = reconcileTitle(
    'Trump administration lost the White House’s trust — and then its flagship product',
    'How Anthropic lost the White House’s trust — and then its flagship product - The Washington Post',
    'The Washington Post'
  );
  assert.equal(out, 'How Anthropic lost the White House’s trust — and then its flagship product');
});

test('reconcileTitle: keeps a faithful LLM trim (page-title subset)', () => {
  const out = reconcileTitle(
    'How Anthropic lost the White House’s trust — and then its flagship product',
    'How Anthropic lost the White House’s trust — and then its flagship product - The Washington Post',
    'The Washington Post'
  );
  assert.equal(out, 'How Anthropic lost the White House’s trust — and then its flagship product');
});

test('reconcileTitle: trusts LLM when page title is thin/generic', () => {
  const out = reconcileTitle('A Real Extracted Headline About Cats', 'Home | Acme', 'Acme');
  assert.equal(out, 'A Real Extracted Headline About Cats');
});

test('reconcileTitle: trusts LLM when no page title', () => {
  const out = reconcileTitle('A clean extracted headline', undefined, null);
  assert.equal(out, 'A clean extracted headline');
});

test('reconcileTitle: preserves em-dash in headline (only strips site suffix)', () => {
  const out = reconcileTitle(
    'Completely Different Words Here Replacing Everything Original',
    'Real Headline — with an em-dash clause | Example News',
    'Example News'
  );
  assert.equal(out, 'Real Headline — with an em-dash clause');
});

// --- Publication: famous-outlet hallucination guard ---

import { isPublicationSupported, claimsWellKnownPublisher } from '../dist/metadata/enrichment.js';

test('replaces a famous outlet claimed on an unrelated domain', () => {
  // The observed failure: 265 library files attributing other people's blogs
  // to the NYT, primed by the prompt's own example.
  const meta = { ...base, publication: 'The New York Times' };
  const out = validateFactualFields(meta, 'Today we are releasing a new model.', 'https://www.anthropic.com/news/claude');
  assert.equal(out.publication, 'Anthropic');
});

test('falls back to the domain name, never to null', () => {
  const meta = { ...base, publication: 'The New York Times' };
  const out = validateFactualFields(meta, 'A post about scaling.', 'https://qwen.ai/blog?id=qwen3.8');
  assert.equal(out.publication, 'Qwen');
});

test('a real masthead near the top rescues the claim', () => {
  // Archive/mirror captures carry the outlet in the page text even though the
  // URL host is not nytimes.com.
  const meta = { ...base, publication: 'The New York Times' };
  const text = 'The New York Times\nOpinion | The case for optimism\nBy A. Writer';
  const out = validateFactualFields(meta, text, 'https://archive.is/abc123');
  assert.equal(out.publication, 'The New York Times');
});

test('a passing mention deep in the body does not rescue the claim', () => {
  const meta = { ...base, publication: 'The New York Times' };
  const text = `${'filler about model evaluations. '.repeat(200)} as The New York Times reported last week`;
  const out = validateFactualFields(meta, text, 'https://simonwillison.net/2026/Aug/1/thing/');
  assert.equal(out.publication, 'Simonwillison');
});

test('a known publisher domain stays authoritative', () => {
  const meta = { ...base, publication: 'The New York Times' };
  const out = validateFactualFields(meta, 'body text', 'https://www.nytimes.com/2026/08/01/tech.html');
  assert.equal(out.publication, 'The New York Times');
});

test('niche publication names are left alone (no churn)', () => {
  // The domain-derived alternative for open.substack.com is the useless
  // "Open", so an unrecognised name must be kept rather than "corrected".
  for (const [pub, url] of [
    ['Transformer News', 'https://open.substack.com/pub/transformer/p/x'],
    ['The Leverage', 'https://open.substack.com/pub/leverage/p/y'],
    ['X (formerly Twitter)', 'https://x.com/someone/status/123'],
  ]) {
    const out = validateFactualFields({ ...base, publication: pub }, 'unrelated body text', url);
    assert.equal(out.publication, pub, `${pub} should be preserved`);
  }
});

test('an outlet name on a tweet capture resolves to the platform', () => {
  // A tweet from an outlet's account is published on X, not in the outlet.
  const out = validateFactualFields(
    { ...base, publication: 'The Information' },
    'a tweet body',
    'https://x.com/theinformation/status/123',
  );
  assert.equal(out.publication, 'X');
});

test('isPublicationSupported accepts names that match their own domain', () => {
  assert.equal(isPublicationSupported('X', '', 'https://x.com/a/status/1'), true);
  assert.equal(isPublicationSupported('Epoch AI', '', 'https://epoch.ai/MirrorCode'), true);
  assert.equal(isPublicationSupported('Natto Thoughts', '', 'https://www.nattothoughts.com/p/a'), true);
  assert.equal(isPublicationSupported('The Verge', '', 'https://www.theverge.com/a'), true);
  assert.equal(isPublicationSupported('The New York Times', '', 'https://simonwillison.net/a'), false);
});

test('claimsWellKnownPublisher matches on name, ignoring case and leading The', () => {
  assert.equal(claimsWellKnownPublisher('the new york times'), true);
  assert.equal(claimsWellKnownPublisher('Financial Times'), true);
  assert.equal(claimsWellKnownPublisher('BBC'), true);
  assert.equal(claimsWellKnownPublisher('Transformer News'), false);
  assert.equal(claimsWellKnownPublisher('Qwen'), false);
});
