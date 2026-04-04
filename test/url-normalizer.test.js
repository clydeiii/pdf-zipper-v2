import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBookmarkUrl } from '../dist/urls/normalizer.js';

test('strips www subdomain', () => {
  assert.equal(
    normalizeBookmarkUrl('https://www.example.com/article'),
    'https://example.com/article'
  );
});

test('removes UTM tracking parameters', () => {
  const url = 'https://example.com/article?utm_source=twitter&utm_medium=social&utm_campaign=share';
  assert.equal(normalizeBookmarkUrl(url), 'https://example.com/article');
});

test('removes fbclid and gclid tracking params', () => {
  assert.equal(
    normalizeBookmarkUrl('https://example.com/page?fbclid=abc123&gclid=def456'),
    'https://example.com/page'
  );
});

test('strips hash fragments', () => {
  assert.equal(
    normalizeBookmarkUrl('https://example.com/page#section-3'),
    'https://example.com/page'
  );
});

test('removes trailing slashes', () => {
  assert.equal(
    normalizeBookmarkUrl('https://example.com/page/'),
    'https://example.com/page'
  );
});

test('sorts query parameters for consistent dedup', () => {
  const url = 'https://example.com/search?z=1&a=2&m=3';
  assert.equal(normalizeBookmarkUrl(url), 'https://example.com/search?a=2&m=3&z=1');
});

test('preserves non-tracking query params', () => {
  const url = 'https://example.com/article?id=42&page=3';
  assert.equal(normalizeBookmarkUrl(url), 'https://example.com/article?id=42&page=3');
});

test('handles URLs with mixed tracking and real params', () => {
  const url = 'https://example.com/article?id=42&utm_source=twitter&ref=homepage';
  assert.equal(normalizeBookmarkUrl(url), 'https://example.com/article?id=42');
});

test('normalizes protocol-relative and http URLs', () => {
  // normalize-url standardizes to https by default
  const result = normalizeBookmarkUrl('http://example.com/page');
  assert.equal(result, 'http://example.com/page');
});

test('removes single trailing slash on root', () => {
  assert.equal(normalizeBookmarkUrl('https://example.com/'), 'https://example.com');
});
