import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePercentField } from '../dist/utils/percent.js';

test('parses percentage Info Dict values', () => {
  assert.equal(parsePercentField('67%'), 67);
  assert.equal(parsePercentField('100%'), 100);
  assert.equal(parsePercentField(' 28 % '), 28);
});

test('0% survives as a number, not as absent', () => {
  // "measured, no AI detected" must stay distinguishable from "never checked".
  const value = parsePercentField('0%');
  assert.equal(value, 0);
  assert.equal(typeof value, 'number');
});

test('absent or malformed values are undefined', () => {
  for (const raw of [undefined, '', 'n/a', 'Fully Human-Written', '110%', '-5%', '50']) {
    assert.equal(parsePercentField(raw), undefined, `${raw} should not parse`);
  }
});

import { aiInvolvementPercent } from '../dist/utils/percent.js';

test('AI involvement counts assisted text, not just fully-AI', () => {
  // Real capture: Pangram called it "Partially AI-assisted text" while the
  // fully-AI figure was 0%. Keying off that alone badged it "AI 0%" and hid it
  // from every threshold filter.
  assert.equal(aiInvolvementPercent({ ai: 0, assisted: 51, human: 49 }), 51);
  assert.equal(aiInvolvementPercent({ ai: 67, assisted: 7, human: 26 }), 74);
  assert.equal(aiInvolvementPercent({ ai: 0, assisted: 0, human: 100 }), 0);
  assert.equal(aiInvolvementPercent({ ai: 100, assisted: 0, human: 0 }), 100);
});

test('AI involvement falls back to summing when human is missing', () => {
  assert.equal(aiInvolvementPercent({ ai: 30, assisted: 20 }), 50);
  assert.equal(aiInvolvementPercent({ ai: 30 }), 30);
  assert.equal(aiInvolvementPercent({}), undefined);
});
