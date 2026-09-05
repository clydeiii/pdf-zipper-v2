import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { backfillBarePdfs } from '../dist/metadata/backfill.js';
import { reembedEnrichmentInPlace } from '../dist/utils/save-pdf.js';
import { setInfoDictFields, readInfoDictField } from '../dist/utils/pdf-info-dict.js';

// The repair sweep maintains its pending set from these per-file outcomes;
// a wrong outcome either leaks an entry forever or drops a repairable file.

async function writePdf(dir, name, fields) {
  const doc = await PDFDocument.create();
  doc.addPage();
  setInfoDictFields(doc, fields);
  const file = path.join(dir, name);
  await writeFile(file, Buffer.from(await doc.save()));
  return file;
}

test('explicit file list: ok / transcript / gone / no_text outcomes are terminal and reported by absolute path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'backfill-'));
  const ok = await writePdf(dir, 'ok.pdf', { DocType: 'blog', EnrichedAt: '2026-09-04T00:00:00Z', Summary: 'fine', Subject: 'https://a.example/x' });
  const transcript = await writePdf(dir, 't.transcript.pdf', { DocType: 'transcript' });
  // Bare, but a one-page empty PDF has no extractable text → no_text.
  const bare = await writePdf(dir, 'bare.pdf', { DocType: 'blog', Subject: 'https://a.example/bare' });
  const gone = path.join(dir, 'missing.pdf');

  const result = await backfillBarePdfs({ files: [ok, transcript, bare, gone], includeEmptySummary: true, dryRun: true, onProgress: () => {} });
  const byFile = Object.fromEntries(result.outcomes.map((o) => [o.file, o.outcome]));
  assert.equal(byFile[ok], 'ok');
  assert.equal(byFile[transcript], 'transcript');
  assert.equal(byFile[gone], 'gone');
  assert.equal(byFile[bare], 'no_text');
  assert.equal(result.bare, 1);
  assert.equal(result.skippedNoText, 1);
  assert.equal(result.failed, 0);
});

test('empty-summary files are only candidates when includeEmptySummary is set', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'backfill-'));
  const empty = await writePdf(dir, 'empty.pdf', { DocType: 'blog', EnrichedAt: '2026-09-04T00:00:00Z', Summary: '', Subject: 'https://a.example/e' });
  const without = await backfillBarePdfs({ files: [empty], dryRun: true, onProgress: () => {} });
  assert.equal(without.outcomes[0].outcome, 'ok', 'legacy behaviour: EnrichedAt alone counts as enriched');
  const withEmpty = await backfillBarePdfs({ files: [empty], includeEmptySummary: true, dryRun: true, onProgress: () => {} });
  assert.equal(withEmpty.bare, 1);
});

test('reembedEnrichmentInPlace refuses to write when the file changed under it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reembed-'));
  const file = await writePdf(dir, 'a.pdf', { DocType: 'blog', Subject: 'https://a.example/a' });
  const metadata = { title: 'T', author: null, publication: 'A', publishDate: null, language: 'en', summary: 'S', tags: ['x'], translation: null };
  // Pretend we observed an older mtime than the file now has (a rerun rewrote it).
  const past = Date.now() / 1000 - 3600;
  await utimes(file, past, past);
  const ok = await reembedEnrichmentInPlace(file, metadata, { expectedMtimeMs: past * 1000 - 5000 });
  assert.equal(ok, false);
  const doc = await PDFDocument.load(await readFile(file));
  assert.equal(readInfoDictField(doc, 'Summary'), undefined, 'file untouched');

  const ok2 = await reembedEnrichmentInPlace(file, metadata, { expectedMtimeMs: past * 1000 });
  assert.equal(ok2, true);
  const doc2 = await PDFDocument.load(await readFile(file));
  assert.equal(readInfoDictField(doc2, 'Summary'), 'S');
  assert.ok(readInfoDictField(doc2, 'EnrichedAt'), 'validated enrichment stamps EnrichedAt');
  assert.equal(readInfoDictField(doc2, 'EnrichmentStatus'), 'ok');
});

test('an unusable enrichment never stamps EnrichedAt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reembed-'));
  const file = await writePdf(dir, 'b.pdf', { DocType: 'blog', Subject: 'https://a.example/b' });
  const metadata = { title: 'T', author: null, publication: 'A', publishDate: null, language: 'en', summary: '', tags: [], translation: null };
  assert.equal(await reembedEnrichmentInPlace(file, metadata), true);
  const doc = await PDFDocument.load(await readFile(file));
  assert.equal(readInfoDictField(doc, 'EnrichedAt'), undefined);
  assert.equal(readInfoDictField(doc, 'EnrichmentStatus'), 'unusable_reply');
});

test('repair preserves an authoritative PublishDate and Author already in the file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reembed-'));
  const file = await writePdf(dir, 'tweet.pdf', { DocType: 'blog', Subject: 'https://x.com/a/status/1', PublishDate: '2026-09-03T18:30:00.000Z' });
  const metadata = { title: 'T', author: 'Guess Name', publication: 'X', publishDate: '2026-09-01', language: 'en', summary: 'S', tags: ['x'], translation: null };
  assert.equal(await reembedEnrichmentInPlace(file, metadata), true);
  const doc = await PDFDocument.load(await readFile(file));
  assert.equal(readInfoDictField(doc, 'PublishDate'), '2026-09-03T18:30:00.000Z', 'DOM timestamp survives repair');
  assert.equal(doc.getAuthor(), 'Guess Name', 'no prior author, so the enrichment author is used');
  assert.equal(readInfoDictField(doc, 'Summary'), 'S');
});

test('limit bounds attempts, not successes, in dry-run', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'backfill-'));
  const files = [];
  for (let i = 0; i < 4; i++) {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    // Enough text to pass the 100-char floor.
    page.drawText('Article body text that is long enough to be a real candidate for enrichment. '.repeat(3), { x: 20, y: 700, size: 8 });
    setInfoDictFields(doc, { DocType: 'blog', Subject: `https://a.example/${i}` });
    const f = path.join(dir, `f${i}.pdf`);
    await writeFile(f, Buffer.from(await doc.save()));
    files.push(f);
  }
  const r = await backfillBarePdfs({ files, dryRun: true, limit: 2, onProgress: () => {} });
  assert.equal(r.attempted, 2);
  assert.equal(r.stoppedEarly, 'limit');
});
