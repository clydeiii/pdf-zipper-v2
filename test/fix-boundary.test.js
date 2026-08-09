import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedFixPath } from '../dist/fix/boundary.js';

test('tests are inside the boundary so a batch can commit them', () => {
  // They were excluded originally, so every batch that wrote tests left them
  // uncommitted in the working tree and broke the next `npm test` on master.
  assert.equal(isAllowedFixPath('test/pdf-content.test.js'), true);
  assert.equal(isAllowedFixPath('test/crash-signature.test.js'), true);
});

test('the pipeline paths a fix needs stay editable', () => {
  for (const p of [
    'src/quality/pdf-content.ts',
    'src/converters/pdf.ts',
    'src/workers/conversion.worker.ts',
    'src/utils/save-pdf.ts',
    'src/fix/prompt-builder.ts',
  ]) {
    assert.equal(isAllowedFixPath(p), true, `${p} should be allowed`);
  }
});

test('the gate that judges the batch is never editable by it', () => {
  assert.equal(isAllowedFixPath('src/workers/fix.worker.ts'), false);
});

test('everything else is outside the boundary and gets reverted', () => {
  for (const p of [
    'package.json',
    'docker-compose.yml',
    'CLAUDE.md',
    'notes-from-karakeep.md',
    'src/index.ts',
    'src/media/patreon.ts',
    'public/app.js',
  ]) {
    assert.equal(isAllowedFixPath(p), false, `${p} should be outside`);
  }
});
