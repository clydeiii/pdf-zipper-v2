import test from 'node:test';
import assert from 'node:assert/strict';
import { isDurationCandidate, hashSampleTimes, confirmsDuplicate, hammingDistance } from '../dist/media/video-dedup.js';

test('duration gate tolerates a cross-platform re-upload (tens of ms) but not a different cut', () => {
  assert.equal(isDurationCandidate(757880, 757880), true, 'identical streams');
  assert.equal(isDurationCandidate(757880, 758001), true, 'audio-track drift of a re-upload');
  assert.equal(isDurationCandidate(757880, 758380), true, 'half a second');
  assert.equal(isDurationCandidate(757880, 763401), false, 'a subtitle-stretched CONTAINER duration must not be what we compare — but if it were, 5.5s is out');
  assert.equal(isDurationCandidate(30000, 32000), false);
});

test('three distinct sample points inside the video; short clips collapse to fewer', () => {
  assert.deepEqual(hashSampleTimes(757880), [5, 303.2, 606.3]);
  assert.deepEqual(hashSampleTimes(4000), [2, 1.6, 3.2]);
  const times = hashSampleTimes(3000);
  assert.ok(times.every((t) => t < 3) && new Set(times).size === times.length);
});

test('confirmation needs a majority of measured frames within 12 bits, at least two when two are available', () => {
  assert.equal(confirmsDuplicate([0, 1, 0]), true);
  assert.equal(confirmsDuplicate([0, 30, 2]), true, 'one differing frame (an overlay/caption) does not break a match');
  assert.equal(confirmsDuplicate([0, 30, 31]), false, 'one lucky frame is not a match');
  assert.equal(confirmsDuplicate([null, 3, null]), true, 'a single measurable frame still decides when nothing else can be read');
  assert.equal(confirmsDuplicate([null, null, null]), false);
  assert.equal(confirmsDuplicate([13, 13, 13]), false);
  assert.equal(hammingDistance(0b1011n, 0b0001n), 2);
});
