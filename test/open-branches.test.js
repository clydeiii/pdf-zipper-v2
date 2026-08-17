import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenBranchSection } from '../dist/fix/open-branches.js';

const B = (name, subject, files, addedSymbols = []) => ({ name, subject, files, addedSymbols });

test('no open branches adds no section', () => {
  assert.equal(buildOpenBranchSection([]), '');
});

test('lists each branch with its subject and files', () => {
  const out = buildOpenBranchSection([
    B('fix/batch-aaaa1111-claude', 'fix(self-heal): batch aaaa1111', ['src/quality/pdf-content.ts']),
    B('fix/batch-bbbb2222-claude', 'fix(self-heal): batch bbbb2222', ['src/converters/pdf.ts', 'test/pdf.test.js']),
  ]);
  assert.match(out, /fix\/batch-aaaa1111-claude/);
  assert.match(out, /fix\/batch-bbbb2222-claude/);
  assert.match(out, /src\/quality\/pdf-content\.ts/);
  assert.match(out, /src\/converters\/pdf\.ts, test\/pdf\.test\.js/);
});

test('instructs the agent to check for duplicates before writing code', () => {
  const out = buildOpenBranchSection([B('fix/batch-aaaa1111-claude', 's', ['a.ts'])]);
  assert.match(out, /DO NOT re-implement/);
  assert.match(out, /alreadyAddressedBy/);
  // The key reframing: recognising a duplicate is a success, not a failure.
  assert.match(out, /successful.*diagnosis|not a failure/i);
});

test('long file lists are truncated with a count', () => {
  const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
  const out = buildOpenBranchSection([B('fix/batch-cccc3333-claude', 's', files)]);
  assert.match(out, /\(\+4 more\)/);
  assert.ok(!out.includes('src/f9.ts'), 'should not list every file');
});

test('a branch with no diff still renders', () => {
  const out = buildOpenBranchSection([B('fix/batch-dddd4444-claude', '', [])]);
  assert.match(out, /no file changes/);
  assert.match(out, /no subject/);
});

import { extractAddedSymbols } from '../dist/fix/open-branches.js';

test('extracts module-level symbols a branch introduces', () => {
  const diff = [
    '+++ b/src/quality/pdf-content.ts',
    '+const SUBSTACK_PAID_BADGE = /paid/i;',
    '+export function isEmbeddedDocViewerCapture(text) {',
    '+interface Thing { a: string }',
    '+export const AXIOS_SHELL_MARKERS = [];',
  ].join('\n');
  assert.deepEqual(extractAddedSymbols(diff), [
    'SUBSTACK_PAID_BADGE', 'isEmbeddedDocViewerCapture', 'Thing', 'AXIOS_SHELL_MARKERS',
  ]);
});

test('ignores locals inside functions and removed lines', () => {
  // Indented declarations are locals; matching them buried the useful names
  // under every `page`/`cookies`/`obj` in the diff.
  const diff = [
    '+  const page = await ctx.newPage();',
    '+    const obj = JSON.parse(x);',
    '-const REMOVED_THING = 1;',
    ' const CONTEXT_LINE = 2;',
  ].join('\n');
  assert.deepEqual(extractAddedSymbols(diff), []);
});

test('does not repeat a symbol declared twice', () => {
  assert.deepEqual(extractAddedSymbols('+const A = 1;\n+const A = 2;'), ['A']);
});
