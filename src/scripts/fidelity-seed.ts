import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, realpath, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { Redis } from 'ioredis';
import { classifyFailureMessage } from '../fix/failure.js';
import { readInfoDictField } from '../utils/pdf-info-dict.js';
import { fidelityCorpusDir, loadFidelityManifest, type FidelityEntry, type FidelityManifest } from '../quality/fidelity-harness.js';

type Candidate = { sourceFile: string; entry: FidelityEntry };
type JobReader = { hmget(key: string, ...fields: string[]): Promise<(string | null)[]> };
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

async function files(dir: string): Promise<string[]> {
  try { return (await readdir(dir, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.pdf')).map(item => path.join(dir, item.name)).sort(); }
  catch (error) { if (isMissing(error)) return []; throw error; }
}

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
}

function isTweet(url: string): boolean {
  try { return /^(www\.|mobile\.)?(x\.com|twitter\.com)$/.test(new URL(url).hostname) && /\/status\/\d+/.test(new URL(url).pathname); }
  catch { return false; }
}

function rejectClass(reason: string): string {
  const failureClass = classifyFailureMessage(reason);
  if (/textless body pages between/i.test(reason)) return 'sandwiched_blank_run';
  if (/^blank_page:/.test(reason)) return 'blank_page';
  if (failureClass === 'quality_false_negative_suspected') return /error page|404|not found/i.test(reason) ? 'error_page' : 'truncated_shell';
  return failureClass;
}

/** Round-robin classes, then hosts, so one publisher cannot consume the sample. */
function spread(candidates: Candidate[], limit: number): Candidate[] {
  const classes = new Map<string, Map<string, Candidate[]>>();
  for (const candidate of candidates) {
    const kind = candidate.entry.class;
    if (!classes.has(kind)) classes.set(kind, new Map());
    const hosts = classes.get(kind)!;
    const host = hostname(candidate.entry.sourceUrl);
    if (!hosts.has(host)) hosts.set(host, []);
    hosts.get(host)!.push(candidate);
  }
  const queues = [...classes.keys()].sort().map(kind => {
    const hosts = classes.get(kind)!;
    const hostQueues = [...hosts.keys()].sort().map(host => hosts.get(host)!);
    const queue: Candidate[] = [];
    while (hostQueues.some(items => items.length)) for (const items of hostQueues) {
      const item = items.shift(); if (item) queue.push(item);
    }
    return queue;
  });
  const selected: Candidate[] = [];
  while (selected.length < limit && queues.some(items => items.length)) for (const items of queues) {
    const item = items.shift(); if (item) selected.push(item);
    if (selected.length === limit) break;
  }
  return selected;
}

export async function seedFidelityCorpus({
  sourceDataDir, corpusDir, redis, rejectLimit = 60, acceptLimit = 60,
}: { sourceDataDir: string; corpusDir: string; redis: JobReader; rejectLimit?: number; acceptLimit?: number }) {
  for (const limit of [rejectLimit, acceptLimit]) if (!Number.isInteger(limit) || limit < 0) throw new Error('Seed limits must be non-negative integers');
  // Only this directory is writable. Originals are read into buffers and never opened for writing.
  await mkdir(corpusDir, { recursive: true });
  const root = await realpath(corpusDir);
  const sourceRoot = await realpath(sourceDataDir);
  if (root === sourceRoot || root.startsWith(path.join(sourceRoot, 'debug') + path.sep) ||
      root === path.join(sourceRoot, 'debug') || root === path.join(sourceRoot, 'media') ||
      root.startsWith(path.join(sourceRoot, 'media') + path.sep)) throw new Error('Corpus must be separate from source capture directories');
  const lockPath = path.join(root, '.seed.lock');
  const lock = await open(lockPath, 'wx');
  try {
    let manifest: FidelityManifest;
    try { manifest = await loadFidelityManifest(root); }
    catch (error) { if (!isMissing(error)) throw error; manifest = { version: 1, entries: [], allowedFalseRejects: [] }; }
    const knownHashes = new Set(manifest.entries.map(entry => entry.sha256));
    const knownIds = new Set(manifest.entries.map(entry => entry.id));
    // Retries of one failed job write byte-different debug PDFs with the same
    // content; one (url, reason) pair is one case, not six.
    const knownCases = new Set(manifest.entries.map(entry => `${entry.sourceUrl}|${entry.reason}`));
    const candidates: Candidate[] = [];
    const addedAt = new Date().toISOString();
    const propose = (buffer: Buffer, sourceFile: string, entry: Omit<FidelityEntry, 'id' | 'sha256' | 'file' | 'addedAt' | 'reviewed'>) => {
      const hash = sha256(buffer);
      if (knownHashes.has(hash)) return;
      const caseKey = `${entry.sourceUrl}|${entry.reason}`;
      if (knownCases.has(caseKey)) return;
      knownCases.add(caseKey);
      const id = `${entry.expected}-${hash.slice(0, 20)}`;
      if (knownIds.has(id)) throw new Error(`Candidate ID collision: ${id}`);
      knownIds.add(id);
      knownHashes.add(hash);
      candidates.push({ sourceFile, entry: { ...entry, id, sha256: hash, file: `${id}.pdf`, addedAt, reviewed: false } });
    };
    if (manifest.entries.filter(entry => entry.expected === 'reject').length < rejectLimit) {
      for (const sourceFile of await files(path.join(sourceRoot, 'debug'))) {
        const jobId = path.basename(sourceFile, '.pdf');
        const [reason, rawData] = await redis.hmget(`bull:url-conversion:${jobId}`, 'failedReason', 'data');
        if (!reason || !/^(truncated|paywall|bot_detected|blank_page):/.test(reason) || !rawData) continue;
        try {
          const data = JSON.parse(rawData);
          if (typeof data.url !== 'string' || !data.url) continue;
          const sourceUrl = typeof data.originalUrl === 'string' && data.originalUrl ? data.originalUrl : data.url;
          const lenient = isTweet(sourceUrl);
          propose(await readFile(sourceFile), sourceFile, {
            sourceUrl, expected: 'reject', class: rejectClass(reason), reason,
            options: { sourceUrl, lenient },
            notes: `Proposed from debug/${jobId}.pdf; Redis failureClass=${classifyFailureMessage(reason)}. ${lenient ? 'Tweet leniency inferred from status URL; confirm this is not an X Article. ' : ''}Failure history is evidence, not a reviewed verdict. Inspect PDF and call options.`,
          });
        } catch (error) { log('fidelity_seed_skip', { file: sourceFile, error: error instanceof Error ? error.message : String(error) }); }
      }
    }
    if (manifest.entries.filter(entry => entry.expected === 'accept').length < acceptLimit) {
      const { analyzePdfContent } = await import('../quality/pdf-content.js');
      const media = path.join(sourceRoot, 'media');
      const weeks = (await readdir(media, { withFileTypes: true })).filter(item => item.isDirectory() && /^\d{4}-W\d{2}$/.test(item.name)).map(item => item.name).sort().reverse();
      let scanned = 0;
      for (const week of weeks) for (const sourceFile of await files(path.join(media, week, 'pdfs'))) {
        try {
          const buffer = await readFile(sourceFile);
          if (knownHashes.has(sha256(buffer))) continue;
          const pdf = await PDFDocument.load(buffer, { updateMetadata: false });
          const check = readInfoDictField(pdf, 'QualityCheck');
          const rawScore = readInfoDictField(pdf, 'QualityScore');
          const score = rawScore?.trim() ? Number(rawScore) : NaN;
          if (check !== 'vision+content' || !Number.isFinite(score) || score < 85 || score > 100) continue;
          const sourceUrl = pdf.getSubject();
          if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) continue;
          const name = path.basename(sourceFile);
          const tweet = /^(x\.com|twitter\.com)-.*-post-/.test(name);
          const host = hostname(sourceUrl);
          const passthrough = /(^|\.)arxiv\.org$/.test(host) || /\.pdf(?:[?#]|$)/i.test(sourceUrl);
          const options = passthrough ? {} : { sourceUrl, lenient: tweet };
          // Text density is used only to stratify the sample, never to choose its verdict.
          const result = await analyzePdfContent(buffer, options);
          const kind = tweet ? 'tweet' : passthrough ? 'passthrough' :
            /(^|\.)substack\.com$/.test(host) || /substack/i.test(result.extractedText || '') ? 'substack' :
            result.charCount < 2500 ? 'short_announcement' : result.charsPerKb < 10 ? 'image_heavy' : 'article';
          propose(buffer, sourceFile, {
            sourceUrl, expected: 'accept', class: kind, options,
            reason: `QualityCheck=vision+content; QualityScore=${score}`,
            notes: `Proposed from ${path.relative(sourceRoot, sourceFile)}; ${result.charCount} chars, ${result.pageCount} pages, ${result.charsPerKb} chars/KB. Category and completeness need visual review; confirm options (including dark Nitter threads).`,
          });
        } catch (error) { log('fidelity_seed_skip', { file: sourceFile, error: error instanceof Error ? error.message : String(error) }); }
        finally { if (++scanned % 100 === 0) log('fidelity_seed_progress', { scanned, candidates: candidates.length }); }
      }
    }
    const selected = (['reject', 'accept'] as const).flatMap(expected => spread(
      candidates.filter(candidate => candidate.entry.expected === expected),
      Math.max(0, (expected === 'reject' ? rejectLimit : acceptLimit) - manifest.entries.filter(entry => entry.expected === expected).length),
    ));
    for (const candidate of selected) {
      const buffer = await readFile(candidate.sourceFile);
      if (sha256(buffer) !== candidate.entry.sha256) throw new Error(`Source changed during seeding: ${candidate.sourceFile}`);
      const destination = path.join(root, candidate.entry.file);
      try { await writeFile(destination, buffer, { flag: 'wx' }); }
      catch (error) {
        // A previous interrupted seed may have copied this immutable file already.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            path.dirname(await realpath(destination)) !== root || sha256(await readFile(destination)) !== candidate.entry.sha256) throw error;
      }
      manifest.entries.push(candidate.entry);
    }
    // Preserve reviewed verdicts and exception IDs across reseeds; publish only a complete manifest.
    const temporary = path.join(root, `.manifest.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      await rename(temporary, path.join(root, 'manifest.json'));
    } finally { await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
    const byClass = Object.fromEntries([...new Set(manifest.entries.map(entry => entry.class))].sort().map(kind =>
      [kind, manifest.entries.filter(entry => entry.class === kind).length]));
    const summary = { corpusDir: root, added: selected.length, total: manifest.entries.length, unreviewed: manifest.entries.filter(entry => !entry.reviewed).length, byClass };
    log('fidelity_seed', summary);
    return summary;
  } finally { await lock.close(); await unlink(lockPath); }
}

export async function main(): Promise<void> {
  let redis: Redis | undefined;
  try {
    const { values } = parseArgs({ options: {
      'source-data-dir': { type: 'string' }, 'corpus-dir': { type: 'string' },
      'reject-limit': { type: 'string', default: '60' }, 'accept-limit': { type: 'string', default: '60' },
    } });
    process.env.REDIS_HOST ??= 'localhost';
    process.env.REDIS_PORT ??= '6379';
    process.env.PORT ??= '3002';
    redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT),
      lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 5000 });
    redis.on('error', () => { /* The awaited read reports connection failures once, as JSON. */ });
    await seedFidelityCorpus({ sourceDataDir: path.resolve(values['source-data-dir'] || process.env.DATA_DIR || './data'),
      corpusDir: values['corpus-dir'] || fidelityCorpusDir(), redis,
      rejectLimit: Number(values['reject-limit']), acceptLimit: Number(values['accept-limit']) });
  } catch (error) {
    log('fidelity_seed_error', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally { redis?.disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
