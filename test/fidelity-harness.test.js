import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { runFidelityHarness, runFidelityGate } from '../dist/quality/fidelity-harness.js';
import { seedFidelityCorpus } from '../dist/scripts/fidelity-seed.js';
import { setInfoDictFields } from '../dist/utils/pdf-info-dict.js';

const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const article = 'Researchers measured the patterns over several seasons and compared their observations with earlier records. '.repeat(18);

async function pdf(text, metadata) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText(text, { x: 40, y: 750, size: 10, font, maxWidth: 500 });
  if (metadata) {
    doc.setSubject(metadata.url);
    setInfoDictFields(doc, metadata.fields);
  }
  return Buffer.from(await doc.save());
}

async function fixture(t, cases, allowedFalseRejects = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fidelity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = [];
  for (const { text = 'Tiny', ...overrides } of cases) {
    const id = overrides.id || `case-${entries.length}`;
    const buffer = await pdf(text);
    await writeFile(path.join(dir, `${id}.pdf`), buffer);
    entries.push({ id, file: `${id}.pdf`, sha256: hash(buffer), sourceUrl: 'https://example.com/story',
      expected: 'reject', class: 'truncated_shell', reason: 'Reviewed fixture', addedAt: '2026-09-05T00:00:00.000Z',
      reviewed: true, notes: '', options: { sourceUrl: 'https://example.com/story', lenient: false }, ...overrides });
  }
  const manifest = { version: 1, entries, allowedFalseRejects };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, manifest };
}

function cli(dir, ...args) {
  const result = spawnSync(process.execPath, ['dist/scripts/fidelity-check.js', '--corpus-dir', dir, ...args], { encoding: 'utf8' });
  const line = result.stdout.split('\n').find(line => line.startsWith('{"event":"fidelity_check",'));
  assert.ok(line, result.stderr || result.stdout);
  return { status: result.status, result: JSON.parse(line) };
}

test('a reviewed near-empty reject matches and passes the gate and CLI', async t => {
  const { dir } = await fixture(t, [{}]);
  const result = await runFidelityHarness({ corpusDir: dir });
  assert.equal(result.ok, true);
  assert.equal(result.summary.evaluated, 1);
  assert.equal(result.summary.falseAccepts, 0);
  assert.equal(cli(dir).status, 0);
});

test('a known-bad PDF that now passes is a false accept and exits nonzero', async t => {
  const { dir } = await fixture(t, [{ text: article }]);
  const { status, result } = cli(dir);
  assert.equal(status, 1);
  assert.equal(result.ok, false);
  assert.equal(result.summary.falseAccepts, 1);
  assert.equal(result.summary.results[0].status, 'false_accept');
});

test('a SHA256 mismatch is reported and skipped, never counted as a match', async t => {
  const { dir } = await fixture(t, [{ sha256: '0'.repeat(64) }, { id: 'valid' }]);
  const { ok, summary } = await runFidelityHarness({ corpusDir: dir });
  assert.equal(ok, false);
  assert.equal(summary.errors, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.evaluated, 1);
  assert.match(summary.results[0].reason, /SHA256 mismatch/);
});

