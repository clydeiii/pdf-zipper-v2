import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  extensionForImage,
  imageRelativePath,
  sha256Hex,
  storeNitterImage,
} from '../dist/twitter/imagestore.js';
import { openTwitterDb } from '../dist/twitter/db.js';

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

test('imagestore dedup refreshes mtime without rewriting content', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'twitter-imagestore-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const db = openTwitterDb({ dataDir });
  t.after(() => db.close());

  const bytes = new TextEncoder().encode('same image bytes');
  const sha = sha256Hex(bytes);
  const extension = extensionForImage('image/png', '/pic/example.png');
  const relative = imageRelativePath(sha, extension);
  const absolute = path.join(dataDir, ...relative.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  const old = new Date('2020-01-01T00:00:00.000Z');
  await utimes(absolute, old, old);
  const touched = new Date('2026-07-29T12:00:00.000Z');

  const result = await storeNitterImage('/pic/example.png', {
    db,
    dataDir,
    nitterHost: 'https://nitter.invalid',
    sourceUrl: 'https://pbs.twimg.com/example.png',
    now: () => touched,
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }),
  });

  assert.equal(result.file, relative);
  assert.deepEqual(new Uint8Array(await readFile(absolute)), bytes);
  assert.equal((await stat(absolute)).mtimeMs, touched.getTime());
});
