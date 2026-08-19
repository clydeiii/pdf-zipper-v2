/**
 * smry.ai reader-view rescue tier.
 *
 * When the primary capture fails on an access wall (paywall/bot-wall/captcha)
 * or the site refuses our IP outright, ask smry.ai's extraction API for the
 * article text and render our own clean reader PDF — the same
 * build-our-own-document muscle as the ChatGPT-share converter. Runs BEFORE
 * the archive.today fallback: it's one authenticated HTTPS call with no
 * captcha, no clearance cookies, and no IP rate-limit circuit breaker, and
 * every capture it rescues is one less archive.today lookup (whose 429s have
 * been killing most rescues anyway).
 *
 * What smry can and cannot do (validated 2026-08-17 against real failed
 * captures): bot-walled free content (Reuters, Fortune), metered paywalls
 * (nymag), and gift links (The Atlantic) come back complete. Hard paywalls
 * (WSJ, Bloomberg, Economist) return a lede-only partial, and The Information
 * returned 28KB of raw page-config JSON. Crucially the API's own quality
 * fields are unreliable for all of these — the WSJ partial AND the JSON blob
 * both arrived as `truncated: false, qualityStatus: "usable"` — so OUR gates
 * are the only arbiter:
 *   1. machine-blob detection (the JSON-garbage case),
 *   2. a char floor ABOVE lede size (observed WSJ lede: 1,933 chars — the
 *      API gives no partial signal, so length is the only tell),
 *   3. the rendered PDF must pass analyzePdfContent like any capture.
 * A rejected rescue just falls through to archive.today / the original
 * failure, so the gates err conservative: a false reject costs nothing new,
 * a false accept silently archives a partial article as a success.
 *
 * Enabled by setting SMRY_API_KEY (paid smry Pro; 500 fresh extractions/day,
 * repeat extractions of the same URL are cache hits that don't burn budget —
 * BullMQ retries are effectively free).
 */

import type { Browser } from 'playwright';
import { env } from '../config/env.js';
import { ensureLiveBrowser } from '../utils/browser-health.js';
import { analyzePdfContent } from '../quality/pdf-content.js';

const SMRY_EXTRACT_ENDPOINT = 'https://api.smry.ai/v1/articles/extract';

/**
 * Floor for accepting smry text. Hard-paywall ledes observed at ~700-1,900
 * chars (WSJ 1,933; Economist ~1,400; Bloomberg ~700) with NO API-side
 * partial indicator; real rescued articles start ~5,000 (Reuters). 2,500
 * splits the two populations. Genuinely short announcements below the floor
 * are given up to archive.today rather than risk archiving a lede as a
 * complete capture.
 */
export const SMRY_MIN_CHARS = 2500;

const FETCH_TIMEOUT_MS = 120_000;

export interface SmryArticle {
  sourceUrl: string;
  readerUrl: string;
  title: string;
  author: string | null;
  siteName: string | null;
  publishedAt: string | null;
  language: string | null;
  content: string;
  contentCharacters: number;
  returnedCharacters: number;
  truncated: boolean;
  source: string;
  cacheHit: boolean;
  qualityStatus: string | null;
  headings: string[] | null;
}

export type SmryResult =
  | {
      ok: true;
      pdfBuffer: Buffer;
      extractedText: string;
      title: string;
      author: string | null;
      publication: string | null;
      publishDate: string | null;
      readerUrl: string;
    }
  | {
      ok: false;
      reason: 'not_configured' | 'api_error' | 'garbage' | 'insufficient' | 'content_check_failed';
      detail?: string;
    };

/**
 * Scrub extraction artifacts that leak into smry's text on some sites.
 * Observed live on Axios (2026-08-19): real article prose interleaved with
 * Tailwind arbitrary-variant class soup (`[&_h2]:mt-8 [&_p]:break-words …`)
 * and stray HTML attribute fragments (`data-chromatic="ignore">`). Without
 * scrubbing, the bracket density tripped the machine-blob gate and killed a
 * legitimate rescue; with it, the junk also stays out of the rendered PDF.
 * The patterns match syntax that never occurs in prose (`]:` inside a token,
 * `attr="…">`), at the cost of mangling inline HTML/code samples — an
 * acceptable trade on a last-resort rescue path.
 */
