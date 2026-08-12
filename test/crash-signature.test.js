import test from 'node:test';
import assert from 'node:assert/strict';
import { isRendererCrashMessage, countCrashRequeues } from '../dist/utils/crash-signature.js';

test('isRendererCrashMessage matches Playwright crash errors', () => {
  assert.equal(isRendererCrashMessage('page.emulateMedia: Target crashed '), true);
  assert.equal(isRendererCrashMessage('page.screenshot: Page crashed'), true);
  assert.equal(isRendererCrashMessage('Target crashed'), true);
});

test('isRendererCrashMessage ignores non-crash failures', () => {
  assert.equal(isRendererCrashMessage('timeout: Navigation failed after retry'), false);
  assert.equal(isRendererCrashMessage('rate_limited: Nitter returned 429'), false);
  assert.equal(isRendererCrashMessage('truncated: PDF has only 200 characters'), false);
  // "closed" is graceful shutdown mid-job, not a crash — retries handle it.
  assert.equal(isRendererCrashMessage('Target page, context or browser has been closed'), false);
  assert.equal(isRendererCrashMessage(''), false);
  assert.equal(isRendererCrashMessage(undefined), false);
});

test('countCrashRequeues reads the trailing jobId suffix', () => {
  assert.equal(countCrashRequeues('https_epoch_ai_benchmarks'), 0);
  assert.equal(countCrashRequeues('https_epoch_ai_benchmarks_cr1'), 1);
  assert.equal(countCrashRequeues('https_epoch_ai_benchmarks_cr1_cr2'), 2);
  // A rate-limit requeue of a crash requeue: trailing suffix governs.
  assert.equal(countCrashRequeues('job_cr1_rl1'), 0);
  assert.equal(countCrashRequeues(undefined), 0);
});
