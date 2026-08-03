import test from 'node:test';
import assert from 'node:assert/strict';
import { isPdfUrl, rewriteToPdfUrl } from '../dist/converters/pdf.js';

// isPdfUrl tests
test('isPdfUrl detects .pdf extension', () => {
  assert.equal(isPdfUrl('https://example.com/paper.pdf'), true);
  assert.equal(isPdfUrl('https://example.com/docs/report.PDF'), true);
});

test('isPdfUrl detects arxiv PDF URLs without extension', () => {
  assert.equal(isPdfUrl('https://arxiv.org/pdf/2506.06299'), true);
  assert.equal(isPdfUrl('https://arxiv.org/pdf/2506.06299v2'), true);
});

test('isPdfUrl rejects non-PDF URLs', () => {
  assert.equal(isPdfUrl('https://example.com/article'), false);
  assert.equal(isPdfUrl('https://example.com/page.html'), false);
  assert.equal(isPdfUrl('https://arxiv.org/search/?query=llm'), false);
});

test('isPdfUrl detects arxiv abstract pages', () => {
  assert.equal(isPdfUrl('https://arxiv.org/abs/2506.12345'), true);
  assert.equal(isPdfUrl('https://arxiv.org/abs/2506.12345v2'), true);
});

test('isPdfUrl handles invalid URLs gracefully', () => {
  assert.equal(isPdfUrl('not-a-url'), false);
  assert.equal(isPdfUrl(''), false);
});

// rewriteToPdfUrl tests
test('rewriteToPdfUrl converts arxiv abstract to PDF URL', () => {
  assert.equal(
    rewriteToPdfUrl('https://arxiv.org/abs/2506.12345'),
    'https://arxiv.org/pdf/2506.12345'
  );
  assert.equal(
    rewriteToPdfUrl('https://arxiv.org/abs/2506.12345v2'),
    'https://arxiv.org/pdf/2506.12345v2'
  );
});

test('rewriteToPdfUrl converts arxiv HTML to PDF URL', () => {
  assert.equal(
    rewriteToPdfUrl('https://arxiv.org/html/2506.12345'),
    'https://arxiv.org/pdf/2506.12345'
  );
});

test('rewriteToPdfUrl passes through direct PDF URLs unchanged', () => {
  const directPdf = 'https://arxiv.org/pdf/2506.12345';
  assert.equal(rewriteToPdfUrl(directPdf), directPdf);

  const otherPdf = 'https://example.com/paper.pdf';
  assert.equal(rewriteToPdfUrl(otherPdf), otherPdf);
});

test('rewriteToPdfUrl passes through non-arxiv URLs unchanged', () => {
  assert.equal(
    rewriteToPdfUrl('https://example.com/article'),
    'https://example.com/article'
  );
});

test('isChatGptShareUrl matches share links only', async () => {
  const { isChatGptShareUrl } = await import('../dist/converters/chatgpt-share.js');
  assert.equal(isChatGptShareUrl('https://chatgpt.com/share/6a5fdc7a-d6f8-83e8-bbea-8deb42cfed56'), true);
  assert.equal(isChatGptShareUrl('https://chatgpt.com/share/6a5fdc7a-d6f8-83e8-bbea-8deb42cfed56/'), true);
  assert.equal(isChatGptShareUrl('https://chatgpt.com/c/some-conversation'), false);
  assert.equal(isChatGptShareUrl('https://chatgpt.com/'), false);
  assert.equal(isChatGptShareUrl('https://example.com/share/abc'), false);
});

// rewriteQwenBlogUrl tests — legacy qwenlm.github.io links must hop straight
// to the qwen.ai post; the site's own redirect drops the slug (job 22810)
test('rewriteQwenBlogUrl maps legacy blog post to qwen.ai id URL', async () => {
  const { rewriteQwenBlogUrl } = await import('../dist/converters/pdf.js');
  assert.equal(
    rewriteQwenBlogUrl('https://qwenlm.github.io/blog/qwen3.8/'),
    'https://qwen.ai/blog?id=qwen3.8'
  );
  assert.equal(
    rewriteQwenBlogUrl('https://qwenlm.github.io/blog/qwen2.5-coder-family'),
    'https://qwen.ai/blog?id=qwen2.5-coder-family'
  );
  assert.equal(
    rewriteQwenBlogUrl('https://qwenlm.github.io/zh/blog/qwen3.8/'),
    'https://qwen.ai/blog?id=qwen3.8'
  );
});

test('rewriteQwenBlogUrl leaves non-post and foreign URLs alone', async () => {
  const { rewriteQwenBlogUrl } = await import('../dist/converters/pdf.js');
  // blog index has no slug to carry over
  assert.equal(
    rewriteQwenBlogUrl('https://qwenlm.github.io/blog/'),
    'https://qwenlm.github.io/blog/'
  );
  // non-blog pages on the same host
  assert.equal(
    rewriteQwenBlogUrl('https://qwenlm.github.io/about/'),
    'https://qwenlm.github.io/about/'
  );
  // other GitHub Pages sites
  assert.equal(
    rewriteQwenBlogUrl('https://karpathy.github.io/blog/some-post/'),
    'https://karpathy.github.io/blog/some-post/'
  );
  assert.equal(rewriteQwenBlogUrl('not-a-url'), 'not-a-url');
});
