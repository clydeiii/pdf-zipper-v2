import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AnalyzePdfContentOptions } from './pdf-content.js';
import { substackPreviewShortfall, type SubstackPostFacts } from './substack-preview.js';

export interface FidelityEntry {
  id: string;
  file: string;
  sha256: string;
  sourceUrl: string;
  expected: 'reject' | 'accept';
  class: string;
  reason: string;
  addedAt: string;
  reviewed: boolean;
  notes: string;
  /** Explicit call arguments preserve worker behavior, including {} for pass-throughs. */
  options: AnalyzePdfContentOptions;
  /**
   * Substack post facts (`audience`, true `wordcount` from the post API) recorded
   * at review time so the worker's preview gate can be replayed offline: an
   * entry with these is judged by analyzePdfContent AND substackPreviewShortfall.
   */
  substackPost?: SubstackPostFacts;
}

export interface FidelityManifest {
  version: 1;
  entries: FidelityEntry[];
  allowedFalseRejects: string[];
}

export interface FidelityRow {
  id: string;
  expected: FidelityEntry['expected'];
  class: string;
  reviewed: boolean;
  actual?: 'accept' | 'reject';
  status: 'match' | 'false_accept' | 'false_reject' | 'allowed_false_reject' | 'unreviewed' | 'error';
  reason?: string;
  charCount?: number;
  pageCount?: number;
}

export interface FidelitySummary {
  total: number;
  evaluated: number;
  falseAccepts: number;
  falseRejects: number;
  allowedFalseRejects: number;
  unexpectedFalseRejects: number;
  unreviewed: number;
  skipped: number;
  errors: number;
  issues: string[];
  results: FidelityRow[];
}

export function fidelityCorpusDir(): string {
  return path.resolve(process.env.DATA_DIR || './data', 'fidelity-corpus');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate before running anything: a typo must not silently remove a held-out case. */
export function parseFidelityManifest(value: unknown): FidelityManifest {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries) ||
      !Array.isArray(value.allowedFalseRejects)) throw new Error('Invalid fidelity manifest: expected version 1, entries and allowedFalseRejects');
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry)) throw new Error('Invalid fidelity entry');
    for (const key of ['id', 'file', 'sha256', 'sourceUrl', 'class', 'reason', 'addedAt']) {
      if (typeof entry[key] !== 'string' || !(entry[key] as string).trim()) throw new Error(`Invalid entry ${String(entry.id)}: ${key} required`);
    }
    const id = entry.id as string;
    if (ids.has(id)) throw new Error(`Duplicate fidelity id: ${id}`);
    ids.add(id);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 as string) ||
        !['reject', 'accept'].includes(entry.expected as string) ||
        typeof entry.reviewed !== 'boolean' || typeof entry.notes !== 'string' ||
        !Number.isFinite(Date.parse(entry.addedAt as string))) throw new Error(`Invalid fidelity entry: ${id}`);
    // Flat filenames keep both readers and the seeder away from original captures.
    if (!/^[^/\\]+\.pdf$/i.test(entry.file as string) || path.isAbsolute(entry.file as string)) throw new Error(`Unsafe corpus file: ${id}`);
    if (entry.substackPost !== undefined && (!object(entry.substackPost) ||
        typeof entry.substackPost.audience !== 'string' || !(entry.substackPost.audience as string).trim() ||
        typeof entry.substackPost.wordcount !== 'number' || !(entry.substackPost.wordcount as number > 0))) throw new Error(`Invalid substackPost facts: ${id}`);
    if (!object(entry.options) || Object.keys(entry.options).some(key => !['lenient', 'sourceUrl'].includes(key)) ||
        (entry.options.lenient !== undefined && typeof entry.options.lenient !== 'boolean') ||
        (entry.options.sourceUrl !== undefined && typeof entry.options.sourceUrl !== 'string')) throw new Error(`Invalid analysis options: ${id}`);
  }
  const allowed = value.allowedFalseRejects;
  const entries = value.entries as FidelityEntry[];
  if (new Set(allowed).size !== allowed.length || allowed.some(id => typeof id !== 'string' ||
      !entries.some(entry => entry.id === id && entry.expected === 'accept'))) {
    throw new Error('allowedFalseRejects must contain unique IDs of expected-accept entries');
  }
  return value as unknown as FidelityManifest;
}

