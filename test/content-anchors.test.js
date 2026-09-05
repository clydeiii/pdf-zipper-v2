import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { pickAnchors, normalizeForAnchorMatch, checkAnchors, buildAnchorFlags } from '../dist/quality/content-anchors.js';
import { analyzePdfContent } from '../dist/quality/pdf-content.js';
import { extractJsonLdWordCount } from '../dist/converters/jsonld-body.js';

const paragraphs = Array.from({ length: 30 }, (_, i) =>
  `Paragraph ${String(i).padStart(2, '0')} describes a distinctive observation about the research and explains its practical implications for readers.`);
const complete = paragraphs.join('\n\n');
const anchors = pickAnchors(paragraphs);
const anchorsJson = JSON.stringify(anchors);

test('selects deterministic first, middle, and last sentences in a 30-paragraph article', () => {
  assert.equal(anchors.length, 3);
  assert.equal(anchors[0], normalizeForAnchorMatch(paragraphs[0]));
  assert.match(anchors[1], /^paragraph 1[45] /);
  assert.equal(anchors[2], normalizeForAnchorMatch(paragraphs[29]));
  assert.deepEqual(pickAnchors(paragraphs), anchors);
  assert.ok(anchorsJson.length <= 600);
  for (const anchor of anchors) {
    assert.ok(anchor.length >= 60 && anchor.length <= 200);
    assert.ok(anchor.split(' ').length >= 6);
  }
});

test('normalizes typography, discretionary word wraps, casing, and whitespace on both sides', () => {
  assert.equal(normalizeForAnchorMatch('  “A docu-\nment” — isn’t\t‘soft\u00adhyphenated’!  '),
    normalizeForAnchorMatch('"A document" – isn\'t \'softhyphenated\'!'));
  assert.equal(normalizeForAnchorMatch('docu\u00ad\nment\r\n  TEST'), 'document test');
  assert.equal(normalizeForAnchorMatch('well-known'), 'well-known');
  assert.deepEqual(checkAnchors(JSON.stringify(['“The document”', 'isn’t', 'the end — yes']),
    '"The docu-\nment" ISN\'T the end – yes'), { missing: [], lastMissing: false });
});

test('selects separate sentences within a single long paragraph before case normalization', () => {
  assert.deepEqual(pickAnchors([paragraphs.join(' ')]), anchors);
});

test('missing final paragraph produces the strongest truncation flag', () => {
  const clipped = paragraphs.slice(0, -1).join('\n');
  assert.deepEqual(checkAnchors(anchorsJson, clipped), { missing: [2], lastMissing: true });
  assert.deepEqual(buildAnchorFlags(anchorsJson, clipped, complete.length), [
    'truncation_suspect: last anchor missing', 'truncation_suspect: 1 of 3 anchors missing',
  ]);
});

test('complete text flags nothing, even when the source length ratio is low', () => {
  assert.deepEqual(buildAnchorFlags(anchorsJson, complete, complete.length), []);
  assert.deepEqual(buildAnchorFlags(anchorsJson, complete, complete.length * 10), []);
});

test('length flag requires a missing anchor and a ratio strictly below 60%', () => {
  const text = anchors[0];
  assert.deepEqual(checkAnchors(anchorsJson, text), { missing: [1, 2], lastMissing: true });
  assert.ok(buildAnchorFlags(anchorsJson, text, text.length * 2).includes('length_mismatch: PDF text is 50% of SourceTextChars'));
  assert.ok(!buildAnchorFlags(anchorsJson, text, text.length / 0.6).some(f => f.startsWith('length_mismatch')));
  for (const length of [undefined, 0, -100, 'invalid', Infinity]) {
    assert.ok(!buildAnchorFlags(anchorsJson, text, length).some(f => f.startsWith('length_mismatch')));
  }
});

test('missing middle only reports the count, not a missing tail', () => {
  assert.deepEqual(buildAnchorFlags(anchorsJson, `${anchors[0]} ${anchors[2]}`), ['truncation_suspect: 1 of 3 anchors missing']);
});

test('invalid and incomplete metadata cannot create truncation evidence', () => {
  for (const json of [undefined, '', 'oops', '{}', '[]', '["one"]', '["one",null,"three"]', '["one","  ","three"]']) {
    assert.deepEqual(buildAnchorFlags(json, '', 10000), []);
  }
});

test('skips weak/repeated candidates and does not substitute a middle sentence for the tail', () => {
  assert.deepEqual(pickAnchors(['Menu Home About', 'Antidisestablishmentarianism counterrevolutionaries institutionalization.']), []);
  assert.deepEqual(pickAnchors(Array(30).fill(paragraphs[0])), []);
  assert.deepEqual(pickAnchors([...paragraphs.slice(0, 20), ...Array(10).fill('Home Contact Privacy Subscribe '.repeat(4))]), []);
  assert.deepEqual(pickAnchors(paragraphs, complete + '\n' + 'code '.repeat(2000)), []);
});

test('JSON escaping cannot exceed the serialized 600-character budget', () => {
  const quoted = paragraphs.map(p => p.replace('distinctive', '"distinctive"'));
  const picked = pickAnchors(quoted);
  assert.equal(picked.length, 3);
  assert.ok(JSON.stringify(picked).length <= 600);
  assert.deepEqual(checkAnchors(JSON.stringify(picked), quoted.join('\n')).missing, []);
});

test('reads declared article word counts from JSON-LD without following related stories', () => {
  assert.equal(extractJsonLdWordCount(['bad JSON', JSON.stringify({ '@graph': [
    { '@type': 'WebPage', wordCount: 99 }, { '@type': ['Thing', 'NewsArticle'], wordCount: '1200' },
  ] })]), 1200);
  assert.equal(extractJsonLdWordCount([JSON.stringify({ mainEntity: { '@type': 'Article', wordCount: 50 } })]), 50);
  assert.equal(extractJsonLdWordCount([JSON.stringify({ relatedArticles: [{ '@type': 'Article', wordCount: 55 }] })]), undefined);
  for (const wordCount of [0, -1, 2.5, 'many', true, null]) {
    assert.equal(extractJsonLdWordCount([JSON.stringify({ '@type': 'Article', wordCount })]), undefined);
  }
});

test('auditor extraction preserves wrapped words without changing content verdicts or metrics', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('The docu-\nment contains a distinctive final sentence that must survive extraction.', { x: 30, y: 700, size: 10, font });
  const buffer = Buffer.from(await doc.save());
  const normal = await analyzePdfContent(buffer);
  const layout = await analyzePdfContent(buffer, { preserveTextLayout: true });
  assert.match(normalizeForAnchorMatch(layout.extractedText), /the document contains/);
  const { extractedText: _normal, ...normalVerdict } = normal;
  const { extractedText: _layout, ...layoutVerdict } = layout;
  assert.deepEqual(normalVerdict, layoutVerdict);
});
