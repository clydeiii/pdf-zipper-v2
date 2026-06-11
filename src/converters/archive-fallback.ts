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

const ARCHIVE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/** Minimum main-document text for a snapshot to count as real article content. */
const GOOD_TEXT_THRESHOLD = 1500;

/** Markers that mean the snapshot is a broken/incomplete capture, not content. */
const BROKEN_MARKERS: RegExp[] = [
  /task timed-?out/i,
  /0%\s+10%\s+20%/, // archive.today capture progress bar
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
  | { ok: true; pdfBuffer: Buffer; extractedText: string; snapshotUrl: string }
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
export async function captureViaArchive(originalUrl: string): Promise<ArchiveResult> {
  const browser: Browser = await initBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: ARCHIVE_UA,
  });
  const cookies = loadCookies();
  if (cookies.length > 0) await ctx.addCookies(cookies);

  try {
    const page = await ctx.newPage();
    const clean = cleanForArchive(originalUrl);
    const listUrl = `https://archive.is/${clean}`;

    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // If the listing page itself is a Cloudflare/archive wall, our cookies are stale.
    const listText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (WALL_MARKERS.some((m) => m.test(listText)) && listText.length < 1500) {
      return { ok: false, reason: 'wall', detail: 'archive.is challenge — clearance cookies likely stale' };
    }

    // Collect candidate snapshots: either a direct redirect to one, or listing links.
    let snapshots: string[] = [];
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

        // Strip archive.today's own toolbar/chrome so the PDF is just the article.
        await page.evaluate(() => {
          // archive.today injects its UI as the first elements of <body>; remove
          // any top-level node whose text is the archive toolbar.
          const markers = ['archive.today webpage capture', 'Saved from history', 'report bug or abuse'];
          for (const el of [...document.body.children]) {
            const t = (el.textContent || '').slice(0, 200);
            if (markers.some((m) => t.includes(m)) && t.length < 600) el.remove();
          }
          // Known archive.today chrome ids/classes (best-effort).
          ['#HEADER', '#TOOLBAR', '#globalheader', '.SOLID', '#streams'].forEach((sel) => {
            document.querySelectorAll(sel).forEach((e) => {
              if ((e.textContent || '').length < 800) (e as HTMLElement).style.display = 'none';
            });
          });
        }).catch(() => { /* best-effort chrome removal */ });

        await page.emulateMedia({ media: 'screen' }).catch(() => {});
        const pdf = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
          preferCSSPageSize: false,
          scale: 0.7,
        });
        return { ok: true, pdfBuffer: Buffer.from(pdf), extractedText: text, snapshotUrl: snap };
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
