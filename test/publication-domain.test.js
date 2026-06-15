import test from 'node:test';
import assert from 'node:assert/strict';
import { knownPublicationForUrl } from '../dist/metadata/enrichment.js';

test('maps known publisher domains authoritatively', () => {
  assert.equal(knownPublicationForUrl('https://www.nature.com/articles/s41591-026-04431-5'), 'Nature');
  assert.equal(knownPublicationForUrl('https://www.nytimes.com/2026/06/10/tech/x.html'), 'The New York Times');
  assert.equal(knownPublicationForUrl('https://thenextweb.com/news/foo'), 'The Next Web');
  assert.equal(knownPublicationForUrl('https://arxiv.org/abs/2604.01007'), 'arXiv');
});

test('matches subdomains via suffix', () => {
  assert.equal(knownPublicationForUrl('https://archive.nature.com/x'), 'Nature');
});

test('returns null for unknown domains (LLM/hostname fallback applies)', () => {
  assert.equal(knownPublicationForUrl('https://someobscureblog.dev/post'), null);
  assert.equal(knownPublicationForUrl('not a url'), null);
});
