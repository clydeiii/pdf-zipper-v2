import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeTags } from '../dist/media/video-enrichment.js';

test('fixes near-miss acronym tags', () => {
  assert.deepEqual(
    canonicalizeTags(['jepe', 'machine-learning'], ['JEPA', 'LeCun']),
    ['jepa', 'machine-learning']
  );
  assert.deepEqual(canonicalizeTags(['jeepa'], ['JEPA']), ['jepa']);
});

test('leaves exact and unrelated tags alone', () => {
  assert.deepEqual(
    canonicalizeTags(['jepa', 'robotics', 'embeddings'], ['JEPA', 'SONAR']),
    ['jepa', 'robotics', 'embeddings']
  );
});

test('requires first-letter match (no aggressive rewrites)', () => {
  assert.deepEqual(canonicalizeTags(['repa'], ['JEPA']), ['repa']);
});

test('no acronym hints is a no-op', () => {
  assert.deepEqual(canonicalizeTags(['jepe'], ['LeCun', 'DeepMind']), ['jepe']);
});
