/**
 * Periodic enrichment repair sweep.
 *
 * Enrichment is deliberately non-fatal everywhere: when the Ollama host is
 * unreachable a capture is still saved, just without Title/Summary/Tags. That
 * is the right call at capture time (the page may not be there tomorrow), but
 * the bare file then ships to the knowledge base as-is. On 2026-09-02 a six-hour
 * Ollama outage left 34 PDFs that way and a further 16 carried an EnrichedAt
 * stamp with an empty Summary (malformed LLM reply); none were flagged or fixed.
 *
 * Two sources of work, unioned each tick:
 *   1. A DURABLE pending set (Redis `enrichment:pending-pdfs`): every save
 *      that lands without a usable summary registers its path here (via the
 *      listener hook in save-pdf.ts). Entries live until the file is repaired
 *      or gone, so an outage longer than any window can't age work out.
 *   2. A rolling window scan (last ENRICHMENT_REPAIR_WINDOW_HOURS, default
 *      48h) over the week bins, as a backstop for saves made before the set
 *      existed or while Redis was unavailable.
 *
 * The sweep runs every ENRICHMENT_REPAIR_INTERVAL_HOURS (default 2), is gated
 * on an Ollama health probe (no point re-failing during the outage that
 * created the work), and caps files per tick so a big backlog yields to fresh
 * captures rather than monopolizing the shared model. Repairs re-embed
 * metadata in place; the file's new mtime makes it "new" for the nightly
 * bundle and for Select New, so the repaired copy supersedes the bare one
 * downstream (later copies of a filename win — see doex-enrichment-details.md).
 *
 * Forward-looking by design: the window means history is never touched.
 */

import { backfillBarePdfs, type BackfillResult } from '../metadata/backfill.js';
import { checkOllamaHealth } from '../quality/ollama.js';
import { sendDiscordNotification } from '../notifications/discord.js';
import { setBarePdfListener } from '../utils/save-pdf.js';
import { queueConnection } from '../config/redis.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

const ENABLED = process.env.ENRICHMENT_REPAIR_ENABLED !== 'false';
const INTERVAL_HOURS = Number(process.env.ENRICHMENT_REPAIR_INTERVAL_HOURS) || 2;
const WINDOW_HOURS = Number(process.env.ENRICHMENT_REPAIR_WINDOW_HOURS) || 48;
/** Delay before the first run so startup (browser, queues) settles first. */
const STARTUP_DELAY_MS = 10 * 60 * 1000;
/** Cap per tick: a huge backlog is spread over several ticks instead of monopolizing Ollama. */
const MAX_PER_TICK = Number(process.env.ENRICHMENT_REPAIR_MAX_PER_TICK) || 40;
/** Redis set of absolute PDF paths saved without usable enrichment. */
export const PENDING_KEY = 'enrichment:pending-pdfs';
/** Redis hash path → failed repair attempts (cleared when the file leaves the set). */
export const ATTEMPTS_KEY = 'enrichment:pending-attempts';
/** Failed repair attempts before a pending file is abandoned. */
const MAX_ATTEMPTS = Number(process.env.ENRICHMENT_REPAIR_MAX_ATTEMPTS) || 5;

let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let running = false;

export interface RepairRunResult extends BackfillResult {
  skippedReason?: 'ollama_unhealthy' | 'already_running';
  windowHours: number;
  /** Size of the durable pending set before this run. */
  pendingBefore: number;
  /** Size after (repaired + vanished entries removed). */
  pendingAfter: number;
}

/** Register a bare save in the durable pending set. Best-effort. */
export function registerBarePdf(filePath: string): void {
  queueConnection.sadd(PENDING_KEY, filePath).catch(() => { /* Redis hiccup — the window scan is the backstop */ });
}

async function readPending(): Promise<string[]> {
  try {
    return await queueConnection.smembers(PENDING_KEY);
  } catch {
    return [];
  }
}

async function clearPending(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await queueConnection.srem(PENDING_KEY, ...paths);
    await queueConnection.hdel(ATTEMPTS_KEY, ...paths);
  } catch { /* best-effort */ }
}

/**
 * Count a failed attempt per file; after MAX_ATTEMPTS the file is dropped
 * from the set with a log line (the window scan won't pick it up either once
 * it ages out, so this is where a permanently unrepairable file stops costing
 * an LLM call every tick).
 */
async function bumpAttemptsAndExpire(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      const n = await queueConnection.hincrby(ATTEMPTS_KEY, p, 1);
      if (n >= MAX_ATTEMPTS) {
        await queueConnection.srem(PENDING_KEY, p);
        await queueConnection.hdel(ATTEMPTS_KEY, p);
        console.warn(JSON.stringify({
          event: 'enrichment_repair_abandoned',
          file: p,
          attempts: n,
          timestamp: new Date().toISOString(),
        }));
      }
    } catch { /* best-effort */ }
  }
}

/**
 * One repair pass. Safe to call on demand (see POST /api/audit/repair-enrichment);
 * never throws for per-file problems and never overlaps itself.
 */
