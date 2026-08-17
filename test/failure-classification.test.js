import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailureMessage, isTransientNetworkMessage } from '../dist/fix/failure.js';

test('classifyFailureMessage detects paywall-like failures', () => {
  assert.equal(classifyFailureMessage('paywall: subscribe to continue reading'), 'paywall');
  assert.equal(classifyFailureMessage('unknown: subscriber only content'), 'paywall');
});

test('classifyFailureMessage detects captcha and auth', () => {
  assert.equal(classifyFailureMessage('unknown: captcha required before access'), 'captcha');
  assert.equal(classifyFailureMessage('unknown: login required to view page'), 'auth_required');
});

test('classifyFailureMessage detects timeout and navigation errors', () => {
  assert.equal(classifyFailureMessage('timeout: Navigation failed after retry'), 'timeout');
  assert.equal(classifyFailureMessage('navigation_error: net::ERR_BLOCKED_BY_CLIENT'), 'navigation_error');
});

test('classifyFailureMessage detects quality false-negative suspects', () => {
  assert.equal(
    classifyFailureMessage('quality_failed: page loaded but score under threshold'),
    'quality_false_negative_suspected'
  );
  assert.equal(
    classifyFailureMessage('truncated: PDF has only 200 characters'),
    'quality_false_negative_suspected'
  );
});

test('classifyFailureMessage classifies blur-paywall truncation reason as paywall', () => {
  // pdf-content.ts Check 2 blur-signature wording — "Paywall detected" must
  // win over the "truncated:" prefix so archive fallback treats it as a hard
  // blocker and auto-fix skips it.
  assert.equal(
    classifyFailureMessage(
      'truncated: Blurred body: lede and footer extract text but interior body pages have none (898KB PDF, 1013 chars). Paywall detected (blur-obfuscated subscriber gate).'
    ),
    'paywall'
  );
});

test('isTransientNetworkMessage flags connection-level failures for delayed requeue', () => {
  // Exact shape of the jeffgamet.com false negative: networkidle timed out,
  // the domcontentloaded retry hit a TCP reset, and the 1s/2s/4s BullMQ
  // backoff burned all attempts inside the same outage window.
  assert.equal(
    isTransientNetworkMessage(
      'timeout: Navigation failed after retry: page.goto: net::ERR_CONNECTION_RESET at https://jeffgamet.com/anthropics-claude-watermark-is-akin-to-an-ai-poison-pill/'
    ),
    true
  );
  assert.equal(isTransientNetworkMessage('navigation_error: net::ERR_CONNECTION_REFUSED at https://example.com'), true);
  assert.equal(isTransientNetworkMessage('navigation_error: net::ERR_EMPTY_RESPONSE'), true);
  assert.equal(isTransientNetworkMessage('unknown: request failed: socket hang up'), true);
  assert.equal(isTransientNetworkMessage('unknown: fetch failed: ECONNRESET'), true);
});

test('isTransientNetworkMessage leaves permanent and slow-page failures alone', () => {
  // Dead domains stay dead — a delayed requeue cannot revive them.
  assert.equal(isTransientNetworkMessage('navigation_error: net::ERR_NAME_NOT_RESOLVED at https://gone.example'), false);
  // Plain navigation timeouts (slow pages) already get the in-converter
  // domcontentloaded retry; they are not connection-level outages.
  assert.equal(isTransientNetworkMessage('timeout: Navigation failed after retry: page.goto: Timeout 60000ms exceeded.'), false);
  assert.equal(isTransientNetworkMessage('bot_detected: net::ERR_BLOCKED_BY_CLIENT'), false);
  assert.equal(isTransientNetworkMessage(undefined), false);
});

test('classifyFailureMessage defaults to unknown', () => {
  assert.equal(classifyFailureMessage('some random error text'), 'unknown');
  assert.equal(classifyFailureMessage(undefined), 'unknown');
});
