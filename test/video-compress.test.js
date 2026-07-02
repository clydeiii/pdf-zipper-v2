import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCompressVideo } from '../dist/media/video-compress.js';

const OPTS = { enabled: true, kbpsPerMegapixel: 2000, maxHeight: 720 };

// Real files from data/media/2026-W26 drove these cases.

test('X 1044p clip (the motivating 55MB Palantir grab) downscales', () => {
  const d = shouldCompressVideo(
    { sizeBytes: 58242715, durationSec: 169.5, width: 1864, height: 1044 },
    OPTS
  );
  assert.equal(d.compress, true);
  assert.equal(d.reason, 'oversize');
  // Short side 1044 → 720; width scales proportionally, even-rounded
  assert.equal(d.targetHeight, 720);
  assert.equal(d.targetWidth, 1286);
});

test('4K X clip downscales (2.7GB swyx case)', () => {
  const d = shouldCompressVideo(
    { sizeBytes: 2702123128, durationSec: 2198.8, width: 3840, height: 2160 },
    OPTS
  );
  assert.equal(d.compress, true);
  assert.equal(d.reason, 'oversize');
  assert.equal(d.targetWidth, 1280);
  assert.equal(d.targetHeight, 720);
});

test('square 2160x2160 X clip caps its short side', () => {
  const d = shouldCompressVideo(
    { sizeBytes: 42580922, durationSec: 24.2, width: 2160, height: 2160 },
    OPTS
  );
  assert.equal(d.compress, true);
  assert.deepEqual([d.targetWidth, d.targetHeight], [720, 720]);
});

test('portrait 720x1280 phone video is NOT downscaled (short side = 720)', () => {
  // peterwildeford clip: 992 kbps, below the 1200 floor → untouched
  const d = shouldCompressVideo(
    { sizeBytes: 7457740, durationSec: 60.1, width: 720, height: 1280 },
    OPTS
  );
  assert.equal(d.compress, false);
  assert.equal(d.reason, 'bitrate_ok');
});

test('fat 720p clip triggers on bitrate alone', () => {
  // ~2750 kbps at 720p vs ~1843 allowed
  const d = shouldCompressVideo(
    { sizeBytes: 55 * 1024 * 1024, durationSec: 160, width: 1280, height: 720 },
    OPTS
  );
  assert.equal(d.compress, true);
  assert.equal(d.reason, 'bitrate_high');
});

test('Karakeep YouTube 360p grabs are all skipped', () => {
  // Highest-bitrate observed YouTube grab: lennys-podcast, 496 kbps @ 360p
  const d = shouldCompressVideo(
    { sizeBytes: 367372731, durationSec: 5925, width: 640, height: 360 },
    OPTS
  );
  assert.equal(d.compress, false);
  assert.equal(d.reason, 'bitrate_ok');
});

test('low-res video is protected by the absolute kbps floor', () => {
  // 480p would allow only ~829 kbps by the per-MP rule, but the 1200 kbps
  // floor keeps a 1.1 Mbps file untouched.
  const d = shouldCompressVideo(
    { sizeBytes: 8.25 * 1024 * 1024, durationSec: 60, width: 854, height: 480 },
    OPTS
  );
  assert.equal(d.compress, false);
});

test('missing probe data fails open (no compression)', () => {
  assert.equal(
    shouldCompressVideo({ sizeBytes: 1e8, durationSec: null, width: 1280, height: 720 }, OPTS).compress,
    false
  );
  assert.equal(
    shouldCompressVideo({ sizeBytes: 1e8, durationSec: 100, width: null, height: null }, OPTS).compress,
    false
  );
});

test('disabled flag skips everything', () => {
  const d = shouldCompressVideo(
    { sizeBytes: 55 * 1024 * 1024, durationSec: 160, width: 1864, height: 1044 },
    { ...OPTS, enabled: false }
  );
  assert.equal(d.compress, false);
  assert.equal(d.reason, 'disabled');
});
