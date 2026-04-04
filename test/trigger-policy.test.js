import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldAutoTriggerFix,
  shouldAllowManualSubmission,
  getCooldownMsForFailureClass,
} from '../dist/fix/trigger-policy.js';

test('auto trigger blocks hard blockers', () => {
  const paywall = shouldAutoTriggerFix('paywall');
  const captcha = shouldAutoTriggerFix('captcha');
  const auth = shouldAutoTriggerFix('auth_required');

  assert.equal(paywall.allowed, false);
  assert.equal(captcha.allowed, false);
  assert.equal(auth.allowed, false);
});

test('auto trigger allows retryable/ambiguous classes', () => {
  assert.equal(shouldAutoTriggerFix('timeout').allowed, true);
  assert.equal(shouldAutoTriggerFix('navigation_error').allowed, true);
  assert.equal(shouldAutoTriggerFix('unknown').allowed, true);
});

test('manual submission remains allowed', () => {
  assert.equal(shouldAllowManualSubmission('paywall').allowed, true);
  assert.equal(shouldAllowManualSubmission('captcha').allowed, true);
});

test('cooldown map has expected ordering', () => {
  const paywall = getCooldownMsForFailureClass('paywall');
  const timeout = getCooldownMsForFailureClass('timeout');
  const quality = getCooldownMsForFailureClass('quality_false_negative_suspected');

  assert.ok(paywall > timeout);
  assert.ok(timeout > 0);
  assert.ok(quality > 0);
});

