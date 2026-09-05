import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import Turndown from 'turndown';
import { tables } from 'turndown-plugin-gfm';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  shouldExtractMarkdown, markdownSkipReason, capMarkdownAtParagraph,
  markdownMaxChars, buildMarkdownExtractedBy, markdownInfoDictFields,
  htmlToMarkdown, extractMarkdown,
} from '../dist/converters/markdown-extract.js';
import { setInfoDictFields, readInfoDictField } from '../dist/utils/pdf-info-dict.js';

const articleUrl = 'https://example.com/posts/article';

test('article eligibility checks source and redirected URL with host boundaries', () => {
  const skipped = [
    ['https://x.com/user/status/123', 'twitter'],
    ['https://mobile.twitter.com/user/status/123', 'twitter'],
    ['https://www.x.com/i/article/123', 'twitter'],
    ['http://nitter:8080/user/status/123', 'nitter'],
    ['http://localhost:8080/user/status/123', 'nitter'],
    ...['is', 'today', 'ph', 'li', 'md', 'vn', 'fo'].map(tld => [`https://archive.${tld}/123`, 'archive_snapshot']),
    ['https://huggingface.co/spaces/org/app', 'hf_space'],
    ['https://org-app.hf.space/', 'hf_space'],
    ['https://datawrapper.de/_/123/', 'datawrapper'],
    ['https://datawrapper.dwcdn.net/123/', 'datawrapper'],
    ['not a url', 'invalid_url'],
  ];
  for (const [url, reason] of skipped) {
    assert.equal(shouldExtractMarkdown(url, articleUrl), false, url);
    assert.equal(shouldExtractMarkdown(articleUrl, url), false, url);
    assert.equal(markdownSkipReason(articleUrl, url), reason);
  }
  assert.equal(shouldExtractMarkdown(articleUrl, 'https://tweets.internal/u/1', 'https://tweets.internal'), false);
  for (const url of [articleUrl, 'https://huggingface.co/blog/article', 'https://blog.datawrapper.de/article', 'https://archive.today.example.com/article', 'https://example.com/x.com/status/1']) {
    assert.equal(shouldExtractMarkdown(url, url), true, url);
  }
});

test('cap preserves full length, exact-limit text, paragraph boundaries and Unicode', () => {
  const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
  assert.deepEqual(capMarkdownAtParagraph(text, text.length), { markdown: text, fullLength: text.length, truncated: false });
  assert.deepEqual(capMarkdownAtParagraph(text, 40), { markdown: 'First paragraph.\n\nSecond paragraph.', fullLength: text.length, truncated: true });
  assert.equal(capMarkdownAtParagraph('first\r\n\r\nsecond', 12).markdown, 'first');
  assert.equal(capMarkdownAtParagraph('😀 text\n\n😀 more text', 12).markdown, '😀 text');
  assert.equal(capMarkdownAtParagraph('one oversized paragraph', 10).markdown, '');
  assert.equal(capMarkdownAtParagraph('first\n\nsecond', 5).markdown, 'first');
  const code = 'Intro.\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\nEnd.';
  assert.equal(capMarkdownAtParagraph(code, 35).markdown, 'Intro.');
  assert.equal(capMarkdownAtParagraph(code, code.indexOf('\n\nEnd.')).markdown, code.slice(0, code.indexOf('\n\nEnd.')));
  assert.deepEqual(capMarkdownAtParagraph(''), { markdown: '', fullLength: 0, truncated: false });
});

test('cap environment accepts positive integer overrides and defaults on invalid values', () => {
  assert.equal(markdownMaxChars('12345'), 12345);
  for (const value of [undefined, '', '0', '-1', 'no', '1.5', 'Infinity']) {
    assert.equal(markdownMaxChars(value), 200_000);
  }
});

test('extractor provenance includes server marker and actual package versions', () => {
  assert.equal(buildMarkdownExtractedBy('0.6.0', '7.2.0'), 'readability+turndown@server r0.6.0 t7.2.0');
});

function extraction(markdown = 'Article text. '.repeat(50), readability = {}) {
  return { ...capMarkdownAtParagraph(markdown), extractedBy: buildMarkdownExtractedBy('0.6.0', '7.2.4'), readability };
}

