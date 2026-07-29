import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonLdArticleBody } from '../dist/converters/jsonld-body.js';

const BODY = 'Google on Monday released a series of new cheaper Gemini models. '.repeat(20);

test('extracts articleBody from a top-level NewsArticle', () => {
  const script = JSON.stringify({ '@type': 'NewsArticle', headline: 'x', articleBody: BODY });
  assert.equal(extractJsonLdArticleBody([script]), BODY);
});

test('extracts articleBody nested in @graph (Axios-style)', () => {
  const script = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', name: 'Axios' },
      { '@type': 'NewsArticle', articleBody: BODY },
    ],
  });
  assert.equal(extractJsonLdArticleBody([script]), BODY);
});

test('extracts articleBody from a top-level array and array @type', () => {
  const script = JSON.stringify([
    { '@type': ['ReportageNewsArticle', 'Thing'], articleBody: BODY },
  ]);
  assert.equal(extractJsonLdArticleBody([script]), BODY);
});

test('returns longest body when several scripts have one', () => {
  const short = JSON.stringify({ '@type': 'Article', articleBody: 'short body' });
  const long = JSON.stringify({ '@type': 'NewsArticle', articleBody: BODY });
  assert.equal(extractJsonLdArticleBody([short, long]), BODY);
});

test('ignores articleBody on non-article types', () => {
  const script = JSON.stringify({ '@type': 'WebPage', articleBody: BODY });
  assert.equal(extractJsonLdArticleBody([script]), null);
});

test('does not pull articleBody from unrelated nested keys (related-article lists)', () => {
  const script = JSON.stringify({
    '@type': 'WebPage',
    relatedArticles: [{ '@type': 'NewsArticle', articleBody: 'body of a DIFFERENT story' }],
  });
  assert.equal(extractJsonLdArticleBody([script]), null);
});

test('survives malformed JSON and empty scripts', () => {
  const good = JSON.stringify({ '@type': 'NewsArticle', articleBody: BODY });
  assert.equal(extractJsonLdArticleBody(['{not json', '', good]), BODY);
});

test('returns null when no JSON-LD body exists', () => {
  assert.equal(extractJsonLdArticleBody([JSON.stringify({ '@type': 'BreadcrumbList' })]), null);
});
