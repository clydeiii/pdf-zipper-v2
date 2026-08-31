import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSubstackPubPost,
  substackDedupCandidates,
  stripSubstackShareParams,
  canonicalizeSubstackUrl,
} from '../dist/urls/substack-canonical.js';

test('parses the iOS share-sheet reader form', () => {
  assert.deepEqual(
    parseSubstackPubPost(
      'https://open.substack.com/pub/dwarkesh/p/openai-huggingface?r=9qonx&utm_medium=ios'
    ),
    { pubHost: 'dwarkesh.substack.com', slug: 'openai-huggingface' }
  );
});

test('parses the pub-subdomain form', () => {
  assert.deepEqual(parseSubstackPubPost('https://dwarkesh.substack.com/p/openai-huggingface'), {
    pubHost: 'dwarkesh.substack.com',
    slug: 'openai-huggingface',
  });
});

test('custom domains and non-post paths return null', () => {
  assert.equal(parseSubstackPubPost('https://www.dwarkesh.com/p/openai-huggingface'), null);
  assert.equal(parseSubstackPubPost('https://dwarkesh.substack.com/about'), null);
  assert.equal(parseSubstackPubPost('https://open.substack.com/pub/dwarkesh'), null);
  assert.equal(parseSubstackPubPost('https://www.substack.com/p/whatever'), null);
  assert.equal(parseSubstackPubPost('https://open.substack.com/p/whatever'), null);
  assert.equal(parseSubstackPubPost('https://example.com/article'), null);
  assert.equal(parseSubstackPubPost('not a url'), null);
});

test('candidates cover resolved, static, and raw spellings', async () => {
  const resolver = async () => 'www.example-custom.com';
  const candidates = await substackDedupCandidates(
    'https://open.substack.com/pub/testpub-a/p/some-post?r=9qonx&utm_medium=ios',
    resolver
  );
  assert.ok(candidates.includes('https://example-custom.com/p/some-post'), 'resolved custom domain');
  assert.ok(candidates.includes('https://testpub-a.substack.com/p/some-post'), 'static pub form');
  assert.ok(
    candidates.some((c) => c.includes('open.substack.com/pub/testpub-a/p/some-post')),
    'raw form for pre-fix seen entries'
  );
});

test('both spellings of the same post share the resolved candidate', async () => {
  const resolver = async () => 'www.example-custom2.com';
  const fromIos = await substackDedupCandidates(
    'https://open.substack.com/pub/testpub-b/p/the-post?r=abc',
    resolver
  );
  const fromSubdomain = await substackDedupCandidates(
    'https://testpub-b.substack.com/p/the-post',
    resolver
  );
  // The Chrome custom-domain bookmark's plain normalized key:
  const chromeKey = 'https://example-custom2.com/p/the-post';
  assert.ok(fromIos.includes(chromeKey));
  assert.ok(fromSubdomain.includes(chromeKey));
});

test('resolution failure still yields the static candidate, and retries later', async () => {
  let calls = 0;
  const failing = async () => {
    calls++;
    return null;
  };
  const first = await substackDedupCandidates('https://testpub-c.substack.com/p/x', failing);
  assert.ok(first.includes('https://testpub-c.substack.com/p/x'));
  await substackDedupCandidates('https://testpub-c.substack.com/p/y', failing);
  assert.equal(calls, 2, 'failed resolution is not cached');
});

test('successful resolution is cached per pub', async () => {
  let calls = 0;
  const counting = async () => {
    calls++;
    return 'testpub-d.substack.com'; // no custom domain
  };
  await substackDedupCandidates('https://testpub-d.substack.com/p/one', counting);
  await substackDedupCandidates('https://testpub-d.substack.com/p/two', counting);
  assert.equal(calls, 1, 'second URL from the same pub uses the cache');
});

test('the personal r= share token never survives canonicalization', async () => {
  const resolver = async () => 'www.example-custom3.com';
  // iOS share-sheet spelling: rebuilt from host+slug, token gone
  assert.equal(
    await canonicalizeSubstackUrl(
      'https://open.substack.com/pub/testpub-e/p/the-post?r=9qonx&utm_medium=ios',
      resolver
    ),
    'https://www.example-custom3.com/p/the-post'
  );
  // custom-domain "copy link" spelling: params stripped in place
  assert.equal(
    await canonicalizeSubstackUrl(
      'https://www.dwarkesh.com/p/the-post?r=9qonx&utm_campaign=post&utm_medium=web'
    ),
    'https://www.dwarkesh.com/p/the-post'
  );
});

test('canonicalization keeps the static pub form when resolution fails', async () => {
  const failing = async () => null;
  assert.equal(
    await canonicalizeSubstackUrl('https://testpub-f.substack.com/p/x?r=9qonx', failing),
    'https://testpub-f.substack.com/p/x'
  );
});

test('canonicalization returns null for clean or non-Substack URLs', async () => {
  assert.equal(await canonicalizeSubstackUrl('https://www.dwarkesh.com/p/the-post'), null);
  assert.equal(await canonicalizeSubstackUrl('https://example.com/article?r=keepme'), null);
  assert.equal(
    await canonicalizeSubstackUrl('https://testpub-g.substack.com/p/x', async () => 'testpub-g.substack.com'),
    null
  );
});

test('stripSubstackShareParams removes only share params on post-shaped paths', () => {
  assert.equal(
    stripSubstackShareParams('https://www.dwarkesh.com/p/x?r=9qonx&utm_medium=web&foo=bar'),
    'https://www.dwarkesh.com/p/x?foo=bar'
  );
  assert.equal(stripSubstackShareParams('https://example.com/blog?r=meaningful'), null);
  assert.equal(stripSubstackShareParams('https://www.dwarkesh.com/p/x'), null);
});
