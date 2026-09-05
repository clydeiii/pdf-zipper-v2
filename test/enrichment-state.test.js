import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { isUsableEnrichment } from '../dist/metadata/enrichment.js';
import { classifyEnrichmentState } from '../dist/metadata/backfill.js';
import { setInfoDictFields } from '../dist/utils/pdf-info-dict.js';

async function pdfWith(fields) {
  const doc = await PDFDocument.create();
  doc.addPage();
  setInfoDictFields(doc, fields);
  return doc;
}

test('isUsableEnrichment: a summary is required', () => {
  assert.equal(isUsableEnrichment({ summary: 'Two sentences about the thing.' }), true);
  assert.equal(isUsableEnrichment({ summary: '' }), false);
  assert.equal(isUsableEnrichment({ summary: '   ' }), false);
});

test('classifyEnrichmentState: never-enriched capture is bare', async () => {
  // Exactly what an Ollama outage leaves behind: Subject + DocType, nothing else.
  const doc = await pdfWith({ DocType: 'blog' });
  assert.equal(classifyEnrichmentState(doc), 'bare');
});

test('classifyEnrichmentState: EnrichedAt with an empty Summary is "empty", not ok', async () => {
  // The malformed-JSON fallback: EnrichedAt stamped, Summary blank.
  const doc = await pdfWith({ DocType: 'blog', EnrichedAt: '2026-09-02T14:00:00Z', Summary: '', Tags: '' });
  assert.equal(classifyEnrichmentState(doc), 'empty');
});

test('classifyEnrichmentState: a real enrichment is ok', async () => {
  const doc = await pdfWith({ DocType: 'news', EnrichedAt: '2026-09-02T14:00:00Z', Summary: 'What the piece says.', Tags: 'ai, policy' });
  assert.equal(classifyEnrichmentState(doc), 'ok');
});

test('classifyEnrichmentState: transcripts are never candidates', async () => {
  // Article-style enrichment mislabels transcripts; the sweep must skip them
  // even when they look bare.
  const doc = await pdfWith({ DocType: 'transcript' });
  assert.equal(classifyEnrichmentState(doc), 'transcript');
});
