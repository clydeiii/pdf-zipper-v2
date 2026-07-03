/**
 * archive.is / archive.today paywall fallback.
 *
 * When the primary capture of a hard-paywalled article fails (WSJ/FT/Bloomberg
 * etc.), try to capture an EXISTING archive.today snapshot instead. archive.is
 * hard-blocks automation with a Cloudflare 429 + captcha, so this only works
 * when fresh archive.is clearance cookies (cf_clearance + Hst*) are present in
 * COOKIES_FILE — the user solves the captcha in-browser and exports cookies.txt
 * (cf_clearance is ~1-day TTL + IP-bound, so it needs periodic refresh).
 *
 * Access model (do NOT use archive.is/newest/<url> — it can trigger a fresh
 * LIVE capture that hangs ~15s):
 *   - https://archive.is/<clean-url>  → listing of existing snapshot permalinks
 *     (newest first), or a direct redirect to the snapshot when only one exists,
 *     or an empty result when never archived.
 *   - https://archive.is/<id>         → a single snapshot. A GOOD snapshot renders
 *     the captured article text directly in the main document (thousands of
 *     chars). A BROKEN one (403 origin, incomplete/timed-out capture) is ~300
 *     chars of archive.today chrome, often carrying a capture-progress marker.
 *
 * Gated behind env.ARCHIVE_FALLBACK_ENABLED; off by default so it can never
 * affect the proven primary pipeline until explicitly turned on.
 */

import type { Browser } from 'playwright';
import { initBrowser } from '../browsers/manager.js';
import { loadCookies } from '../browsers/cookies.js';
import { convertUrlToPDF } from './pdf.js';

const ARCHIVE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/**
 * archive.today binds its clearance cookies to the browser that solved the
 * captcha — same cookies presented under a different User-Agent get challenged
 * again (observed 2026-07-02: fresh human-solved cookies + this hardcoded UA
 * → challenge on every mirror, same home IP). The manual-capture route stores
 * the user's real Chrome UA in Redis on every extension capture; presenting
 * exactly that UA makes the exported cookies validate. Falls back to the
 * hardcoded UA until the first extension capture teaches us.
 */
export const BROWSER_UA_REDIS_KEY = 'pdfzipper:browser_ua';

async function resolveArchiveUa(): Promise<string> {
  try {
    // Lazy import: a top-level redis import opens a connection the moment any
    // consumer (including the unit tests) loads this module, hanging the test
    // runner's event loop.
    const { queueConnection } = await import('../config/redis.js');
    const learned = await queueConnection.get(BROWSER_UA_REDIS_KEY);
    if (learned && /^Mozilla\/5\.0 [\x20-\x7e]{10,300}$/.test(learned)) return learned;
  } catch { /* redis hiccup — fall through */ }
  return ARCHIVE_UA;
}

/** Minimum main-document text for a snapshot to count as real article content. */
const GOOD_TEXT_THRESHOLD = 1500;

/**
 * Markers that mean the snapshot is a broken/incomplete capture, not content.
 * NOTE: do NOT match the "0% 10% 20%" capture-progress bar — archive.today
 * embeds that widget's text in the innerText of EVERY snapshot page (complete
 * ones included), so it false-positives good captures. The real signal for an
 * incomplete capture is "task timed-out"; broken/empty captures are also caught
 * by the GOOD_TEXT_THRESHOLD length check.
 */
const BROKEN_MARKERS: RegExp[] = [
  /task timed-?out/i,
  /\b403\s+forbidden\b/i,
  /\berror\s+1020\b/i, // Cloudflare access denied on the archived origin
  /\baccess denied\b/i,
];

/** Cloudflare/archive wall signatures — means our clearance cookies are stale. */
const WALL_MARKERS: RegExp[] = [
  /just a moment/i,
  /verify you are human/i,
  /hcaptcha/i,
  /checking your browser/i,
  /enable javascript and cookies/i,
  /attention required/i,
];

export type ArchiveResult =
  | { ok: true; pdfBuffer: Buffer; extractedText: string; snapshotUrl: string; pageTitle?: string }
  | { ok: false; reason: 'not_archived' | 'broken' | 'wall' | 'error'; detail?: string };

