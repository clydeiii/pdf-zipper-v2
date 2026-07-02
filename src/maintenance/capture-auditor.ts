/**
 * Nightly capture auditor for pdf-zipper-v2.
 *
 * The save-time quality gates (vision score + PDF content analysis) only run
 * on the Playwright conversion path. Several paths skip some or all of them:
 * manual Chrome-extension captures, pass-through PDF downloads, Karakeep PDF
 * assets, and archive.today fallback captures. A capture that LOOKS saved can
 * still be junk — an empty iframe shell, a paywall interstitial, a PDF with
 * no text layer, a video that never got enriched.
 *
 * This auditor re-checks every capture file modified in the last
 * CAPTURE_AUDIT_WINDOW_HOURS (default 24h) with save-path-independent checks:
 *
 *   PDFs (excluding .transcript.pdf sidecars, which are generated from
 *   known-good text):
 *     - analyzePdfContent must pass (lenient for `-post-` tweet captures) —
 *       catches near-zero text, error pages, firewall/paywall interstitials
 *     - Info Dict Subject must carry the source URL (Karpathy KB contract;
 *       without it Rerun and the downstream wiki both lose provenance)
 *
 *   MP4s:
 *     - embedded `summary` metadata must be present — after the silent-video
 *       fallback, every video should carry one; absence means enrichment
 *       failed and the file is opaque to the KB consumer
 *
 * Findings go to Discord so bad captures surface the same day (re-capture
 * window before the midnight bundle) instead of at KB import time on the
 * other network. Also exposed via POST /api/audit/run for on-demand sweeps.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { env } from '../config/env.js';
import { analyzePdfContent } from '../quality/pdf-content.js';
import { sendDiscordNotification } from '../notifications/discord.js';

const execFileAsync = promisify(execFile);

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/** Only files modified within this many hours are audited. */
const WINDOW_HOURS = parseInt(process.env.CAPTURE_AUDIT_WINDOW_HOURS || '24', 10);
/**
 * Local hour (0-23) of the nightly run. Default 22:00 — two hours before the
 * midnight captures bundle, so a flagged file can be re-captured and still
 * make it into tonight's zip with a fresh mtime.
 */
const RUN_HOUR = parseInt(process.env.CAPTURE_AUDIT_HOUR || '22', 10);
/** Set CAPTURE_AUDIT_ENABLED=false to disable. */
const ENABLED = process.env.CAPTURE_AUDIT_ENABLED !== 'false';
/** Max flagged files listed in the Discord embed (full list always in logs/API). */
const DISCORD_LIST_MAX = 12;

let runTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

export interface AuditFinding {
  /** Path relative to the media dir, e.g. 2026-W27/pdfs/foo.pdf */
  file: string;
  flags: string[];
}

export interface AuditResult {
  windowHours: number;
  scanned: number;
  findings: AuditFinding[];
  startedAt: string;
  elapsedMs: number;
}

function isWeekDirName(name: string): boolean {
  return /^\d{4}-W\d{2}$/.test(name);
}

/**
 * Pattern-based failures (paywall banner text, sidebar template markers) are
 * only trusted when the extracted text is ALSO short. Archive.today and
 * Chrome-extension captures interleave nav/sidebar text differently than
 * Playwright renders, so a full Bloomberg/WSJ article rescued via archive
 * still "contains" its paywall chrome — with the real body, total text runs
 * thousands of chars. Verified against 2026-W27: real bodies were 3.2-6.1k
 * chars, genuine paywall shells 0.7-1.5k.
 */
const PATTERN_FLAG_MAX_CHARS = 2500;

async function auditPdf(fullPath: string): Promise<string[]> {
  const flags: string[] = [];
  const buffer = await readFile(fullPath);

  // Tweet captures legitimately have very little text — same lenient rule the
  // conversion worker uses for Nitter posts.
  const lenient = path.basename(fullPath).includes('-post-');
  try {
    const content = await analyzePdfContent(buffer, { lenient });
    if (!content.passed) {
      const patternBased = /paywall detected|site-template marker/i.test(content.reason || '');
      if (!patternBased || content.charCount < PATTERN_FLAG_MAX_CHARS) {
        flags.push(`content: ${content.reason || 'failed content analysis'}`);
      }
    }
  } catch (err) {
    flags.push(`unreadable: ${err instanceof Error ? err.message.slice(0, 80) : 'parse error'}`);
    return flags; // no point checking metadata on an unparseable file
  }

  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    const subject = doc.getSubject();
    if (!subject || !/^https?:\/\//.test(subject.trim())) {
      flags.push('no_source_url: Subject missing — Rerun and KB provenance broken');
    }
  } catch {
    // pdf-lib being unable to load what pdf-parse could is rare; treat the
    // content result as authoritative and skip the metadata check.
  }

  return flags;
}

