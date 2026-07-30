import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTwitterHtml } from '../dist/api/routes/twitter.js';

test('Twitter HTML sanitizer removes active elements and attributes', () => {
  const sanitized = sanitizeTwitterHtml(`
    <base href="https://evil.example/">
    <meta http-equiv="refresh" content="0;url=https://evil.example">
    <link rel="stylesheet" href="https://evil.example/x.css">
    <form action="https://evil.example"><button formaction="https://evil.example">submit</button></form>
    <p style="display:none" class="x" id="x" onclick="alert(1)">Safe
      <a href="data:text/html,x" onfocus="alert(3)">data</a>
      <a href="jav&#x09;ascript:alert(2)">tab</a>
    </p>
    <script>alert(4)</script>
    <style>body { display: none }</style>
    <iframe srcdoc="<script>alert(5)</script>">frame text</iframe>
    <object data="x"></object>
    <embed src="x">
    <plaintext>plain text
    <svg onload="alert(6)"><text>svg text</text></svg>
  `);

  assert.match(sanitized, /<p>Safe\s+<a>data<\/a>\s+<a>tab<\/a>\s+<\/p>/);
  assert.match(sanitized, /plain text/);
  assert.doesNotMatch(
    sanitized,
    /<(?:base|meta|link|form|button|script|style|iframe|object|embed|plaintext|svg|text)\b|style=|class=|id=|data:|javascript:|formaction|srcdoc/i,
  );
});

test('Twitter HTML sanitizer preserves ordinary safe tweet markup', () => {
  assert.equal(
    sanitizeTwitterHtml('<p lang="ja">こんにちは <a href="https://x.com/foo" title="profile">@foo</a><br>世界</p>'),
    '<p lang="ja">こんにちは <a href="https://x.com/foo" title="profile">@foo</a><br>世界</p>',
  );
});
