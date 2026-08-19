import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeMachineBlob, buildSmryHtml, SMRY_MIN_CHARS, SMRY_MIN_CHARS_HARD_PAYWALL, minCharsForUrl } from '../dist/converters/smry-rescue.js';

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

test('hard-paywall floor sits above observed lede sizes', () => {
  // WSJ lede 1,933 chars, Economist 1,946 — both with truncated:false; the
  // host-aware floor is the only defense against archiving them as complete.
  assert.ok(SMRY_MIN_CHARS_HARD_PAYWALL > 1946, `floor ${SMRY_MIN_CHARS_HARD_PAYWALL} must exceed observed lede size`);
});

test('floor is host-aware: paywalled publishers high, everyone else low', () => {
  assert.equal(minCharsForUrl('https://www.wsj.com/arts-culture/books/x'), SMRY_MIN_CHARS_HARD_PAYWALL);
  assert.equal(minCharsForUrl('https://www.bloomberg.com/news/articles/x'), SMRY_MIN_CHARS_HARD_PAYWALL);
  assert.equal(minCharsForUrl('https://www.axios.com/2026/08/19/x'), SMRY_MIN_CHARS);
  assert.equal(minCharsForUrl('not a url'), SMRY_MIN_CHARS);
});

test('a complete short Axios piece clears the default floor; a WSJ lede does not clear its own', () => {
  // Both ~1,940 chars — length alone cannot separate them; the host can.
  const axiosLen = 1949, wsjLedeLen = 1933;
  assert.ok(axiosLen >= minCharsForUrl('https://www.axios.com/2026/08/19/josh-shapiro-ai-data-centers-pivot'));
  assert.ok(wsjLedeLen < minCharsForUrl('https://www.wsj.com/finance/investing/x'));
});

test('default floor still rejects every observed junk page', () => {
  // Anti-bot block pages: jeffgamet 822, cursor.com 364, openreview 173.
  for (const junk of [822, 364, 173]) {
    assert.ok(junk < SMRY_MIN_CHARS, `junk page of ${junk} chars must stay below the default floor`);
  }
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

import { stripExtractionArtifacts } from '../dist/converters/smry-rescue.js';

// Real contamination observed on Axios 2026-08-19: prose interleaved with
// Tailwind class soup and attribute fragments. The gate rejected the whole
// article as a machine blob until the scrub was added.
const AXIOS_STYLE = `The data center fight is heating up. Here's how they work

*:last-child]:mb-0 [&_h2]:mt-8 [&_h2]:mb-4 [&_p]:break-words [&_p]:my-4 sm:[&_p]:my-6 [&_ul]:my-4 [&_ul]:text-p sm:[&_ul]:my-6 [&_ol]:my-4 [&_ol]:text-p sm:[&_ol]:my-6 [&_p:last-of-type]:pb-0 [&_p:last-of-type]:mb-0 [&_a]:underline [&_a]:text-interactive-tertiary [&_a:active]:no-underline [&_a:hover]:no-underline [&_a:visited]:text-interactive-tertiary

&.story-is-live data-chromatic="ignore">Data centers have become the face of AI backlash.
Why it matters: Rising opposition could pose an existential threat to AI's growth.`;

test('strip removes Tailwind class soup and attribute fragments', () => {
  const out = stripExtractionArtifacts(AXIOS_STYLE);
  assert.ok(!out.includes('[&_'), 'class soup removed');
  assert.ok(!out.includes(']:'), 'variant tokens removed');
  assert.ok(!out.includes('data-chromatic'), 'attribute fragment removed');
  assert.ok(out.includes('Data centers have become the face of AI backlash'), 'prose after > survives');
  assert.ok(out.includes('Why it matters: Rising opposition'), 'prose intact');
});

test('stripped Axios-style content passes the machine-blob gate', () => {
  const contaminated = AXIOS_STYLE.repeat(10);
  assert.equal(looksLikeMachineBlob(contaminated), true, 'raw contamination trips the gate');
  assert.equal(looksLikeMachineBlob(stripExtractionArtifacts(contaminated)), false, 'scrubbed prose passes');
});

test('strip leaves ordinary prose untouched', () => {
  const prose = 'A plain paragraph with "quotes" and a colon: nothing else.';
  assert.equal(stripExtractionArtifacts(prose), prose);
});

test('strip does not rescue actual JSON blobs', () => {
  const blob = '{"analytics":{"pageId":17614,"page":"article"}}'.repeat(30);
  assert.equal(looksLikeMachineBlob(stripExtractionArtifacts(blob).trim()), true);
});
