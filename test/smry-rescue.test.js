import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeMachineBlob, buildSmryHtml, SMRY_MIN_CHARS } from '../dist/converters/smry-rescue.js';

// Real failure mode observed 2026-08-17: The Information hands smry its
// page-config JSON and smry returns it as qualityStatus:"usable" content.
const INFORMATION_STYLE_BLOB = '{"analytics":{"pageId":17614,"page":"article","contentType":"article","contentId":17614,"creatorIds":[47748,2500412,8,1720773]},"env":{"BLUECONIC_COLLECTOR_ID":"6b95136b","CLOUDFLARE_SITE_KEY":"0x4AAAAAABImzmbslpav3Ywl","DEEP_RESEARCH_ENGINE":"rubyllm"}}'.repeat(20);

test('machine blob: leading JSON object is rejected', () => {
  assert.equal(looksLikeMachineBlob(INFORMATION_STYLE_BLOB), true);
});

test('machine blob: leading JSON array is rejected', () => {
  assert.equal(looksLikeMachineBlob('[{"id":1},{"id":2}]' + 'x'.repeat(3000)), true);
});

test('machine blob: JSON after a text preamble is caught by density', () => {
  const blob = 'Page config\n' + '{"key":"value","other":"thing","n":1},'.repeat(120);
  assert.equal(looksLikeMachineBlob(blob), true);
});

test('real prose with quotes and braces passes', () => {
  const prose = ('"This raises so many questions about authorship," the agency said. ' +
    'Yet with a new AI scandal engulfing publishing seemingly every month, ' +
    'it has become difficult to punt questions {sic} into some distant future. ').repeat(20);
  assert.equal(looksLikeMachineBlob(prose), false);
});

test('short fragments are not classified as blobs by density', () => {
  assert.equal(looksLikeMachineBlob('a "quoted" note'), false);
});

test('min-chars floor sits above observed hard-paywall ledes', () => {
  // WSJ lede-only partial measured at 1,933 chars with truncated:false —
  // the floor is the only defense against archiving it as a full capture.
  assert.ok(SMRY_MIN_CHARS > 1933, `floor ${SMRY_MIN_CHARS} must exceed observed lede size`);
});

const BASE_ARTICLE = {
  title: 'Test <Article> & Title',
  author: 'Jane "Q" Author',
  siteName: 'Example Site',
  publishedAt: '2026-08-14T21:09:54.161Z',
  sourceUrl: 'https://example.com/a?x=<1>',
  headings: ['Section One'],
  content: 'First paragraph line one.\nLine two of same paragraph.\n\nSection One\n\nSecond paragraph with <script>alert(1)</script> inside.',
};

test('buildSmryHtml escapes HTML in title, byline, source, and body', () => {
  const html = buildSmryHtml(BASE_ARTICLE);
  assert.ok(!html.includes('<script>alert'), 'script tag must be escaped');
  assert.ok(html.includes('Test &lt;Article&gt; &amp; Title'));
  assert.ok(html.includes('&lt;1&gt;'), 'source URL angle brackets escaped');
});

test('buildSmryHtml renders paragraphs, soft breaks, and headings', () => {
  const html = buildSmryHtml(BASE_ARTICLE);
  assert.ok(html.includes('First paragraph line one.<br>Line two of same paragraph.'));
  assert.ok(html.includes('<h2>Section One</h2>'), 'exact heading match renders as h2');
  assert.match(html, /<p>Second paragraph/);
});

test('buildSmryHtml byline carries author, site, and date-only timestamp', () => {
  const html = buildSmryHtml(BASE_ARTICLE);
  assert.ok(html.includes('Jane &quot;Q&quot; Author · Example Site · 2026-08-14'));
});

test('buildSmryHtml omits byline pieces that are null', () => {
  const html = buildSmryHtml({ ...BASE_ARTICLE, author: null, siteName: null, publishedAt: null });
  assert.ok(!html.includes('class="byline"'), 'no byline div when all parts missing');
});
