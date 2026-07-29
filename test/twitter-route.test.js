import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTwitterHtml } from '../dist/api/routes/twitter.js';

test('Twitter HTML sanitizer removes active elements and attributes', () => {
  const sanitized = sanitizeTwitterHtml(`
    <p onclick="alert(1)">Safe <a href="javascript:alert(2)" onfocus="alert(3)">text</a></p>
    <script>alert(4)</script>
    <style>body { display: none }</style>
    <iframe src="https://example.com"></iframe>
    <object data="x"></object>
    <embed src="x">
  `);

  assert.match(sanitized, /<p>Safe <a>text<\/a><\/p>/);
  assert.doesNotMatch(sanitized, /script|style|iframe|object|embed|onclick|onfocus|javascript:/i);
});