export async function loadFidelityManifest(corpusDir: string): Promise<FidelityManifest> {
  return parseFidelityManifest(JSON.parse(await readFile(path.join(corpusDir, 'manifest.json'), 'utf8')));
}

export async function runFidelityHarness(
  { corpusDir = fidelityCorpusDir(), onlyReviewed = false }: { corpusDir?: string; onlyReviewed?: boolean } = {},
): Promise<{ ok: boolean; summary: FidelitySummary }> {
  const summary: FidelitySummary = {
    total: 0, evaluated: 0, falseAccepts: 0, falseRejects: 0, allowedFalseRejects: 0,
    unexpectedFalseRejects: 0, unreviewed: 0, skipped: 0, errors: 0, issues: [], results: [],
  };
  const issue = (message: string) => { summary.errors++; summary.issues.push(message); };
  try {
    const manifest = await loadFidelityManifest(corpusDir);
    const root = await realpath(corpusDir);
    summary.total = manifest.entries.length;
    summary.unreviewed = manifest.entries.filter(entry => !entry.reviewed).length;
    // Lazy import lets manifest/config failures become structured gate failures too.
    const { analyzePdfContent } = await import('./pdf-content.js');
    const allowed = new Set(manifest.allowedFalseRejects);
    for (const entry of [...manifest.entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      const row: FidelityRow = { id: entry.id, expected: entry.expected, class: entry.class, reviewed: entry.reviewed, status: 'unreviewed' };
      summary.results.push(row);
      if (onlyReviewed && !entry.reviewed) { summary.skipped++; continue; }
      try {
        const file = await realpath(path.join(root, entry.file));
        if (path.dirname(file) !== root) throw new Error('Corpus file resolves outside the corpus directory');
        const buffer = await readFile(file);
        if (createHash('sha256').update(buffer).digest('hex') !== entry.sha256) throw new Error('SHA256 mismatch');
        const result = await analyzePdfContent(buffer, entry.options);
        summary.evaluated++;
        // Replay the worker's Substack preview gate when the facts were recorded.
        const shortfall = result.passed && entry.substackPost
          ? substackPreviewShortfall(result.extractedText ?? '', entry.substackPost.audience, entry.substackPost.wordcount)
          : null;
        row.actual = result.passed && !shortfall ? 'accept' : 'reject';
        row.reason = shortfall ? `paywall: ${shortfall}` : result.reason;
        row.charCount = result.charCount;
        row.pageCount = result.pageCount;
        const accepted = row.actual === 'accept';
        if (entry.expected === 'reject' && accepted) {
          row.status = 'false_accept';
          summary.falseAccepts++;
        } else if (entry.expected === 'accept' && !accepted) {
          summary.falseRejects++;
          if (allowed.has(entry.id)) { row.status = 'allowed_false_reject'; summary.allowedFalseRejects++; }
          else { row.status = 'false_reject'; summary.unexpectedFalseRejects++; }
        } else row.status = 'match';
        // Production fails open on parse errors. That cannot prove fidelity of an accept.
        if (result.pageCount === 0) issue(`${entry.id}: PDF analysis returned no pages`);
      } catch (error) {
        row.status = 'error';
        row.reason = error instanceof Error ? error.message : String(error);
        summary.skipped++;
        issue(`${entry.id}: ${row.reason}`);
      }
    }
    if (summary.evaluated === 0) issue('No corpus entries evaluated; seed and review cases before enabling the gate');
  } catch (error) {
    issue(error instanceof Error ? error.message : String(error));
  }
  return { ok: summary.falseAccepts === 0 && summary.unexpectedFalseRejects === 0 && summary.errors === 0, summary };
}

/** The fix worker must always judge only the human-reviewed held-out cases. */
export async function runFidelityGate(): Promise<{ ok: boolean; summary: FidelitySummary }> {
  return runFidelityHarness({ onlyReviewed: true });
}
