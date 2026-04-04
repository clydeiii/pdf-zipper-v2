import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPathWithinRoot, resolveWithinRoot } from '../dist/utils/paths.js';

test('resolveWithinRoot returns absolute path for valid relative input', () => {
  const root = '/tmp/pdfzipper-data';
  const resolved = resolveWithinRoot(root, 'media/2026-W07/pdfs/doc.pdf');
  assert.equal(resolved, path.resolve(root, 'media/2026-W07/pdfs/doc.pdf'));
});

test('resolveWithinRoot rejects path traversal', () => {
  const root = '/tmp/pdfzipper-data';
  const resolved = resolveWithinRoot(root, '../../etc/passwd');
  assert.equal(resolved, null);
});

test('isPathWithinRoot handles nested valid and invalid paths', () => {
  const root = '/tmp/pdfzipper-data';
  const valid = '/tmp/pdfzipper-data/media/file.pdf';
  const invalid = '/tmp/pdfzipper-data-evil/file.pdf';

  assert.equal(isPathWithinRoot(root, valid), true);
  assert.equal(isPathWithinRoot(root, invalid), false);
});

