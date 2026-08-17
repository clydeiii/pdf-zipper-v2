import test from 'node:test';
import assert from 'node:assert/strict';
import { isConsentAcceptLabel } from '../dist/converters/pdf.js';

test('does not click settings buttons — "cookie" contains "ok"', () => {
  // The bug: text.includes('ok') matched "Cookie Settings", so on any CMP with
  // a settings button we opened the preferences modal right before printing.
  for (const label of [
    'Cookie Settings', 'Manage Cookies', 'Cookie Preferences',
    'Customise choices', 'Customize Settings', 'More info',
    'Reject all', 'Decline', 'Necessary only',
  ]) {
    assert.equal(isConsentAcceptLabel(label), false, `${label} must not be clicked`);
  }
});

test('still clicks genuine accept buttons', () => {
  for (const label of [
    'Accept', 'Accept all', 'Accept All Cookies', 'I agree', 'Agree',
    'OK', 'Okay', 'Got it', 'Dismiss', 'Allow all', 'I understand',
  ]) {
    assert.equal(isConsentAcceptLabel(label), true, `${label} should be clicked`);
  }
});

test('an accept word inside a longer reject phrase does not win', () => {
  // "Reject all cookies" has no accept word; "Accept only necessary" does, but
  // the exclusion must take precedence.
  assert.equal(isConsentAcceptLabel('Accept only necessary cookies'), false);
  assert.equal(isConsentAcceptLabel('Manage and accept'), false);
});

test('empty and junk labels are never clicked', () => {
  for (const label of ['', '   ', 'x', 'Subscribe']) {
    assert.equal(isConsentAcceptLabel(label), false);
  }
});
