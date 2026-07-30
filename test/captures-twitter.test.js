import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { collectTwitterImageFiles } from '../dist/maintenance/captures-zipper.js';

test('collectTwitterImageFiles honors the mtime window and shard layout', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'captures-twitter-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const shard = path.join(dataDir, 'twitter', 'imagestore', 'ab');
  await mkdir(shard, { recursive: true });
  await writeFile(path.join(shard, 'abfresh.jpg'), 'new-bytes');
  await writeFile(path.join(shard, 'abstale.jpg'), 'old-bytes');
  const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(path.join(shard, 'abstale.jpg'), stale, stale);

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const files = await collectTwitterImageFiles(dataDir, cutoff);
  assert.equal(files.length, 1);
  assert.equal(files[0].zipPath, 'twitter/imagestore/ab/abfresh.jpg');
  assert.ok(files[0].size > 0);

  // No imagestore at all → empty, not a throw.
  const bare = await mkdtemp(path.join(tmpdir(), 'captures-twitter-bare-'));
  t.after(() => rm(bare, { recursive: true, force: true }));
  assert.deepEqual(await collectTwitterImageFiles(bare, cutoff), []);
});
