import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeProbe } from '../dist/media/video-provenance.js';

// A downloaded "video" is accepted only if ffprobe can read it, it has a
// video stream, and it has a duration. 21 truncated Karakeep asset fetches
// sat in the library on 2026-09-05 because HTTP 200 + bytes-on-disk was the
// whole test.

test('unreadable output (ffprobe failed) is rejected', () => {
  assert.deepEqual(judgeProbe(null), { ok: false, reason: 'unreadable' });
  assert.deepEqual(judgeProbe({}), { ok: false, reason: 'unreadable' });
});

test('a container with only audio is not a video download', () => {
  assert.deepEqual(judgeProbe({ streams: [{ codec_type: 'audio' }], format: { duration: '12.5' } }), { ok: false, reason: 'no_video_stream' });
});

test('a video stream with no duration (truncated moov) is rejected', () => {
  assert.deepEqual(judgeProbe({ streams: [{ codec_type: 'video' }], format: {} }), { ok: false, reason: 'no_duration' });
  assert.deepEqual(judgeProbe({ streams: [{ codec_type: 'video' }], format: { duration: '0' } }), { ok: false, reason: 'no_duration' });
});

test('a readable video with duration passes and reports its audio bit', () => {
  const silent = judgeProbe({ streams: [{ codec_type: 'video' }], format: { duration: '30.2' } });
  assert.equal(silent.ok, true);
  assert.equal(silent.hasAudio, false);
  const spoken = judgeProbe({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }], format: { duration: 30.2 } });
  assert.equal(spoken.ok, true);
  assert.equal(spoken.hasAudio, true);
  assert.equal(spoken.durationSec, 30.2);
});
