import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeFailuresByUrl } from '../dist/utils/dedupe-failures.js';

const F = (url, failedAt, extra = {}) => ({ url, failedAt, failureReason: 'x', jobId: 'j', ...extra });

test('one row per URL, newest failure wins', () => {
  const out = dedupeFailuresByUrl([
    F('https://a.com/x', '2026-08-18T01:00:00Z', { failureReason: 'old error' }),
    F('https://a.com/x', '2026-08-18T05:00:00Z', { failureReason: 'new error' }),
    F('https://b.com/y', '2026-08-18T03:00:00Z'),
  ]);
  assert.equal(out.length, 2);
  const a = out.find((f) => f.url === 'https://a.com/x');
  assert.equal(a.failureReason, 'new error');
  assert.equal(a.failureCount, 2);
});

test('count survives regardless of input order', () => {
  const out = dedupeFailuresByUrl([
    F('https://a.com/x', '2026-08-18T05:00:00Z', { failureReason: 'newest' }),
    F('https://a.com/x', '2026-08-18T01:00:00Z', { failureReason: 'older' }),
    F('https://a.com/x', '2026-08-18T03:00:00Z', { failureReason: 'middle' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].failureReason, 'newest');
  assert.equal(out[0].failureCount, 3);
});

test('result is sorted newest first', () => {
  const out = dedupeFailuresByUrl([
    F('https://old.com/', '2026-08-17T00:00:00Z'),
    F('https://new.com/', '2026-08-18T12:00:00Z'),
    F('https://mid.com/', '2026-08-18T06:00:00Z'),
  ]);
  assert.deepEqual(out.map((f) => f.url), ['https://new.com/', 'https://mid.com/', 'https://old.com/']);
});

test('unique failures pass through with count 1', () => {
  const out = dedupeFailuresByUrl([F('https://a.com/', '2026-08-18T01:00:00Z')]);
  assert.equal(out[0].failureCount, 1);
});

test('empty input yields empty output', () => {
  assert.deepEqual(dedupeFailuresByUrl([]), []);
});

test('extra fields of the newest entry are preserved', () => {
  const out = dedupeFailuresByUrl([
    F('https://a.com/', '2026-08-18T01:00:00Z', { jobId: '100' }),
    F('https://a.com/', '2026-08-18T02:00:00Z', { jobId: '200', isBotDetected: true }),
  ]);
  assert.equal(out[0].jobId, '200');
  assert.equal(out[0].isBotDetected, true);
});