export async function runEnrichmentRepair(windowHours: number = WINDOW_HOURS, dryRun = false): Promise<RepairRunResult> {
  const empty: BackfillResult = { scanned: 0, bare: 0, attempted: 0, enriched: 0, skippedNoText: 0, failed: 0, details: [], outcomes: [] };
  if (running) return { ...empty, windowHours, skippedReason: 'already_running', pendingBefore: 0, pendingAfter: 0 };
  running = true;
  try {
    const pending = await readPending();
    const health = await checkOllamaHealth();
    if (!health.healthy) {
      console.log(JSON.stringify({
        event: 'enrichment_repair_skipped',
        reason: 'ollama_unhealthy',
        error: health.error,
        pending: pending.length,
        timestamp: new Date().toISOString(),
      }));
      return { ...empty, windowHours, skippedReason: 'ollama_unhealthy', pendingBefore: pending.length, pendingAfter: pending.length };
    }

    console.log(JSON.stringify({ event: 'enrichment_repair_start', windowHours, dryRun, pending: pending.length, timestamp: new Date().toISOString() }));

    // 1. Durable pending set first — these are known-bare and may be older
    //    than the window.
    const fromSet = pending.length > 0
      ? await backfillBarePdfs({ files: pending, includeEmptySummary: true, limit: MAX_PER_TICK, dryRun })
      : empty;
    // Pending-set maintenance is driven by per-file outcomes, never by
    // inference from counts: a file leaves the set when it is enriched, was
    // already fine (a rerun re-enriched it), is a transcript, is gone, or has
    // no text to enrich from (nothing will ever change that). `failed` stays
    // for the next tick, bounded by MAX_ATTEMPTS so one corrupt file can't be
    // retried every two hours forever.
    if (!dryRun) {
      const terminal = new Set(['enriched', 'ok', 'transcript', 'gone', 'no_text', 'no_source_url']);
      const done = fromSet.outcomes.filter((o) => terminal.has(o.outcome)).map((o) => o.file);
      const failed = fromSet.outcomes.filter((o) => o.outcome === 'failed').map((o) => o.file);
      await clearPending(done);
      await bumpAttemptsAndExpire(failed);
    }

    // 2. Window scan backstop, with whatever ATTEMPT budget is left. Skipped
    //    entirely when the set pass tripped the breaker — the model is not
    //    answering usefully right now.
    const budget = Math.max(0, MAX_PER_TICK - fromSet.attempted);
    const fromWindow = budget > 0 && fromSet.stoppedEarly !== 'breaker'
      ? await backfillBarePdfs({
          sinceMs: Date.now() - windowHours * ONE_HOUR_MS,
          includeEmptySummary: true,
          limit: budget,
          dryRun,
        })
      : empty;
    // A bare file the window scan found but could not repair joins the
    // durable set, so it can't age out of the window before the next chance.
    if (!dryRun) {
      const windowFailed = fromWindow.outcomes.filter((o) => o.outcome === 'failed').map((o) => o.file);
      if (windowFailed.length > 0) {
        try { await queueConnection.sadd(PENDING_KEY, ...windowFailed); } catch { /* best-effort */ }
      }
    }

    const merged: BackfillResult = {
      scanned: fromSet.scanned + fromWindow.scanned,
      bare: fromSet.bare + fromWindow.bare,
      attempted: fromSet.attempted + fromWindow.attempted,
      enriched: fromSet.enriched + fromWindow.enriched,
      skippedNoText: fromSet.skippedNoText + fromWindow.skippedNoText,
      failed: fromSet.failed + fromWindow.failed,
      stoppedEarly: fromSet.stoppedEarly === 'breaker' ? 'breaker' : fromWindow.stoppedEarly,
      details: [...fromSet.details, ...fromWindow.details],
      outcomes: [...fromSet.outcomes, ...fromWindow.outcomes],
    };
    const pendingAfter = dryRun ? pending.length : (await readPending()).length;
    console.log(JSON.stringify({
      event: 'enrichment_repair_done',
      windowHours,
      dryRun,
      pendingBefore: pending.length,
      pendingAfter,
      scanned: merged.scanned,
      bare: merged.bare,
      attempted: merged.attempted,
      stoppedEarly: merged.stoppedEarly,
      enriched: merged.enriched,
      skippedNoText: merged.skippedNoText,
      failed: merged.failed,
      files: merged.details.map((d) => d.file),
      timestamp: new Date().toISOString(),
    }));
    return { ...merged, windowHours, pendingBefore: pending.length, pendingAfter };
  } finally {
    running = false;
  }
}

async function runWithNotify(): Promise<void> {
  try {
    const result = await runEnrichmentRepair();
    // Quiet when there was nothing to do; a 2-hourly "0 repaired" would be noise.
    if (result.skippedReason || (result.enriched === 0 && result.failed === 0)) return;
    const listed = result.details.slice(0, 10).map((d) => `• \`${d.file.split('/').pop()}\` — "${d.title}"`);
    if (result.details.length > 10) listed.push(`…and ${result.details.length - 10} more`);
    await sendDiscordNotification({
      type: result.failed > 0 ? 'warning' : 'info',
      title: `🩹 Enrichment repair: ${result.enriched} PDF(s) re-enriched`,
      description: listed.join('\n').slice(0, 3900) || undefined,
      fields: [
        { name: 'Bare found', value: `${result.bare}`, inline: true },
        { name: 'Failed', value: `${result.failed}`, inline: true },
        { name: 'No text', value: `${result.skippedNoText}`, inline: true },
        { name: 'Still pending', value: `${result.pendingAfter}`, inline: true },
        { name: 'Window', value: `${result.windowHours}h`, inline: true },
      ],
    });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'enrichment_repair_error',
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
  }
}

export function startEnrichmentRepair(): void {
  if (!ENABLED) {
    console.log('Enrichment repair disabled (ENRICHMENT_REPAIR_ENABLED=false)');
    return;
  }
  setBarePdfListener(registerBarePdf);
  startupTimer = setTimeout(() => {
    void runWithNotify();
    timer = setInterval(() => { void runWithNotify(); }, INTERVAL_HOURS * ONE_HOUR_MS);
  }, STARTUP_DELAY_MS);
  console.log(`Enrichment repair scheduled: every ${INTERVAL_HOURS}h over the last ${WINDOW_HOURS}h + durable pending set (first run in 10 min)`);
}

export function stopEnrichmentRepair(): void {
  setBarePdfListener(null);
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}
