import test from 'node:test';
import assert from 'node:assert/strict';
import { probeOriginStatus, probeUrlFor } from '../dist/utils/dead-url.js';

const fetcherReturning = (status) => async () => status;

test('404 and 410 at the origin mean dead', async () => {
  assert.equal(await probeOriginStatus('https://example.com/gone', fetcherReturning(404)), 'dead');
  assert.equal(await probeOriginStatus('https://example.com/gone', fetcherReturning(410)), 'dead');
});

test('a served page is alive', async () => {
  assert.equal(await probeOriginStatus('https://example.com/here', fetcherReturning(200)), 'alive');
});

test('bot walls, auth walls, rate limits and outages are unknown — never pruned', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    assert.equal(await probeOriginStatus('https://example.com/x', fetcherReturning(status)), 'unknown', `status ${status}`);
  }
  assert.equal(await probeOriginStatus('https://example.com/x', async () => { throw new Error('ECONNRESET'); }), 'unknown');
});

test('tweets are probed through Nitter, where a deleted status is a real 404', async () => {
  const probed = probeUrlFor('https://x.com/nkreu113r/status/2093432075340681396?s=12');
  assert.match(probed, /\/nkreu113r\/status\/2093432075340681396$/);
  assert.ok(!probed.includes('x.com'), `should not probe x.com directly: ${probed}`);
  let seen;
  const status = await probeOriginStatus('https://x.com/nkreu113r/status/2093432075340681396', async (u) => { seen = u; return 404; });
  assert.equal(status, 'dead');
  assert.equal(seen, probed);
});

test('non-tweet URLs are probed as-is', () => {
  assert.equal(probeUrlFor('https://www.anthropic.com/news/missing'), 'https://www.anthropic.com/news/missing');
});
