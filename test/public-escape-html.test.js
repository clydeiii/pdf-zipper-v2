import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadEscapeHtml(file) {
  const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
  const match = source.match(/function escapeHtml\(text\) \{[\s\S]*?\n\}/);
  assert.ok(match, `escapeHtml exists in ${file}`);
  return vm.runInNewContext(`(${match[0]})`);
}

for (const file of ['twitter.js', 'app.js']) {
  test(`${file} escapeHtml escapes text and both quote characters`, async () => {
    const escapeHtml = await loadEscapeHtml(file);
    assert.equal(
      escapeHtml(`&<>"'`),
      '&amp;&lt;&gt;&quot;&#039;',
    );
    assert.equal(
      escapeHtml(`" onload="alert(1)`),
      '&quot; onload=&quot;alert(1)',
    );
  });
}