test('only-reviewed counts unreviewed cases but excludes them from evaluation', async t => {
  const { dir } = await fixture(t, [{}, { id: 'unreviewed', reviewed: false, text: article }]);
  const { result, status } = cli(dir, '--only-reviewed');
  assert.equal(status, 0);
  assert.equal(result.summary.unreviewed, 1);
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.summary.evaluated, 1);
  assert.equal(result.summary.falseAccepts, 0);
  assert.equal((await runFidelityHarness({ corpusDir: dir })).summary.falseAccepts, 1);
  const previous = process.env.DATA_DIR;
  const parent = await mkdtemp(path.join(tmpdir(), 'fidelity-gate-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await symlink(dir, path.join(parent, 'fidelity-corpus'));
  try {
    process.env.DATA_DIR = parent;
    assert.equal((await runFidelityGate()).ok, true);
  } finally { if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; }
});

test('false-reject allowance is by ID and cannot absorb a different regression', async t => {
  const { dir } = await fixture(t, [{ id: 'flaky', expected: 'accept' }], ['flaky']);
  assert.equal((await runFidelityHarness({ corpusDir: dir })).ok, true);
  const other = await fixture(t, [{ id: 'flaky', expected: 'accept', text: article }, { id: 'new', expected: 'accept' }], ['flaky']);
  const result = await runFidelityHarness({ corpusDir: other.dir });
  assert.equal(result.ok, false);
  assert.equal(result.summary.falseRejects, 1);
  assert.equal(result.summary.allowedFalseRejects, 0);
  assert.equal(result.summary.unexpectedFalseRejects, 1);
});

test('analysis uses the stored lenient option', async t => {
  const text = 'A short update with enough words to be a complete social post.';
  const { dir } = await fixture(t, [{ text, expected: 'accept', options: { lenient: true } }]);
  assert.equal((await runFidelityHarness({ corpusDir: dir })).ok, true);
});

test('missing, empty and wholly unreviewed corpora fail closed', async t => {
  const { dir } = await fixture(t, []);
  assert.equal((await runFidelityHarness({ corpusDir: dir })).ok, false);
  assert.equal((await runFidelityHarness({ corpusDir: path.join(dir, 'missing') })).ok, false);
  const pending = await fixture(t, [{ reviewed: false }]);
  const result = await runFidelityHarness({ corpusDir: pending.dir, onlyReviewed: true });
  assert.equal(result.ok, false);
  assert.equal(result.summary.unreviewed, 1);
});

test('manifest mistakes and paths outside the corpus cannot quietly remove coverage', async t => {
  for (const overrides of [{ file: '../outside.pdf' }, { reviewed: 'true' }, { options: { lenient: 'false' } }]) {
    const { dir } = await fixture(t, [overrides]);
    assert.equal((await runFidelityHarness({ corpusDir: dir })).ok, false);
  }
  const { dir } = await fixture(t, [{}]);
  const outside = path.join(dir, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'copy.pdf'), await readFile(path.join(dir, 'case-0.pdf')));
  await rm(path.join(dir, 'case-0.pdf'));
  await symlink(path.join(outside, 'copy.pdf'), path.join(dir, 'case-0.pdf'));
  const result = await runFidelityHarness({ corpusDir: dir });
  assert.equal(result.ok, false);
  assert.match(result.summary.results[0].reason, /outside/);
});

test('seeding copies evidence only, preserves originals and never resets human review', async t => {
  const source = await mkdtemp(path.join(tmpdir(), 'fidelity-source-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  await mkdir(path.join(source, 'debug'));
  await mkdir(path.join(source, 'media', '2026-W36', 'pdfs'), { recursive: true });
  const bad = await pdf('Tiny');
  const good = await pdf(article, { url: 'https://example.com/story', fields: { QualityCheck: 'vision+content', QualityScore: '90' } });
  const weak = await pdf(article, { url: 'https://example.com/weak', fields: { QualityCheck: 'content-only:vision-unavailable', QualityScore: '99' } });
  const originals = new Map([
    [path.join(source, 'debug', '123.pdf'), bad],
    [path.join(source, 'debug', 'timeout.pdf'), good],
    [path.join(source, 'media', '2026-W36', 'pdfs', 'good.pdf'), good],
    [path.join(source, 'media', '2026-W36', 'pdfs', 'weak.pdf'), weak],
  ]);
  for (const [file, buffer] of originals) await writeFile(file, buffer);
  const corpusDir = path.join(source, 'fidelity-corpus');
  const redis = { async hmget(key, ...fields) {
    assert.deepEqual(fields, ['failedReason', 'data']);
    return [key.endsWith(':123') ? 'truncated: insufficient text' : 'timeout: navigation', JSON.stringify({ url: 'https://example.com/broken' })];
  } };
  const options = { sourceDataDir: source, corpusDir, redis };
  assert.equal((await seedFidelityCorpus(options)).added, 2);
  const manifestPath = path.join(corpusDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.ok(manifest.entries.every(entry => entry.reviewed === false));
  assert.deepEqual(manifest.entries.map(entry => entry.expected).sort(), ['accept', 'reject']);
  manifest.entries[0].reviewed = true;
  manifest.entries[0].notes = 'Human reviewed';
  manifest.allowedFalseRejects = [manifest.entries.find(entry => entry.expected === 'accept').id];
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await seedFidelityCorpus(options)).added, 0);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest);
  for (const [file, buffer] of originals) assert.deepEqual(await readFile(file), buffer);
});

