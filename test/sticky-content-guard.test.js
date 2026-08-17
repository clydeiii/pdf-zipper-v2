import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The fixed/sticky removal phase and the near-blank reload both live inside
// page.evaluate closures, so they can't be imported and exercised directly.
// These source-invariant checks guard the two regressions that produced the
// businessinsider.com Discourse failure (job 23973): the article body lived in
// a position:sticky scroll-stage wrapper and was deleted wholesale, leaving a
// 190-char PDF that the content check then (rightly) rejected.
const pdfTs = readFileSync(new URL('../src/converters/pdf.ts', import.meta.url), 'utf8');

test('fixed/sticky removal gates on content before deleting (BI Discourse guard)', () => {
  // The guard function must exist…
  assert.match(pdfTs, /isContentBearing/,
    'content-bearing guard missing from the fixed/sticky removal phase');
  // …and be consulted in the fixed/sticky branch before any .remove() —
  // i.e. appear between the position check and the removal call.
  const phase = pdfTs.slice(
    pdfTs.indexOf("position === 'fixed' || position === 'sticky'"),
  );
  const guardIdx = phase.indexOf('isContentBearing(');
  const removeIdx = phase.indexOf('.remove()');
  assert.ok(guardIdx >= 0, 'guard is never called in the removal phase');
  assert.ok(removeIdx > guardIdx,
    'content guard must run before the sticky element is removed');
  // A content-bearing wrapper is neutralized into normal flow, not deleted.
  const guardBranch = phase.slice(guardIdx, removeIdx);
  assert.match(guardBranch, /setProperty\('position',\s*'static'/,
    'content-bearing sticky wrapper must be dropped into normal flow');
});

test('content gate thresholds match the un-pin phase conventions', () => {
  // Two long paragraphs OR ≥500 chars holding ≥30% of the page text. Loosening
  // these lets navbars survive in-flow (cosmetic); tightening them re-deletes
  // scrollytelling article bodies (catastrophic and invisible until the
  // quality gate rejects the capture).
  assert.match(pdfTs, /longParagraphs >= 2/);
  assert.match(pdfTs, /textLen >= 500 && pageTextLen > 0 && textLen >= pageTextLen \* 0\.3/);
});

test('near-blank reload floor covers everything the quality gate will reject', () => {
  // A DOM under 500 chars is guaranteed to fail the content check's minimum,
  // so it must get its one reload. Twitter keeps the old 200 floor to protect
  // the Nitter session budget.
  assert.match(pdfTs, /nearBlankFloor = isTwitterUrl\(url\) \? 200 : 500/);
  assert.match(pdfTs, /renderedTextLen < nearBlankFloor/);
});
