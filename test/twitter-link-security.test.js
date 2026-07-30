import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIpAddress } from '../dist/twitter/link-match.js';

test('short-link SSRF guard rejects private, loopback, link-local, and unique-local IPs', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ]) {
    assert.equal(isPrivateIpAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIpAddress(address), false, address);
  }
  assert.equal(isPrivateIpAddress('not-an-ip'), true);
});
