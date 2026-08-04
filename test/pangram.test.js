import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubstackPostUrl, pangramInfoDictFields } from '../dist/substack/pangram.js';

const AT = new Date('2026-08-03T12:00:00Z');

// --- URL parsing ---

test('parses canonical substack.com post URLs', () => {
  assert.deepEqual(
    parseSubstackPostUrl('https://astralcodexten.substack.com/p/does-forecasting-have-room'),
    { apiBase: 'https://astralcodexten.substack.com', slug: 'does-forecasting-have-room' },
  );
});

test('parses Substack-hosted custom domains (they serve the same API)', () => {
  assert.deepEqual(
    parseSubstackPostUrl('https://newsletter.semianalysis.com/p/lego-datacenters'),
    { apiBase: 'https://newsletter.semianalysis.com', slug: 'lego-datacenters' },
  );
});

test('resolves app/reader share links to the publication', () => {
  // open.substack.com has no post API of its own; the pub is in the path.
  assert.deepEqual(
    parseSubstackPostUrl('https://open.substack.com/pub/astralcodexten/p/does-forecasting?r=9qonx&utm_medium=ios'),
    { apiBase: 'https://astralcodexten.substack.com', slug: 'does-forecasting' },
  );
});

test('tolerates trailing slashes', () => {
  assert.deepEqual(
    parseSubstackPostUrl('https://thezvi.substack.com/p/astra-solves/'),
    { apiBase: 'https://thezvi.substack.com', slug: 'astra-solves' },
  );
});

test('returns null for anything that is not a post URL', () => {
  for (const url of [
    'https://www.anthropic.com/news/claude',
    'https://qwen.ai/blog?id=qwen3.8',
    'https://astralcodexten.substack.com/',
    'https://astralcodexten.substack.com/archive',
    'https://open.substack.com/pub/astralcodexten',
    'https://x.com/someone/status/123',
    'not a url',
  ]) {
    assert.equal(parseSubstackPostUrl(url), null, `${url} should not parse`);
  }
});

// --- Info Dict mapping ---

test('a real verdict becomes percentages plus the disclosure', () => {
  const fields = pangramInfoDictFields({
    type: 'success',
    header: 'Partially AI-assisted text',
    details: 'Analysis by Pangram suggests that this text was written with some AI assistance.',
    fractionAi: 0.67,
    fractionAiAssisted: 0.07,
    fractionHuman: 0.26,
    disclosure: 'Sacred Cow BBQ is a collaboration between me and AI research assistants.',
  }, AT);

  assert.equal(fields.AIDetection, 'Partially AI-assisted text');
  assert.equal(fields.AIDetectionStatus, 'success');
  assert.equal(fields.AIDetectionAI, '67%');
  assert.equal(fields.AIDetectionAIAssisted, '7%');
  assert.equal(fields.AIDetectionHuman, '26%');
  assert.equal(fields.AIDetectionSource, 'Pangram via Substack');
  assert.equal(fields.AIDetectionCheckedAt, '2026-08-03T12:00:00.000Z');
  assert.match(fields.AIDisclosure, /Sacred Cow BBQ/);
});

test('a fully-human verdict still records the zero explicitly', () => {
  // 0% must be written, not dropped as falsy — "AI: 0%" and "no result" are
  // very different claims to the KB consumer.
  const fields = pangramInfoDictFields({
    type: 'success', header: 'Fully Human-Written',
    fractionAi: 0, fractionAiAssisted: 0, fractionHuman: 1,
  }, AT);
  assert.equal(fields.AIDetectionAI, '0%');
  assert.equal(fields.AIDetectionHuman, '100%');
});

test('unscannable posts record why, without inventing percentages', () => {
  for (const [type, header] of [
    ['error', 'Subscription required'],
    ['error', 'Not eligible for AI detection'],
    ['disabled', 'AI detection unavailable'],
  ]) {
    const fields = pangramInfoDictFields({ type, header }, AT);
    assert.equal(fields.AIDetection, header);
    assert.equal(fields.AIDetectionStatus, type);
    assert.equal(fields.AIDetectionAI, undefined);
    assert.equal(fields.AIDetectionHuman, undefined);
  }
});

test('falls back to the raw status when the API sends no header', () => {
  assert.equal(pangramInfoDictFields({ type: 'pending' }, AT).AIDetection, 'pending');
});
