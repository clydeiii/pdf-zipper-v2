import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailureMessage } from '../dist/fix/failure.js';

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

test('classifyFailureMessage classifies body-less shell truncation as bot_detected', () => {
  // pdf-content.ts Check 1 shell wording — "bot detection" must win over the
  // "truncated:" prefix so archive fallback treats it as a hard blocker on
  // the 6h cooldown (real case: businessinsider.com serving headline + dek
  // only, 1.7MB PDF / 190 chars).
  assert.equal(
    classifyFailureMessage(
      'truncated: Body-less shell: 1711KB PDF rendered but has only 190 characters of text (minimum: 500). Article body missing — likely silent bot detection.'
    ),
    'bot_detected'
  );
});

test('classifyFailureMessage defaults to unknown', () => {
  assert.equal(classifyFailureMessage('some random error text'), 'unknown');
  assert.equal(classifyFailureMessage(undefined), 'unknown');
});
