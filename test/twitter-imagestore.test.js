import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { openTwitterDb } from '../dist/twitter/db.js';
import {
  extensionForImage,
  imageRelativePath,
  sha256Hex,
  storeNitterImage,
} from '../dist/twitter/imagestore.js';

test('hashes and paths content-addressed images deterministically', () => {
  const bytes = new TextEncoder().encode('image bytes');
  const hash = sha256Hex(bytes);
  assert.equal(hash, 'de7030234493a8bea844dbe1d8676e68a2c1a4b014c721f0425a22b6df66faec');
  assert.equal(
    imageRelativePath(hash, '.jpg'),
    `twitter/imagestore/de/${hash}.jpg`,
  );
  assert.equal(extensionForImage('image/jpeg; charset=binary', '/pic/no-extension'), '.jpg');
  assert.equal(extensionForImage(null, '/pic/orig/media%2Ffoo.png'), '.png');
  assert.equal(extensionForImage(null, '/pic/no-extension'), '.bin');
});

test('stores a mocked Nitter download once and reuses its image index', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'twitter-image-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const db = openTwitterDb({ dataDir });
  t.after(() => db.close());
  let requests = 0;
  const fetchImpl = async (url) => {
    requests++;
    assert.match(url, /^http:\/\/nitter\.test\/pic\/orig\/media%2Fphoto\.jpg$/);
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  };
  const options = {
    db,
    dataDir,
    nitterHost: 'http://nitter.test',
    sourceUrl: 'https://pbs.twimg.com/media/photo.jpg',
    fetchImpl,
  };
  const first = await storeNitterImage('/pic/orig/media%2Fphoto.jpg', options);
  const second = await storeNitterImage('/pic/orig/media%2Fphoto.jpg', options);
  assert.equal(first.downloaded, true);
  assert.equal(second.downloaded, false);
  assert.equal(requests, 1);
  assert.equal(first.file, second.file);
  assert.deepEqual(
    [...await readFile(path.join(dataDir, ...first.file.split('/')))],
    [1, 2, 3, 4],
  );
});
