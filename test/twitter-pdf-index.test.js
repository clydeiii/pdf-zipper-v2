import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { openTwitterDb } from '../dist/twitter/db.js';
import { refreshPdfIndex } from '../dist/twitter/pdf-index.js';

async function makePdf(subject) {
  const document = await PDFDocument.create();
  document.addPage([72, 72]);
  document.setSubject(subject);
  return document.save();
}

test('PDF index normalizes subjects, skips unchanged files, and prunes deletions', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'twitter-pdf-index-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const pdfDir = path.join(dataDir, 'media', '2026-W30', 'pdfs');
  await mkdir(pdfDir, { recursive: true });
  const urlPdf = path.join(pdfDir, 'url.pdf');
  const notePdf = path.join(pdfDir, 'note.pdf');
  await writeFile(
    urlPdf,
    await makePdf('https://www.example.com/story/?utm_source=twitter&a=1'),
  );
  await writeFile(notePdf, await makePdf('a useful note, but not a URL'));

  const db = openTwitterDb({ dataDir });
  t.after(() => db.close());
  assert.deepEqual(await refreshPdfIndex(db, { dataDir }), {
    scanned: 2,
    added: 2,
    updated: 0,
    removed: 0,
    skippedTooLarge: 0,
  });
  assert.deepEqual(
    db.prepare(`
      SELECT pdf_path, url, url_normalized, url_no_query
      FROM pdf_index
      ORDER BY pdf_path
    `).all(),
    [
      {
        pdf_path: 'media/2026-W30/pdfs/note.pdf',
        url: null,
        url_normalized: null,
        url_no_query: null,
      },
      {
        pdf_path: 'media/2026-W30/pdfs/url.pdf',
        url: 'https://www.example.com/story/?utm_source=twitter&a=1',
        url_normalized: 'https://example.com/story?a=1',
        url_no_query: 'https://example.com/story',
      },
    ],
  );
  assert.deepEqual(await refreshPdfIndex(db, { dataDir }), {
    scanned: 0,
    added: 0,
    updated: 0,
    removed: 0,
    skippedTooLarge: 0,
  });

  await unlink(urlPdf);
  assert.deepEqual(await refreshPdfIndex(db, { dataDir }), {
    scanned: 0,
    added: 0,
    updated: 0,
    removed: 1,
    skippedTooLarge: 0,
  });
  assert.deepEqual(
    db.prepare('SELECT pdf_path FROM pdf_index').all(),
    [{ pdf_path: 'media/2026-W30/pdfs/note.pdf' }],
  );
});

test('PDF index records oversized files once and protects a non-empty index from a zero scan', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'twitter-pdf-index-large-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const pdfDir = path.join(dataDir, 'media', '2026-W30', 'pdfs');
  await mkdir(pdfDir, { recursive: true });
  const largePdf = path.join(pdfDir, 'large.pdf');
  await writeFile(largePdf, await makePdf('https://example.com/too-large'));

  const db = openTwitterDb({ dataDir });
  t.after(() => db.close());
  const first = await refreshPdfIndex(db, { dataDir, maxBytes: 1 });
  assert.equal(first.scanned, 1);
  assert.equal(first.skippedTooLarge, 1);
  assert.deepEqual(
    db.prepare('SELECT url, mtime_ms FROM pdf_index').all().map((row) => ({
      url: row.url,
      hasMtime: row.mtime_ms > 0,
    })),
    [{ url: null, hasMtime: true }],
  );
  assert.equal((await refreshPdfIndex(db, { dataDir, maxBytes: 1 })).scanned, 0);

  await rm(path.join(dataDir, 'media'), { recursive: true, force: true });
  const zeroScan = await refreshPdfIndex(db, { dataDir, maxBytes: 1 });
  assert.equal(zeroScan.removed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pdf_index').get().count, 1);
});