/** Strip query + fragment for the archive.is lookup (matches the archive.is button). */
export function cleanForArchive(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/** True when a URL is itself an archive.today snapshot permalink (5-char id or timestamped). */
export function isSnapshotUrl(url: string): boolean {
  if (/\/(newest|oldest)\//.test(url)) return false;
  // Permalink: archive.<tld>/<4-6 id> at END of string; or timestamped:
  // archive.<tld>/20<12 digits>/<original-url>. A listing URL like
  // archive.is/https://... must NOT match (hence the end-anchor on the id).
  return /https?:\/\/archive\.(is|ph|today|li|md|vn|fo)\/\w{4,6}\/?$/.test(url) ||
    /https?:\/\/archive\.(is|ph|today|li|md|vn|fo)\/20\d{12}\//.test(url);
}

/** Classify a snapshot's extracted main-document text. */
export function classifySnapshotText(text: string): 'good' | 'broken' | 'wall' {
  if (WALL_MARKERS.some((m) => m.test(text))) return 'wall';
  if (text.trim().length < GOOD_TEXT_THRESHOLD) return 'broken';
  if (BROKEN_MARKERS.some((m) => m.test(text))) return 'broken';
  return 'good';
}

/**
 * Attempt to capture an existing archive.today snapshot of `originalUrl`.
 * Returns ok:false with a specific reason when no usable snapshot exists.
 */
/**
 * Circuit breaker: archive.today 429s the egress IP after bursts of lookups
 * (observed 2026-07-02: both .is and .ph serving HTTP 429 + CAPTCHA after an
 * afternoon of rescues). Hitting it again during the block only extends it.
 * When a listing request comes back 429, skip archive entirely for a while.
 */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
let archiveCooldownUntil = 0;

export async function captureViaArchive(originalUrl: string): Promise<ArchiveResult> {
  if (Date.now() < archiveCooldownUntil) {
    const minLeft = Math.ceil((archiveCooldownUntil - Date.now()) / 60000);
    return { ok: false, reason: 'error', detail: `archive.today rate-limited this IP — cooling down ${minLeft} more min` };
  }
  const browser: Browser = await initBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: await resolveArchiveUa(),
  });
  const cookies = loadCookies();
  if (cookies.length > 0) await ctx.addCookies(cookies);

  try {
    const page = await ctx.newPage();
    const clean = cleanForArchive(originalUrl);

    // archive.today serves the same archive on several mirror TLDs and has
    // historically lost/rotated them. Clearance cookies are per-domain, so a
    // wall on one mirror doesn't imply the others are walled — try each in
    // turn on nav failure or challenge. (COOKIES_FILE carries clearance for
    // .is/.ph/.today; Playwright sends whichever matches the mirror.)
    const ENTRY_HOSTS = ['archive.is', 'archive.ph', 'archive.today'];
    let snapshots: string[] = [];
    let sawWall = false;
    let reachedListing = false;
    for (const host of ENTRY_HOSTS) {
      let listResponse;
      try {
        listResponse = await page.goto(`https://${host}/${clean}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        continue; // mirror down/blocked — try the next one
      }

      // HTTP 429 = IP rate limit, NOT stale cookies. All mirrors share the
      // block (same backend), so trip the breaker instead of trying the rest —
      // more requests only extend the ban.
      if (listResponse && listResponse.status() === 429) {
        archiveCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        console.warn(`[archive-fallback] ${host} returned 429 — cooling down ${RATE_LIMIT_COOLDOWN_MS / 60000}min`);
        return { ok: false, reason: 'error', detail: `archive.today rate-limited this IP (429) — cooling down ${RATE_LIMIT_COOLDOWN_MS / 60000}min` };
      }
      await page.waitForTimeout(3000);

      // If the listing page itself is a Cloudflare/archive wall, clearance for
      // THIS mirror is stale — another mirror's cookies may still be good.
      const listText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (WALL_MARKERS.some((m) => m.test(listText)) && listText.length < 1500) {
        sawWall = true;
        continue;
      }

      reachedListing = true;
      // Collect candidate snapshots: either a direct redirect to one, or listing links.
      if (isSnapshotUrl(page.url())) {
        snapshots = [page.url()];
      } else {
        snapshots = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a')]
            .map((a) => (a as HTMLAnchorElement).href)
            .filter((h) => /archive\.(is|ph|today)\/\w{4,6}$/.test(h));
          return [...new Set(links)];
        });
      }
      break;
    }

    if (!reachedListing) {
      if (sawWall) {
        return { ok: false, reason: 'wall', detail: 'archive challenge on all mirrors — clearance cookies likely stale' };
      }
      return { ok: false, reason: 'error', detail: 'all archive.today mirrors unreachable' };
    }

    if (snapshots.length === 0) {
      return { ok: false, reason: 'not_archived' };
    }

    // Try the newest few (listing is newest-first); first good one wins.
    for (const snap of snapshots.slice(0, 3)) {
      try {
        await page.goto(snap, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(6000); // archive snapshots can be heavy
        const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        const verdict = classifySnapshotText(text);
        if (verdict === 'wall') {
          return { ok: false, reason: 'wall', detail: 'archive.is challenge on snapshot — cookies stale' };
        }
        if (verdict !== 'good') continue;

        // Render the validated snapshot through the main converter: it already
        // hides nav/sticky/toolbar chrome (incl. archive.today's bar), forces
        // article content visible, and has the blank-print fallback. Hand-rolled
        // page.pdf here produced near-empty PDFs, so delegate.
        const rendered = await convertUrlToPDF(snap);
        if (rendered.success && rendered.pdfBuffer.length >= 5000) {
          // Carry the snapshot's real headline so enrichment can anchor the
          // title to it (archive.today preserves the original page <title>).
          return { ok: true, pdfBuffer: rendered.pdfBuffer, extractedText: text, snapshotUrl: snap, pageTitle: rendered.pageTitle };
        }
        // Render came back blank despite good snapshot text — try the next one.
        continue;
      } catch {
        continue; // try the next snapshot
      }
    }

    return { ok: false, reason: 'broken' };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await ctx.close().catch(() => {});
  }
}