export function stripExtractionArtifacts(text: string): string {
  return text
    // Tailwind arbitrary-variant tokens: [&_p]:my-4, sm:[&_ul]:my-6, *:last-child]:mb-0
    .replace(/\S*\[&\S*/g, ' ')
    .replace(/\S*\]:\S*/g, ' ')
    // Stray HTML attribute fragments: data-chromatic="ignore">  (keep the prose after '>')
    .replace(/[\w-]+="[^"\n]*">?/g, ' ')
    .replace(/&\.[\w-]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * True when the "article text" is actually a machine artifact — observed:
 * The Information hands smry its page-config JSON and smry returns all 28KB
 * of it as `qualityStatus: "usable"` article content.
 */
export function looksLikeMachineBlob(text: string): boolean {
  const head = text.trimStart();
  if (/^[{[]/.test(head)) return true;
  // Config-blob punctuation density. Real prose (curly-quoted or even
  // dialogue-heavy) stays well under 2%; serialized JSON runs >10%.
  const sample = text.slice(0, 4000);
  if (sample.length < 200) return false;
  const punct = (sample.match(/[{}[\]]|":/g) || []).length;
  return punct / sample.length > 0.05;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render smry's plain text (paragraphs separated by blank lines, single
 * newlines inside a paragraph are soft breaks) as a clean reader document.
 * Paragraphs that exactly match one of smry's reported headings render as
 * section headings. Exported for testing.
 */
export function buildSmryHtml(article: Pick<SmryArticle, 'title' | 'author' | 'siteName' | 'publishedAt' | 'content' | 'headings' | 'sourceUrl'>): string {
  const headingSet = new Set((article.headings || []).map((h) => h.trim()).filter(Boolean));
  const paragraphs = article.content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const inner = escapeHtml(p).replace(/\n/g, '<br>');
      return headingSet.has(p) ? `<h2>${inner}</h2>` : `<p>${inner}</p>`;
    })
    .join('\n');

  const bylineParts = [article.author, article.siteName].filter(Boolean) as string[];
  let dateStr = '';
  if (article.publishedAt) {
    const d = new Date(article.publishedAt);
    dateStr = Number.isNaN(d.getTime()) ? article.publishedAt : d.toISOString().slice(0, 10);
  }
  if (dateStr) bylineParts.push(dateStr);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 42em; margin: 0 auto; color: #1a1a1a; line-height: 1.55; font-size: 12.5pt; }
  h1 { font-size: 21pt; line-height: 1.2; margin: 0 0 6pt; }
  h2 { font-size: 14pt; margin: 16pt 0 4pt; }
  .byline { color: #555; font-size: 10.5pt; margin: 0 0 2pt; }
  .source { color: #888; font-size: 8.5pt; word-break: break-all; margin: 0 0 10pt; }
  hr { border: none; border-top: 1px solid #ddd; margin: 10pt 0 14pt; }
  p { margin: 0 0 9pt; }
  .provenance { color: #999; font-size: 8pt; margin-top: 18pt; border-top: 1px solid #eee; padding-top: 6pt; }
</style></head><body>
<h1>${escapeHtml(article.title)}</h1>
${bylineParts.length ? `<div class="byline">${escapeHtml(bylineParts.join(' · '))}</div>` : ''}
<div class="source">${escapeHtml(article.sourceUrl)}</div>
<hr>
${paragraphs}
<div class="provenance">Reader-view text extracted via smry.ai — original page layout and most images not preserved.</div>
</body></html>`;
}

/**
 * Attempt a reader-view rescue of `originalUrl` via smry.ai.
 * Never throws; every failure mode returns ok:false with a reason so the
 * worker can fall through to the archive.today tier.
 */
export async function captureViaSmry(originalUrl: string): Promise<SmryResult> {
  if (!env.SMRY_API_KEY) {
    return { ok: false, reason: 'not_configured' };
  }

  let article: SmryArticle;
  try {
    const res = await fetch(SMRY_EXTRACT_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SMRY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: originalUrl }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: 'api_error', detail: `smry HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const parsed = (await res.json()) as { article?: SmryArticle };
    if (!parsed.article || typeof parsed.article.content !== 'string') {
      return { ok: false, reason: 'api_error', detail: 'smry response missing article.content' };
    }
    article = parsed.article;
  } catch (err) {
    return { ok: false, reason: 'api_error', detail: err instanceof Error ? err.message : String(err) };
  }

  const text = stripExtractionArtifacts(article.content).trim();
  if (looksLikeMachineBlob(text)) {
    return { ok: false, reason: 'garbage', detail: `smry content is a machine blob (${text.length} chars, starts ${JSON.stringify(text.slice(0, 40))})` };
  }
  if (text.length < SMRY_MIN_CHARS) {
    return { ok: false, reason: 'insufficient', detail: `smry returned ${text.length} chars (< ${SMRY_MIN_CHARS}) — likely a hard-paywall lede` };
  }

  // Render our own document and run it through the same content checks as any
  // primary capture — this also catches paywall chrome the blob/length gates miss.
  const browser: Browser = await ensureLiveBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    // Render from the scrubbed text so extraction artifacts stay out of the PDF.
    await page.setContent(buildSmryHtml({ ...article, content: text }), { waitUntil: 'load' });
    const pdfBuffer = Buffer.from(await page.pdf({
      format: 'A4',
      margin: { top: '14mm', bottom: '14mm', left: '13mm', right: '13mm' },
      printBackground: true,
    }));

    const content = await analyzePdfContent(pdfBuffer, { sourceUrl: originalUrl });
    if (!content.passed) {
      return { ok: false, reason: 'content_check_failed', detail: content.reason };
    }

    return {
      ok: true,
      pdfBuffer,
      extractedText: text,
      title: article.title,
      author: article.author,
      publication: article.siteName,
      publishDate: article.publishedAt,
      readerUrl: article.readerUrl || 'https://smry.ai',
    };
  } catch (err) {
    return { ok: false, reason: 'api_error', detail: `render failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await ctx.close().catch(() => {});
  }
}
