import test from 'node:test';
import assert from 'node:assert/strict';
import { replacesFor } from '../dist/utils/save-pdf.js';

test('a rename records the old basename', () => {
  assert.equal(
    replacesFor('/data/media/2026-W35/pdfs/open.substack.com-pub-dwarkesh-p-openai-huggingface.pdf', 'dwarkesh.com-p-openai-huggingface.pdf'),
    'open.substack.com-pub-dwarkesh-p-openai-huggingface.pdf'
  );
});

test('a same-name overwrite needs no hint', () => {
  assert.equal(replacesFor('/data/media/2026-W35/pdfs/example.com-story.pdf', 'example.com-story.pdf'), undefined);
});

test('no predecessor, no hint', () => {
  assert.equal(replacesFor(undefined, 'example.com-story.pdf'), undefined);
});
