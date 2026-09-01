import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDeclarationEligible,
  extractDeclaredCanonical,
  acceptDeclaredCanonical,
  declaredCanonicalCandidates,
} from '../dist/urls/canonical-declaration.js';

test('hosts with dedicated handling are ineligible', () => {
  assert.equal(isDeclarationEligible('https://www.youtube.com/watch?v=abc12345'), false);
  assert.equal(isDeclarationEligible('https://x.com/user/status/123?s=20'), false);
  assert.equal(isDeclarationEligible('https://open.substack.com/pub/foo/p/bar'), false);
  assert.equal(isDeclarationEligible('https://podcasts.apple.com/us/podcast/x/id123'), false);
  assert.equal(isDeclarationEligible('https://arxiv.org/abs/2401.00001'), false);
  assert.equal(isDeclarationEligible('https://example.com/paper.pdf'), false);
  assert.equal(isDeclarationEligible('https://arstechnica.com/security/2026/08/some-story/'), true);
});

test('extracts rel=canonical in either attribute order, resolving relative hrefs', () => {
  assert.equal(
    extractDeclaredCanonical(
      '<html><head><link rel="canonical" href="https://site.com/clean-story"></head>',
      'https://site.com/story?utm=x'
    ),
    'https://site.com/clean-story'
  );
  assert.equal(
    extractDeclaredCanonical(
      '<link href="/clean-story" rel="canonical">',
      'https://site.com/story?utm=x'
    ),
    'https://site.com/clean-story'
  );
});

test('falls back to og:url when no canonical link exists', () => {
  assert.equal(
    extractDeclaredCanonical(
      '<meta property="og:url" content="https://site.com/og-story">',
      'https://site.com/x'
    ),
    'https://site.com/og-story'
  );
  assert.equal(extractDeclaredCanonical('<html><head></head></html>', 'https://site.com/x'), null);
});

test('homepage and section mis-declarations are rejected', () => {
  const article = 'https://site.com/2026/08/big-important-story?share=abc123';
  assert.equal(acceptDeclaredCanonical(article, 'https://site.com/'), false);
  assert.equal(acceptDeclaredCanonical(article, 'https://site.com/section/news'), false);
  assert.equal(acceptDeclaredCanonical(article, 'https://site.com/big-important-story'), true);
});

test('query-string identity (qwen.ai-style) is honored', () => {
  const post = 'https://qwen.ai/blog?id=qwen3.8-flash&share=zz';
  assert.equal(acceptDeclaredCanonical(post, 'https://qwen.ai/blog/qwen3.8-flash'), true);
  assert.equal(acceptDeclaredCanonical(post, 'https://qwen.ai/blog'), false);
});

test('two dirty spellings meet at the declared canonical key', async () => {
  const html = '<link rel="canonical" href="https://site-a.example/story-slug-here">';
  const fetcher = async (url) => ({ finalUrl: url, html });
  const a = await declaredCanonicalCandidates('https://site-a.example/story-slug-here?share_id=xyz1', fetcher);
  const b = await declaredCanonicalCandidates('https://site-a.example/story-slug-here?share_id=abc2', fetcher);
  assert.ok(a.includes('https://site-a.example/story-slug-here'));
  assert.ok(b.includes('https://site-a.example/story-slug-here'));
});

test('failed fetch yields no candidates and does not throw', async () => {
  const result = await declaredCanonicalCandidates('https://site-b.example/some-story', async () => null);
  assert.equal(result, null);
});

test('post-redirect URL becomes a candidate when it keeps the identity token', async () => {
  const fetcher = async () => ({
    finalUrl: 'https://real-site.example/final-story-slug',
    html: '<html></html>',
  });
  const result = await declaredCanonicalCandidates('https://old-site.example/final-story-slug?v=1', fetcher);
  assert.ok(result.includes('https://real-site.example/final-story-slug'));
});

test('per-URL result is cached (one fetch per bookmark across seen/mark/source)', async () => {
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    return { finalUrl: url, html: '<link rel="canonical" href="https://site-c.example/cached-story">' };
  };
  await declaredCanonicalCandidates('https://site-c.example/cached-story?s1=aaaa', fetcher);
  await declaredCanonicalCandidates('https://site-c.example/cached-story?s1=aaaa', fetcher);
  assert.equal(calls, 1);
});