test('Info Dict fields are optional, additive and use pre-cap length', () => {
  assert.deepEqual(markdownInfoDictFields(), {});
  assert.deepEqual(markdownInfoDictFields(extraction('short')), {});
  assert.deepEqual(markdownInfoDictFields(extraction('')), {});
  const result = extraction('a'.repeat(500) + '\n\n' + 'b'.repeat(500), {
    byline: 'An Author', siteName: 'A Site', publishedTime: '2026-09-05',
    excerpt: 'An excerpt', lang: 'en', title: 'Readability title',
  });
  Object.assign(result, capMarkdownAtParagraph(result.markdown, 600));
  assert.deepEqual(markdownInfoDictFields(result), {
    Markdown: 'a'.repeat(500), MarkdownLength: '1002',
    MarkdownExtractedBy: result.extractedBy, MarkdownTruncated: 'true',
    ReadabilityByline: 'An Author', ReadabilitySiteName: 'A Site',
    ReadabilityPublishedTime: '2026-09-05', ReadabilityExcerpt: 'An excerpt', ReadabilityLang: 'en',
  });
  const uncapped = markdownInfoDictFields(extraction('x'.repeat(500), { byline: null, siteName: '' }));
  assert.deepEqual(Object.keys(uncapped).sort(), ['Markdown', 'MarkdownExtractedBy', 'MarkdownLength']);
});

const fixture = '<h2>Example</h2><blockquote><p>Keep these exact words.</p></blockquote>' +
  '<pre><code class="language-js">const x = 1;\nconsole.log(x);\n</code></pre>' +
  '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Alpha</td><td>42</td></tr></tbody></table>' +
  '<p><a href="../guide">Guide</a> <img src="./chart.png" alt="Chart"></p>';

test('shared Turndown conversion preserves code, GFM tables, headings, quotes and absolute links', () => {
  assert.equal(htmlToMarkdown(fixture, articleUrl, Turndown, tables), [
    '## Example', '> Keep these exact words.', '```js\nconst x = 1;\nconsole.log(x);\n```',
    '| Name | Value |\n| --- | --- |\n| Alpha | 42 |',
    '[Guide](https://example.com/guide) ![Chart](https://example.com/posts/chart.png)',
  ].join('\n\n'));
});

test('200k Unicode Markdown round-trips through PDF hex strings without entering files-list metadata', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.setSubject(articleUrl);
  const markdown = 'é 漢字 😀 <script> " &\n\n'.repeat(10000).slice(0, 200000);
  setInfoDictFields(doc, { ...markdownInfoDictFields(extraction(markdown)), Summary: 'Safe summary' });
  const bytes = await doc.save();
  const loaded = await PDFDocument.load(bytes);
  // pdf-lib 1.17's decodeText spreads all code points into fromCharCode and
  // overflows the JS call stack at this size; the stored UTF-16 bytes are valid.
  const raw = loaded.getInfoDict().get(PDFName.of('Markdown')).asBytes();
  assert.ok(new TextDecoder('utf-16be').decode(raw) === markdown);

  // Exercise the actual list reader without importing routes that open Redis.
  const source = await readFile(new URL('../dist/api/routes/files.js', import.meta.url), 'utf8');
  const reader = source.match(/async function loadPdfFileInfo\([\s\S]*?\n\}/)?.[0];
  assert.ok(reader);
  const fieldsRead = [];
  const loadInfo = vm.runInNewContext(`(${reader})`, {
    pdfInfoCache: new Map(), cachePdfInfo() {}, readFile: async () => bytes, PDFDocument,
    readInfoDictField(pdf, field) { fieldsRead.push(field); return readInfoDictField(pdf, field); },
    parsePercentField: () => undefined, aiInvolvementPercent: () => undefined,
  });
  const info = await loadInfo('in-memory.pdf', 1);
  assert.equal(info.sourceUrl, articleUrl);
  assert.equal(info.metadata.summary, 'Safe summary');
  assert.ok(!fieldsRead.some(field => field.startsWith('Markdown')));
  assert.ok(!JSON.stringify(info).includes('<script>'));
});

