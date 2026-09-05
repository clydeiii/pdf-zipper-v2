import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffAudioContainer } from '../dist/podcasts/transcriber.js';

// A 200 with a challenge page must not reach the transcriber; mislabeled real
// audio must not be rejected on its MIME type alone (the bytes decide).

test('recognises common audio containers', () => {
  assert.equal(sniffAudioContainer(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1')), 'audio');
  assert.equal(sniffAudioContainer(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(8)])), 'audio');
  assert.equal(sniffAudioContainer(Buffer.from('OggS\x00\x02')), 'audio');
  assert.equal(sniffAudioContainer(Buffer.from([0xff, 0xfb, 0x90, 0x64])), 'audio'); // MPEG frame sync
  assert.equal(sniffAudioContainer(Buffer.from('RIFF\x24\x08\x00\x00WAVE')), 'audio');
});

test('flags HTML / JSON bodies as text', () => {
  assert.equal(sniffAudioContainer(Buffer.from('<!DOCTYPE html><html><head><title>Just a moment...</title>')), 'text');
  assert.equal(sniffAudioContainer(Buffer.from('  <html lang="en">')), 'text');
  assert.equal(sniffAudioContainer(Buffer.from('{"error":"episode not found"}')), 'text');
});

test('unknown bytes are left to ffmpeg', () => {
  assert.equal(sniffAudioContainer(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])), 'unknown');
  assert.equal(sniffAudioContainer(Buffer.alloc(2)), 'unknown');
});
