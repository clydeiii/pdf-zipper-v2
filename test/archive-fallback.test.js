import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanForArchive, isSnapshotUrl, classifySnapshotText } from '../dist/converters/archive-fallback.js';
import { classifyFailureMessage } from '../dist/fix/failure.js';
import { shouldAutoTriggerFix } from '../dist/fix/trigger-policy.js';

test('cleanForArchive strips query and fragment', () => {
  assert.equal(
    cleanForArchive('https://www.wsj.com/tech/ai/foo-9b8c?st=1Yyrco#x'),
    'https://www.wsj.com/tech/ai/foo-9b8c'
  );
});

test('isSnapshotUrl recognizes permalinks and timestamped, rejects newest/listing', () => {
  assert.equal(isSnapshotUrl('https://archive.is/so0Cu'), true);
  assert.equal(isSnapshotUrl('https://archive.ph/20260611045713/https://www.wsj.com/x'), true);
  assert.equal(isSnapshotUrl('https://archive.is/newest/https://www.wsj.com/x'), false);
  assert.equal(isSnapshotUrl('https://archive.is/https://www.wsj.com/x'), false);
});

test('classifySnapshotText: real article content is good', () => {
  const text = 'archive.today webpage capture Saved from history ' + 'lorem ipsum '.repeat(300);
  assert.equal(classifySnapshotText(text), 'good');
});

test('classifySnapshotText: archive-chrome-only is broken', () => {
  assert.equal(classifySnapshotText('archive.today webpage capture Saved from history ←prior next→ All snapshots from host www.nytimes.com'), 'broken');
});

test('classifySnapshotText: task-timed-out is broken even if long', () => {
  const text = 'archive.today webpage capture Error: Task timed-out after 15 seconds of inactivity ' + 'x '.repeat(900);
  assert.equal(classifySnapshotText(text), 'broken');
});

test('classifySnapshotText: progress-bar text alone does NOT mark a good capture broken', () => {
  // archive.today embeds "0% 10% 20%" in every snapshot page, including complete ones
  const text = 'archive.today webpage capture Saved from history 0% 10% 20% 30% ' + 'real article body '.repeat(200);
  assert.equal(classifySnapshotText(text), 'good');
});

test('classifySnapshotText: 403 origin is broken', () => {
  const text = '403 Forbidden ' + 'x '.repeat(900);
  assert.equal(classifySnapshotText(text), 'broken');
});

test('classifySnapshotText: Cloudflare wall detected', () => {
  assert.equal(classifySnapshotText('Just a moment... verify you are human'), 'wall');
});

test('paywall-by-content (truncated) now classifies as paywall', () => {
  assert.equal(classifyFailureMessage('truncated: Paywall detected: "unlock this article"'), 'paywall');
  assert.equal(classifyFailureMessage('truncated: Article content is behind a subscription wall.'), 'paywall');
});

test('archive_unavailable classifies and does NOT auto-trigger fix', () => {
  assert.equal(classifyFailureMessage('archive_unavailable: no archive.today snapshot exists (original: paywall: ...)'), 'archive_unavailable');
  assert.equal(shouldAutoTriggerFix('archive_unavailable').allowed, false);
});

test('paywall still skips auto-fix (so archive candidates do not burn cycles)', () => {
  assert.equal(shouldAutoTriggerFix('paywall').allowed, false);
});

test('rate_limited classifies as transient and does NOT auto-trigger fix', () => {
  assert.equal(classifyFailureMessage('rate_limited: Nitter instance rate-limited'), 'rate_limited');
  assert.equal(classifyFailureMessage('Instance has been rate limited.'), 'rate_limited');
  assert.equal(shouldAutoTriggerFix('rate_limited').allowed, false);
});
