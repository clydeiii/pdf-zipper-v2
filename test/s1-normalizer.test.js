import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkForNormalization,
  normalizedOutputAcceptable,
  buildS1Prompt,
  NORMALIZE_CHUNK_CHARS,
} from '../dist/podcasts/s1-normalizer.js';

test('chunking splits at paragraph boundaries under the budget', () => {
  const para = 'Sentence one. Sentence two. '.repeat(40).trim(); // ~1,100 chars
  const text = [para, para, para, para, para].join('\n\n'); // ~5,600 chars
  const chunks = chunkForNormalization(text);
  assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length <= NORMALIZE_CHUNK_CHARS + 100, `chunk too big: ${c.length}`);
  }
  // Reassembly must lose nothing (whitespace-normalized comparison)
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('an oversized single paragraph splits at sentence boundaries', () => {
  const monster = 'This is a sentence that keeps going for a while. '.repeat(120).trim(); // ~5,900 chars
  const chunks = chunkForNormalization(monster);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= NORMALIZE_CHUNK_CHARS + 100, `chunk too big: ${c.length}`);
    assert.match(c, /\.$/, 'chunks should end at sentence boundaries');
  }
});

test('small transcript yields one chunk', () => {
  const chunks = chunkForNormalization('Short paragraph.\n\nAnother one.');
  assert.equal(chunks.length, 1);
});

test('sanity check rejects empty, collapsed, and bloated outputs', () => {
  const input = 'word '.repeat(200);
  assert.equal(normalizedOutputAcceptable(input, ''), false, 'empty rejected');
  assert.equal(normalizedOutputAcceptable(input, 'word word.'), false, 'collapsed rejected');
  assert.equal(normalizedOutputAcceptable(input, input + input), false, 'bloated rejected');
  assert.equal(normalizedOutputAcceptable(input, 'word '.repeat(190)), true, 'mild shrink accepted');
});

test('prompt uses the exact documented system prompt and primed think block', () => {
  const p = buildS1Prompt('hello there');
  assert.ok(p.includes('You are a text normalizer for speech-to-text transcripts.'));
  assert.ok(p.includes('[Styling: semi-formal] [Structure: prose] [Context: general]\nhello there'));
  assert.ok(p.endsWith('<|im_start|>assistant\n<think>\n\n</think>\n\n'), 'must prime empty think block');
});