test('recorded substackPost facts replay the preview gate: a clean-ending preview is a reject, a full free post is not', async t => {
  // `article` is 270 words and passes analyzePdfContent on its own.
  const { dir } = await fixture(t, [
    { id: 'preview', text: article, substackPost: { audience: 'only_paid', wordcount: 1346 } },
    { id: 'preview-no-facts', text: article },
    { id: 'free-full', text: article, expected: 'accept', class: 'substack', substackPost: { audience: 'everyone', wordcount: 300 } },
  ]);
  const { summary } = await runFidelityHarness({ corpusDir: dir });
  const byId = Object.fromEntries(summary.results.map(row => [row.id, row]));
  assert.equal(byId.preview.status, 'match');
  assert.match(byId.preview.reason, /^paywall: Substack only_paid post: extracted \d+ of 1346 words/); // pdf.js merges a few words at wrap points
  assert.equal(byId['preview-no-facts'].status, 'false_accept', 'without facts the analyzer alone passes the preview');
  assert.equal(byId['free-full'].status, 'match');
  assert.equal(summary.falseAccepts, 1);
  // Malformed facts fail closed.
  const bad = await fixture(t, [{ id: 'bad', text: article, substackPost: { audience: 'only_paid', wordcount: '1346' } }]);
  const result = await runFidelityHarness({ corpusDir: bad.dir });
  assert.equal(result.ok, false);
  assert.match(result.summary.issues.join('\n'), /Invalid substackPost facts: bad/);
});

test('seeding strips Substack share tokens, dedupes retries that differ only in counts, and records post facts', async t => {
  const source = await mkdtemp(path.join(tmpdir(), 'fidelity-source-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  await mkdir(path.join(source, 'debug'));
  await mkdir(path.join(source, 'media'));
  await writeFile(path.join(source, 'debug', '1.pdf'), await pdf('Tiny one'));
  await writeFile(path.join(source, 'debug', '2.pdf'), await pdf('Tiny two'));
  const shared = 'https://open.substack.com/pub/sourcesnews/p/sam-altman-openai-agi?r=9qonx&utm_medium=ios';
  const redis = { async hmget(key) {
    return [key.endsWith(':1') ? 'truncated: PDF has only 726 characters' : 'truncated: PDF has only 727 characters', JSON.stringify({ url: shared, originalUrl: shared })];
  } };
  const asked = [];
  const substackFacts = async url => { asked.push(url); return { audience: 'everyone', wordcount: 1314 }; };
  const corpusDir = path.join(source, 'fidelity-corpus');
  const summary = await seedFidelityCorpus({ sourceDataDir: source, corpusDir, redis, substackFacts });
  assert.equal(summary.added, 1, 'two retries of one job are one case');
  const [entry] = JSON.parse(await readFile(path.join(corpusDir, 'manifest.json'), 'utf8')).entries;
  assert.equal(entry.sourceUrl, 'https://open.substack.com/pub/sourcesnews/p/sam-altman-openai-agi');
  assert.equal(entry.options.sourceUrl, entry.sourceUrl);
  assert.ok(!JSON.stringify(entry).includes('9qonx'), 'reader token must not be persisted anywhere in the entry');
  assert.deepEqual(entry.substackPost, { audience: 'everyone', wordcount: 1314 });
  assert.deepEqual(asked, [entry.sourceUrl]);
});
