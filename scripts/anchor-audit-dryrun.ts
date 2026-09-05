/**
 * Read-only host calibration, newest PDFs first:
 * npx tsx --env-file=.env scripts/anchor-audit-dryrun.ts --limit 20
 * npx tsx --env-file=.env scripts/anchor-audit-dryrun.ts --limit 20 --self-check
 * --dir overrides DATA_DIR/media. No captures, metadata, or reports are written.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { analyzePdfContent } from '../src/quality/pdf-content.js';
import { buildAnchorFlags, checkAnchors, normalizeForAnchorMatch, pickAnchors } from '../src/quality/content-anchors.js';
import { readInfoDictField } from '../src/utils/pdf-info-dict.js';

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

async function recentPdfs(dir: string): Promise<Array<{ file: string; mtime: number }>> {
  const files: Array<{ file: string; mtime: number }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await recentPdfs(file));
    else if (entry.isFile() && /\.pdf$/i.test(entry.name) && !/\.transcript\.pdf$/i.test(entry.name)) {
      files.push({ file, mtime: (await stat(file)).mtimeMs });
    }
  }
  return files;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { limit: { type: 'string' }, dir: { type: 'string' }, 'self-check': { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('Usage: npx tsx --env-file=.env scripts/anchor-audit-dryrun.ts [N | --limit N] [--self-check] [--dir DATA_DIR/media]');
    return;
  }
  const limit = Number(values.limit ?? positionals[0] ?? 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || positionals.length > 1) throw new Error('N must be a positive integer');
  const dir = path.resolve(values.dir ?? path.join(process.env.DATA_DIR || './data', 'media'));
  const selfCheck = values['self-check'] ?? false;
  const files = (await recentPdfs(dir)).sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  let checked = 0;
  let flagged = 0;
  let errors = 0;
  let withoutAnchors = 0;
  for (const { file } of files) {
    if (checked >= limit) break;
    try {
      const buffer = await readFile(file);
      const doc = await PDFDocument.load(buffer, { updateMetadata: false });
      let anchorsJson = readInfoDictField(doc, 'ContentAnchors');
      if (!selfCheck && !anchorsJson) { withoutAnchors++; continue; }
      checked++;
      const content = await analyzePdfContent(buffer, { preserveTextLayout: true });
      if (content.extractedText === undefined) throw new Error(content.reason || 'No extraction result');
      const text = content.extractedText;
      let sourceTextChars: string | number | undefined = readInfoDictField(doc, 'SourceTextChars');
      let syntheticFallback = false;
      if (selfCheck) {
        const normalized = normalizeForAnchorMatch(text);
        if (!normalized) throw new Error('Self-check untestable: PDF has no text');
        let anchors = pickAnchors([text]);
        if (!anchors.length) {
          // Short/non-prose PDFs still need a normalization sanity check.
          // Relax capture's distinctiveness/length rules only in this mode;
          // a one-sentence PDF deliberately uses that sentence three times.
          const sentences = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text), s => normalizeForAnchorMatch(s.segment)).filter(Boolean);
          anchors = [sentences[0], sentences[Math.floor(sentences.length / 2)], sentences.at(-1)!];
          syntheticFallback = true;
        }
        anchorsJson = JSON.stringify(anchors);
        sourceTextChars = text.replace(/\s+/g, ' ').trim().length;
      }
      const parsed: unknown = JSON.parse(anchorsJson!);
      if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every(a => typeof a === 'string' && normalizeForAnchorMatch(a))) {
        throw new Error('Invalid ContentAnchors: expected three non-empty strings');
      }
      const flags = buildAnchorFlags(anchorsJson, text, sourceTextChars);
      if (flags.length) flagged++;
      log('anchor_audit_file', {
        file, mode: selfCheck ? 'self-check' : 'captured', verdict: flags.length ? 'suspect' : 'pass',
        ...checkAnchors(anchorsJson, text), flags, sourceTextChars,
        pdfTextChars: normalizeForAnchorMatch(text).length,
        sourceWordCount: readInfoDictField(doc, 'SourceWordCount'), syntheticFallback,
      });
    } catch (error) {
      errors++;
      log('anchor_audit_file', { file, verdict: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }
  log('anchor_audit_done', { mode: selfCheck ? 'self-check' : 'captured', requested: limit, checked, flagged, errors, withoutAnchors });
  // Findings in captured mode are reports only. A failed self-check or a
  // read/parse error means calibration itself did not complete successfully.
  if (errors || (selfCheck && (flagged || !checked))) process.exitCode = 1;
}

main().catch(error => {
  log('anchor_audit_error', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
