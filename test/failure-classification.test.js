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

test('classifyFailureMessage defaults to unknown', () => {
  assert.equal(classifyFailureMessage('some random error text'), 'unknown');
  assert.equal(classifyFailureMessage(undefined), 'unknown');
});