async function auditMp4(fullPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format_tags=summary,source_url',
      '-of', 'json',
      fullPath,
    ], { timeout: 30000 });
    const tags = (JSON.parse(stdout).format?.tags ?? {}) as Record<string, string>;
    const flags: string[] = [];
    if (!tags.summary || tags.summary.trim().length === 0) {
      flags.push('no_summary: video has no embedded summary — enrichment failed');
    }
    if (!tags.source_url || !/^https?:\/\//.test(tags.source_url)) {
      flags.push('no_source_url: video has no embedded source URL');
    }
    return flags;
  } catch (err) {
    return [`unreadable: ${err instanceof Error ? err.message.slice(0, 80) : 'ffprobe error'}`];
  }
}

/**
 * Audit every capture modified in the last `windowHours`. Never throws for
 * per-file problems — a single corrupt file becomes a finding, not a crash.
 */
export async function runCaptureAudit(windowHours: number = WINDOW_HOURS): Promise<AuditResult> {
  const startedAt = new Date();
  const mediaDir = path.join(path.resolve(env.DATA_DIR), 'media');
  const cutoffMs = startedAt.getTime() - windowHours * ONE_HOUR_MS;

  const findings: AuditFinding[] = [];
  let scanned = 0;

  let weeks: string[] = [];
  try {
    weeks = (await readdir(mediaDir)).filter(isWeekDirName);
  } catch { /* missing media dir → empty audit */ }

  for (const week of weeks) {
    const weekDir = path.join(mediaDir, week);
    let typeDirs: string[] = [];
    try { typeDirs = await readdir(weekDir); } catch { continue; }

    for (const typeDir of typeDirs) {
      const dir = path.join(weekDir, typeDir);
      let entries: string[] = [];
      try {
        if (!(await stat(dir)).isDirectory()) continue;
        entries = await readdir(dir);
      } catch { continue; }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const relPath = path.join(week, typeDir, entry);
        try {
          const s = await stat(fullPath);
          if (!s.isFile() || s.mtimeMs < cutoffMs) continue;

          const lower = entry.toLowerCase();
          let flags: string[] = [];
          if (lower.endsWith('.pdf') && !lower.endsWith('.transcript.pdf')) {
            scanned++;
            flags = await auditPdf(fullPath);
          } else if (lower.endsWith('.mp4')) {
            scanned++;
            flags = await auditMp4(fullPath);
          } else {
            continue;
          }

          if (flags.length > 0) findings.push({ file: relPath, flags });
        } catch { /* unreadable entry — skip */ }
      }
    }
  }

  return {
    windowHours,
    scanned,
    findings,
    startedAt: startedAt.toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
  };
}

/** Run an audit and post the result to Discord. Never throws. */
export async function runAuditWithNotify(): Promise<AuditResult | null> {
  try {
    console.log(JSON.stringify({ event: 'capture_audit_start', windowHours: WINDOW_HOURS, timestamp: new Date().toISOString() }));
    const result = await runCaptureAudit();
    console.log(JSON.stringify({
      event: 'capture_audit_done',
      scanned: result.scanned,
      flagged: result.findings.length,
      elapsedMs: result.elapsedMs,
      findings: result.findings,
      timestamp: new Date().toISOString(),
    }));

    if (result.findings.length === 0) {
      await sendDiscordNotification({
        type: 'info',
        title: '🔍 Capture Audit: clean',
        description: `${result.scanned} capture(s) from the last ${result.windowHours}h checked — no problems found`,
      });
    } else {
      const lines = result.findings.slice(0, DISCORD_LIST_MAX).map(
        (f) => `• \`${path.basename(f.file)}\` — ${f.flags.join('; ').slice(0, 180)}`
      );
      if (result.findings.length > DISCORD_LIST_MAX) {
        lines.push(`…and ${result.findings.length - DISCORD_LIST_MAX} more (see logs / POST /api/audit/run)`);
      }
      await sendDiscordNotification({
        type: 'warning',
        title: `🔍 Capture Audit: ${result.findings.length} suspect capture(s)`,
        description: lines.join('\n').slice(0, 3900),
        fields: [
          { name: 'Scanned', value: `${result.scanned}`, inline: true },
          { name: 'Window', value: `${result.windowHours}h`, inline: true },
        ],
      });
    }
    return result;
  } catch (err) {
    console.error(JSON.stringify({
      event: 'capture_audit_error',
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
    return null;
  }
}

/** Milliseconds from now until the next occurrence of local hour `hour`. */
function msUntilHour(hour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Schedule the nightly audit. Set CAPTURE_AUDIT_ENABLED=false to disable. */
export function startCaptureAuditor(): void {
  if (!ENABLED) {
    console.log('Capture auditor disabled (CAPTURE_AUDIT_ENABLED=false)');
    return;
  }
  const delay = msUntilHour(RUN_HOUR);
  startupTimer = setTimeout(() => {
    void runAuditWithNotify();
    runTimer = setInterval(() => { void runAuditWithNotify(); }, ONE_DAY_MS);
  }, delay);
  console.log(
    `Capture auditor scheduled: daily at ${String(RUN_HOUR).padStart(2, '0')}:00 ` +
    `(first run in ${(delay / ONE_HOUR_MS).toFixed(1)}h), window ${WINDOW_HOURS}h`
  );
}

export function stopCaptureAuditor(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
}
