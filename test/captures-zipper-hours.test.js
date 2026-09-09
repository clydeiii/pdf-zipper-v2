import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunHours } from '../dist/maintenance/captures-zipper.js';

test('default: midnight for the 01:00 ship, 03:00 for the 04:00 redundant ship', () => {
  assert.deepEqual(parseRunHours(undefined, undefined), [0, 3]);
});

test('a lone CAPTURES_ZIP_HOUR keeps the old single-run behavior', () => {
  assert.deepEqual(parseRunHours(undefined, '2'), [2]);
});

test('CAPTURES_ZIP_HOURS parses, dedupes, sorts, and drops junk', () => {
  assert.deepEqual(parseRunHours('3, 0, 3, 25, x', '9'), [0, 3]);
  assert.deepEqual(parseRunHours('', undefined), [0, 3]);
});