test('extraction errors and URL skips remain non-fatal and log structured reasons', async t => {
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(JSON.parse(line)));
  assert.equal(await extractMarkdown({ url: () => 'https://x.com/u/status/1' }, articleUrl, 'http://nitter:8080'), undefined);
  const page = {
    url: () => articleUrl,
    context: () => ({ newCDPSession: async () => ({ detach: async () => {} }) }),
    addScriptTag: async () => { throw new Error('CSP blocked script'); },
  };
  assert.equal(await extractMarkdown(page, articleUrl, 'http://nitter:8080'), undefined);
  assert.deepEqual(logs.map(log => log.reason), ['twitter', 'extraction_error']);
  assert.ok(logs.every(log => log.event === 'markdown_skipped' && log.timestamp && log.url === articleUrl));
});

test('eight-second deadline interrupts Chromium and proceeds without Markdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(JSON.parse(line)));
  const commands = [];
  const page = {
    url: () => articleUrl,
    context: () => ({ newCDPSession: async () => ({
      send: async command => { commands.push(command); }, detach: async () => {},
    }) }),
    addScriptTag: async () => {},
    evaluate: () => new Promise(() => {}),
  };
  const pending = extractMarkdown(page, articleUrl, 'http://nitter:8080');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(8000);
  assert.equal(await pending, undefined);
  assert.deepEqual(commands, ['Runtime.terminateExecution']);
  assert.equal(logs[0].reason, 'timeout');
});

test('successful browser result uses package versions and logs full length', async t => {
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(JSON.parse(line)));
  const require = createRequire(import.meta.url);
  const page = {
    url: () => articleUrl,
    context: () => ({ newCDPSession: async () => ({ detach: async () => {} }) }),
    addScriptTag: async ({ content }) => { assert.ok(content.includes('isProbablyReaderable')); },
    evaluate: async () => ({ markdown: 'x'.repeat(500), readability: { lang: 'en' } }),
  };
  const result = await extractMarkdown(page, articleUrl, 'http://nitter:8080');
  assert.equal(result.extractedBy, buildMarkdownExtractedBy(require('@mozilla/readability/package.json').version, require('turndown/package.json').version));
  assert.equal(result.readability.lang, 'en');
  assert.equal(logs[0].event, 'markdown_extracted');
  assert.equal(logs[0].chars, 500);
  assert.equal(logs[0].truncated, false);
});

test('readerability rejection, null parse and short extraction omit metadata; cap logs original length', async t => {
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(JSON.parse(line)));
  const previousCap = process.env.MARKDOWN_MAX_CHARS;
  t.after(() => {
    if (previousCap === undefined) delete process.env.MARKDOWN_MAX_CHARS;
    else process.env.MARKDOWN_MAX_CHARS = previousCap;
  });
  process.env.MARKDOWN_MAX_CHARS = '600';
  let browserResult;
  const page = {
    url: () => articleUrl,
    context: () => ({ newCDPSession: async () => ({ detach: async () => {} }) }),
    addScriptTag: async () => {},
    evaluate: async () => browserResult,
  };
  for (const result of [{ reason: 'not_readerable' }, { reason: 'readability_empty' },
    { markdown: 'x'.repeat(499), readability: { byline: 'Omit me' } },
    { markdown: 'x'.repeat(601), readability: {} }]) {
    browserResult = result;
    assert.equal(await extractMarkdown(page, articleUrl, 'http://nitter:8080'), undefined);
  }
  assert.deepEqual(logs.map(log => log.reason), ['not_readerable', 'readability_empty', 'too_short', 'no_paragraph_within_cap']);
  browserResult = { markdown: 'x'.repeat(500) + '\n\n' + 'y'.repeat(500), readability: {} };
  const result = await extractMarkdown(page, articleUrl, 'http://nitter:8080');
  assert.equal(result.markdown.length, 500);
  assert.equal(result.fullLength, 1002);
  assert.equal(result.truncated, true);
  assert.equal(logs.at(-1).chars, 1002);
  assert.equal(logs.at(-1).truncated, true);
});
