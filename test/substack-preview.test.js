import test from 'node:test';
import assert from 'node:assert/strict';
import { substackPreviewShortfall, countWords } from '../dist/quality/substack-preview.js';

const words = n => 'word '.repeat(n);

test('paid audiences: a preview well under the true wordcount is rejected; 90%+ passes (captions/embeds drop legitimately)', () => {
  assert.match(substackPreviewShortfall(words(270), 'only_paid', 1346), /extracted 270 of 1346 words — paid-preview only/);
  assert.equal(substackPreviewShortfall(words(1220), 'only_paid', 1346), null);
  assert.match(substackPreviewShortfall(words(114), 'founding', 468), /founding post/);
});

test('free posts are held only to a gross-shortfall bar (sign-in gate preview) — 60% extraction is fine', () => {
  assert.match(substackPreviewShortfall(words(120), 'everyone', 1314), /preview only \(free post rendered without the body\)/);
  assert.equal(substackPreviewShortfall(words(800), 'everyone', 1314), null);
  assert.equal(substackPreviewShortfall(words(2534), 'everyone', 2454), null);
});

test('unusable facts are never a verdict', () => {
  assert.equal(substackPreviewShortfall(words(5), undefined, 1000), null);
  assert.equal(substackPreviewShortfall(words(5), 'only_paid', undefined), null);
  assert.equal(substackPreviewShortfall(words(5), 'only_paid', 0), null);
  assert.equal(substackPreviewShortfall(words(5), 'only_paid', Number.NaN), null);
  assert.equal(countWords('  a\n b\tc  '), 3);
});

test('CJK posts are counted like Substack does, so a complete Chinese free post passes', async () => {
  const { countWords, substackPreviewShortfall } = await import('../dist/quality/substack-preview.js');
  // ~1,600 CJK characters with a few Latin tokens ≈ Substack's 1,000 words
  const cjk = '模型测试的一点微小经验，团队在评测中发现了很多有趣的现象。'.repeat(60);
  const text = cjk + ' Manus team notes on evals.';
  assert.ok(countWords(text) >= 1000, `CJK-aware count ${countWords(text)} should approach the declared wordcount`);
  assert.equal(substackPreviewShortfall(text, 'everyone', 1000), null, 'complete CJK post is not a preview');
  // A genuine preview (first ~20%) still fails
  assert.match(substackPreviewShortfall(cjk.slice(0, Math.floor(cjk.length * 0.2)), 'everyone', 1000) ?? '', /preview only/);
});
