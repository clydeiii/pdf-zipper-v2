import { ensureLiveBrowser } from '../utils/browser-health.js';
import { loadCookies } from '../browsers/cookies.js';
import { env } from '../config/env.js';
import { extractJsonLdArticleBody } from './jsonld-body.js';
import type { PDFOptions, PDFResult, PDFPassthroughResult } from './types.js';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function readResponseBufferWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    throw new Error('Response body is empty');
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Download exceeded ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

/**
 * Check if a URL points directly to a PDF file
 * Checks URL path extension and known PDF URL patterns
 * Actual Content-Type check happens during fetch as verification
 */
export function isPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();

    // Direct .pdf extension
    if (path.endsWith('.pdf')) {
      return true;
    }

    // Known PDF URL patterns
    // arxiv.org/pdf/XXXX.XXXXX (no .pdf extension)
    if (host === 'arxiv.org' && path.startsWith('/pdf/')) {
      return true;
    }

    // arxiv.org/abs/XXXX.XXXXX — abstract page, but we want the PDF
    if (host === 'arxiv.org' && path.startsWith('/abs/')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Rewrite known abstract/landing page URLs to their direct PDF equivalents.
 * Returns the original URL if no rewrite is applicable.
 *
 * Currently handles:
 * - arxiv.org/abs/XXXX.XXXXX → arxiv.org/pdf/XXXX.XXXXX
 * - arxiv.org/html/XXXX.XXXXX → arxiv.org/pdf/XXXX.XXXXX
 */
export function rewriteToPdfUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host === 'arxiv.org') {
      // /abs/2506.12345 → /pdf/2506.12345
      // /html/2506.12345v2 → /pdf/2506.12345v2
      const absMatch = parsed.pathname.match(/^\/(abs|html)\/(.+)/);
      if (absMatch) {
        const pdfUrl = `https://arxiv.org/pdf/${absMatch[2]}`;
        console.log(`Rewriting arxiv URL: ${url} → ${pdfUrl}`);
        return pdfUrl;
      }
    }

    return url;
  } catch {
    return url;
  }
}

/**
 * Download a PDF directly (pass-through mode)
 * Used for URLs that point directly to PDF files (e.g., arxiv.org/pdf/...)
 *
 * @param url - Direct URL to PDF file
 * @returns PDF buffer and metadata
 */
export async function downloadPdfDirect(url: string): Promise<PDFPassthroughResult> {
  try {
    console.log(`PDF pass-through: downloading ${url}`);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(env.DIRECT_DOWNLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        success: false,
        url,
        error: `HTTP ${response.status}: ${response.statusText}`,
        reason: 'download_failed',
      };
    }

    // Verify it's actually a PDF
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/pdf') && !url.toLowerCase().endsWith('.pdf')) {
      return {
        success: false,
        url,
        error: `Not a PDF: Content-Type is ${contentType}`,
        reason: 'not_pdf',
      };
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > env.MAX_DIRECT_PDF_BYTES) {
      return {
        success: false,
        url,
        error: `PDF too large: ${contentLength} bytes exceeds ${env.MAX_DIRECT_PDF_BYTES}`,
        reason: 'download_failed',
      };
    }

    const pdfBuffer = await readResponseBufferWithLimit(response, env.MAX_DIRECT_PDF_BYTES);

    // Try to extract title from Content-Disposition header
    let suggestedFilename: string | undefined;
    const contentDisposition = response.headers.get('content-disposition');
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (filenameMatch) {
        suggestedFilename = filenameMatch[1].replace(/['"]/g, '');
      }
    }

    console.log(`PDF pass-through complete: ${pdfBuffer.length} bytes`);

    return {
      success: true,
      pdfBuffer,
      url,
      size: pdfBuffer.length,
      suggestedFilename,
      isPassthrough: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`PDF pass-through failed for ${url}: ${message}`);
    return {
      success: false,
      url,
      error: message,
      reason: 'download_failed',
    };
  }
}

/**
 * Raw DOM facts about embedded-PDF viewers, collected in-page. URL resolution
 * and the final pick happen Node-side in pickEmbeddedPdfUrl so the logic is
 * unit-testable (page.evaluate callbacks can't share code with the module).
 */
export interface EmbeddedPdfScan {
  /** <embed>/<object>/<iframe> elements that look like PDF viewers */
  embeds: Array<{
    /** src/data attribute as written (may be relative) */
    raw: string;
    /** element declared type="application/pdf" */
    isPdfType: boolean;
    /** viewer-sized box (not an icon/tracking pixel) */
    large: boolean;
  }>;
  /** hrefs of anchors that point at .pdf files (prefiltered in-page) */
  pdfAnchorHrefs: string[];
  /** page has a viewer-sized <canvas> (PDF.js-style viewers render into canvas) */
  hasViewerCanvas: boolean;
}

/**
 * Pick the source PDF URL for a page whose primary content is an embedded PDF
 * viewer, or undefined when the page has no such viewer.
 *
 * Native <embed>/<object>/<iframe> viewers count on their own. A bare .pdf
 * download link only counts when a viewer-sized canvas is present (PDF.js-style
 * viewers, e.g. xbow.com whitepapers) — an article that merely links a PDF in
 * its prose must never match, since the worker would otherwise swap a failing
 * article capture for the wrong document.
 */
export function pickEmbeddedPdfUrl(scan: EmbeddedPdfScan, pageUrl: string): string | undefined {
  const absolutize = (raw: string): URL | null => {
    try {
      const abs = new URL(raw, pageUrl);
      return abs.protocol === 'http:' || abs.protocol === 'https:' ? abs : null;
    } catch {
      return null;
    }
  };
  const isPdfPath = (u: URL) => /\.pdf$/i.test(u.pathname);

  for (const embed of scan.embeds) {
    if (!embed.large) continue;
    const abs = absolutize(embed.raw);
    if (!abs) continue;
    if (embed.isPdfType || isPdfPath(abs)) return abs.toString();
  }

  if (scan.hasViewerCanvas) {
    for (const raw of scan.pdfAnchorHrefs) {
      const abs = absolutize(raw);
      if (abs && isPdfPath(abs)) return abs.toString();
    }
  }

  return undefined;
}

/**
 * Check if a URL is a Substack URL
 */
/**
 * Consent-banner button matching, word-bounded.
 *
 * The accept-click selectors all scope to a cookie/consent container, and the
 * old test was `text.includes('ok')` — which "co-**ok**-ie" satisfies. So on
 * any CMP offering a settings button we clicked *that*, opening the
 * preferences modal immediately before printing and leaving a larger overlay
 * than the banner we set out to dismiss. Sources are passed into the in-page
 * evaluate; kept at module scope so the semantics are unit-testable.
 */
export const CONSENT_ACCEPT_RE =
  /\b(accept|agree|ok|okay|got it|dismiss|allow all|understand)\b/;
export const CONSENT_NOT_ACCEPT_RE =
  // "Accept only necessary" is a reject button wearing an accept word, and CMPs
  // write it in both orders — match the words independently rather than as a
  // fixed phrase.
  /\b(settings|preferences|manage|customi[sz]e|options|reject|decline|deny|more info|learn more|necessary|essential)\b/;

/** True when a consent-banner button label means "accept". Exported for testing. */
export function isConsentAcceptLabel(label: string): boolean {
  const text = (label || '').toLowerCase().trim();
  return CONSENT_ACCEPT_RE.test(text) && !CONSENT_NOT_ACCEPT_RE.test(text);
}

function isSubstackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    // Substack uses both substack.com subdomains and custom domains with /p/ paths
    return host.endsWith('.substack.com') || parsed.pathname.startsWith('/p/');
  } catch {
    return false;
  }
}

/**
 * Rewrite Substack reader-wrapper URLs to the canonical publication URL.
 *
 * Share links from the Substack iOS/Android app and the web reader use the
 * `open.substack.com/pub/<PUB>/p/<SLUG>` form. That host serves Substack's
 * heavy reader SPA (floating audio player, an infinite "recommendations" feed,
 * comment rail) rather than the plain article page — its runaway scrollHeight
 * and continuous JS make Chromium's printToPDF hang until PDF_TIMEOUT_MS
 * (real case: a lironshapira post timed out at 90s in page.pdf()). The
 * canonical `https://<PUB>.substack.com/p/<SLUG>` renders as a normal article
 * that paginates cleanly. Also yields better filenames + cookie matching, same
 * rationale as short-URL expansion. Returns the original URL if not a reader link.
 */
function rewriteSubstackReaderUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'open.substack.com') return url;

    // /pub/<PUB>/p/<SLUG>  (PUB is the publication subdomain)
    const match = parsed.pathname.match(/^\/pub\/([^/]+)\/p\/([^/]+)\/?$/);
    if (!match) return url;

    const [, pub, slug] = match;
    const canonical = `https://${pub}.substack.com/p/${slug}${parsed.search}`;
    console.log(`Rewriting Substack reader URL: ${url} → ${canonical}`);
    return canonical;
  } catch {
    return url;
  }
}

/**
 * Clean Substack URLs by removing email tracking parameters
 * These params (especially 'r') cause "I've Shared This With Myself" popups
 */
function cleanSubstackUrl(url: string): string {
  if (!isSubstackUrl(url)) {
    return url;
  }

  try {
    const parsed = new URL(url);

    // Parameters to remove (email tracking that causes popups)
    const paramsToRemove = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      'r',              // Referral code - causes "I've Shared This" popup
      's',              // Share code
      'publication_id', // Internal tracking
      'post_id',        // Internal tracking
      'isFreemail',     // Email tracking
      'triedRedirect',  // Email tracking
    ];

    for (const param of paramsToRemove) {
      parsed.searchParams.delete(param);
    }

    const cleanedUrl = parsed.toString();
    if (cleanedUrl !== url) {
      console.log(`Cleaned Substack URL: ${url} → ${cleanedUrl}`);
    }
    return cleanedUrl;
  } catch {
    return url;
  }
}

/**
 * Check if a URL is a Twitter/X URL
 */
function isTwitterUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase()
      .replace(/^www\./, '')
      .replace(/^(?:mobile|m)\./, '');
    return host === 'x.com' || host === 'twitter.com';
  } catch {
    return false;
  }
}

/**
 * Rewrite Datawrapper wrapper URLs to direct CDN embed URLs
 * The wrapper page (datawrapper.de/_/XXXXX/) renders the visualization inside
 * a narrow iframe with nav/footer chrome. The CDN embed URL renders the bare
 * visualization at full viewport width.
 *
 * datawrapper.de/_/vAWlE/ → datawrapper.dwcdn.net/vAWlE/
 */
function rewriteDatawrapperUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'datawrapper.de') return url;

    // Extract chart ID from path: /_/XXXXX/ or /_/XXXXX
    const match = parsed.pathname.match(/^\/_\/([A-Za-z0-9]+)/);
    if (!match) return url;

    const chartId = match[1];
    const embedUrl = `https://datawrapper.dwcdn.net/${chartId}/`;
    console.log(`Rewriting Datawrapper URL: ${url} → ${embedUrl}`);
    return embedUrl;
  } catch {
    return url;
  }
}

/**
 * Rewrite legacy Qwen GitHub Pages blog URLs to the current qwen.ai post URL.
 *
 * A legacy post that still exists there serves a 5s meta-refresh to
 * qwen.ai/blog?id=<slug>, keeping the slug — Playwright finishes before the
 * refresh fires, so those already captured fine. The failure is a slug that
 * has since been retired: GitHub Pages 404s, and the site's own 404 page
 * refreshes to qwen.ai/research instead — a near-empty index that fails the
 * truncation check with ~90 chars of nav text.
 *
 * Rewriting up front takes both cases straight to the canonical post, which
 * the pipeline handles end to end (scroll-pane un-pin, query-string filename,
 * h1 title fallback). Only `targetUrl` is rewritten, so the PDF's Subject
 * keeps the URL the user actually bookmarked.
 */
export function rewriteQwenBlogUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'qwenlm.github.io') return url;

    const match = parsed.pathname.match(/^\/(?:zh\/)?blog\/([^/]+)\/?$/);
    if (!match) return url;

    const rewritten = `https://qwen.ai/blog?id=${match[1]}`;
    console.log(`Rewriting legacy Qwen blog URL: ${url} → ${rewritten}`);
    return rewritten;
  } catch {
    return url;
  }
}

/**
 * Known short URL / redirect domains that should be expanded before capture
 * These services redirect to the real URL, which we want for:
 * 1. Better filenames (based on final domain, not t.co)
 * 2. Proper cookie matching (cookies are domain-scoped)
 * 3. Correct deduplication (two t.co links may point to same article)
 */
const SHORT_URL_HOSTS = new Set([
  't.co',
  'apple.news',
  'bit.ly',
  'tinyurl.com',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'dlvr.it',
  'flip.it',
  'shar.es',
  'lnkd.in',
  'rb.gy',
]);

/**
 * Check if a URL is a known short/redirect URL that should be expanded
 */
function isShortUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SHORT_URL_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Expand a short URL by following redirects
 * Uses HEAD for most services, GET for apple.news (which uses JS/HTML redirects)
 * Returns the final URL after all redirects, or the original if expansion fails
 */
async function expandShortUrl(url: string): Promise<string> {
  if (!isShortUrl(url)) return url;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    console.log(`Expanding short URL: ${url}`);

    // apple.news uses HTML/JS redirects — need to GET the page and parse the redirect URL
    if (host === 'apple.news') {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(10000),
      });
      const html = await response.text();
      // apple.news embeds the real URL as a link in the page
      const linkMatch = html.match(/href="(https?:\/\/(?!www\.apple\.com)[^"]+)"/);
      if (linkMatch) {
        console.log(`Expanded apple.news URL: ${url} → ${linkMatch[1]}`);
        return linkMatch[1];
      }
    }

    // For all other short URL services, HEAD request follows HTTP redirects
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });
    const finalUrl = response.url;
    if (finalUrl && finalUrl !== url) {
      console.log(`Expanded short URL: ${url} → ${finalUrl}`);
      return finalUrl;
    }
  } catch (error) {
    console.warn(`Failed to expand short URL ${url}: ${error instanceof Error ? error.message : error}`);
  }
  return url;
}

/**
 * Get privacy filter terms from environment
 * Returns array of lowercase terms to filter out
 */
function getPrivacyFilterTerms(): string[] {
  const terms = env.PRIVACY_FILTER_TERMS;
  if (!terms) return [];
  return terms.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
}

/**
 * Apply privacy filtering by hiding elements containing specified terms
 * Runs in-page JS to find and hide matching elements
 */
/**
 * The substring class selectors from the injected print stylesheet's
 * modal/overlay and CTA/paywall hide groups (keep in sync with that CSS).
 * They match on the class ATTRIBUTE, and Tailwind arbitrary variants put
 * selectors inside class names: axios.com's story container carries
 * `[&:has(#piano-container…)~.gated-content]:hidden` and
 * `[&_#paywall-fallback-container]:relative`, so `[class*="gate"]` and
 * `[class*="paywall"]` hid the entire article body (2026-09-03: 921-char
 * "successful" capture of headline + hero, story gone). No string tweak
 * survives the next such class, so after injection a content guard restores
 * any matched element that holds the bulk of the page's text — a CTA never
 * does, an article body always does.
 */
const CONTENT_GUARDED_HIDE_SELECTORS = [
  '[class*="modal"]', '[class*="overlay"]', '[class*="popup"]', '[class*="dialog"]',
  '[class*="pc-modal"]', '[class*="gh-post-upgrade"]', '[class*="subscribe-form"]',
  '[class*="outpost-cta"]', '[class*="outpost-subscribe"]', '[class*="outpost-slideup"]',
  '[class*="outpost-pub-container"]', '[class*="footer-cta"]', '[class*="beehiiv"]',
  '[class*="paywall"]', '[class*="subscribe-prompt"]', '[class*="subscription-prompt"]',
  '[class*="newsletter-signup"]', '[class*="email-signup"]', '[class*="signup-modal"]',
  '[class*="signup-overlay"]', '[class*="gate"]', '[class*="Gate"]',
];

/**
 * Phase tracer (CAPTURE_PHASE_TRACE=1): logs the page's visible text length
 * at each in-page phase boundary, so a capture that prints a body-less shell
 * can be bisected to the phase that dropped the body (axios.com, 2026-09-03:
 * the DOM held the full story at navigation but the PDF kept only sidebars).
 * Off by default — one extra evaluate per boundary when on.
 */
const PHASE_TRACE = process.env.CAPTURE_PHASE_TRACE === '1';
async function tracePhase(page: import('playwright').Page, url: string, label: string): Promise<void> {
  if (!PHASE_TRACE) return;
  const len = await page
    .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length)
    .catch(() => -1);
  console.log(`[phase-trace] ${label}: bodyText=${len} ${url}`);
}

async function applyPrivacyFilter(page: import('playwright').Page): Promise<void> {
  const terms = getPrivacyFilterTerms();
  if (terms.length === 0) return;

  console.log(`Applying privacy filter for ${terms.length} terms`);

  await page.evaluate((filterTerms: string[]) => {
    // Guard: createTreeWalker throws "parameter 1 is not of type 'Node'" when
    // document.body is null (some pages — e.g. certain Forbes renders — briefly
    // have no <body> at the moment this runs, or the doc was replaced). An
    // unhandled throw here aborts the whole conversion, so bail cleanly instead.
    if (!document.body) return;

    // Find all text nodes and check for matches
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );

    const elementsToHide = new Set<Element>();

    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.toLowerCase() || '';
      for (const term of filterTerms) {
        if (text.includes(term)) {
          // Find the closest meaningful parent element to hide
          let parent = node.parentElement;
          while (parent && parent !== document.body) {
            // Stop at block-level elements or elements that seem like containers
            const tag = parent.tagName.toLowerCase();
            const display = window.getComputedStyle(parent).display;
            if (
              display === 'block' ||
              display === 'flex' ||
              display === 'grid' ||
              ['div', 'span', 'p', 'li', 'a', 'section', 'article', 'aside'].includes(tag)
            ) {
              // Don't hide the main content containers
              if (!parent.classList.contains('main-tweet') &&
                  !parent.classList.contains('tweet-body') &&
                  !parent.classList.contains('timeline-item')) {
                elementsToHide.add(parent);
              }
              break;
            }
            parent = parent.parentElement;
          }
          break;
        }
      }
    }

    // Hide matching elements
    for (const el of elementsToHide) {
      (el as HTMLElement).style.display = 'none';
    }
  }, terms);
}

/**
 * Rewrite Twitter/X URLs to use Nitter for better PDF capture
 * Nitter provides cleaner rendering and includes reply threads
 *
 * @param url - Original URL
 * @returns Rewritten URL (or original if not Twitter/X)
 */
function rewriteTwitterUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Check if it's a Twitter/X URL
    if (host === 'x.com' || host === 'twitter.com' || host === 'www.x.com' || host === 'www.twitter.com') {
      // Rewrite to Nitter: keep the path (e.g., /user/status/123)
      const nitterUrl = `${env.NITTER_HOST}${parsed.pathname}`;
      console.log(`Rewriting Twitter URL: ${url} → ${nitterUrl}`);
      return nitterUrl;
    }
  } catch {
    // URL parsing failed, return original
  }
  return url;
}

/**
 * Convert a URL to a PDF buffer
 *
 * Handles navigation timeouts, bot detection, and other errors gracefully by
 * returning failure results instead of throwing exceptions.
 *
 * Always closes the browser context to prevent memory leaks.
 *
 * @param url - The URL to convert to PDF
 * @param options - PDF conversion options
 * @returns Promise resolving to either a success or failure result
 */
export async function convertUrlToPDF(
  url: string,
  options: PDFOptions = {}
): Promise<PDFResult> {
  // Extract options with defaults
  // Note: 60s timeout for SPA-heavy sites (OpenAI, etc)
  const {
    timeout = env.NAV_TIMEOUT_MS,
    pdfTimeout = env.PDF_TIMEOUT_MS,
    waitAfterLoad = 1000,
    format = 'A4',
    margin = { top: '20px', right: '20px', bottom: '20px', left: '20px' }
  } = options;

  // Get browser (lazy init) and create context
  // Use 1280px viewport for rendering (sites may not render properly at narrow widths)
  // The PDF will scale content to fit A4
  const browser = await ensureLiveBrowser();
  // UA version must track the running Chromium: Sec-CH-UA client hints are
  // emitted from the real browser version, so a hardcoded stale major (e.g.
  // Chrome/120 on a 145 binary) is a contradiction bot walls key on.
  const browserVersion = /^\d+[\d.]*$/.test(browser.version()) ? browser.version() : '145.0.0.0';
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`
  });

  // Load cookies for authentication (paywalls, subscriptions)
  const cookies = loadCookies();
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  try {
    const page = await context.newPage();

    // Expand short URLs (t.co, apple.news, bit.ly, etc.) to their final destination
    const expandedUrl = await expandShortUrl(url);

    // Rewrite Substack reader-wrapper links (open.substack.com) to the canonical
    // publication URL — the reader SPA hangs printToPDF (see fn comment).
    // Clean Substack URLs (remove tracking params that cause popups)
    // Rewrite Twitter/X URLs to Nitter for better capture
    // Rewrite Datawrapper URLs to direct CDN embed (avoids iframe + chrome)
    // Rewrite legacy Qwen GitHub Pages blog links (qwenlm.github.io) — the
    // site's own redirect drops the post slug and lands on an empty index
    const substackUrl = rewriteSubstackReaderUrl(expandedUrl);
    const cleanedUrl = cleanSubstackUrl(substackUrl);
    const datawrapperUrl = rewriteDatawrapperUrl(cleanedUrl);
    const qwenUrl = rewriteQwenBlogUrl(datawrapperUrl);
    const targetUrl = rewriteTwitterUrl(qwenUrl);

    // Navigate with timeout
    // Try networkidle first for complete page load, fallback to domcontentloaded for heavy SPAs
    let navigationSucceeded = false;
    try {
      await page.goto(targetUrl, {
        timeout,
        waitUntil: 'networkidle'  // Wait for network to be idle (better for heavy JS sites)
      });
      navigationSucceeded = true;
    } catch (error) {
      // Check for timeout errors - retry with domcontentloaded for heavy SPA sites
      if (error instanceof Error && error.name === 'TimeoutError') {
        console.log(`networkidle timeout for ${url}, retrying with domcontentloaded...`);
        try {
          // Fresh page for retry
          await page.goto(targetUrl, {
            timeout,
            waitUntil: 'domcontentloaded'
          });
          // Wait for article content to render (SPAs hydrate after DOM ready)
          // Try to detect when meaningful content appears, with a hard cap of 15s
          try {
            await page.waitForFunction(() => {
              const body = document.body?.innerText || '';
              return body.length > 3000;
            }, { timeout: 15000 });
          } catch {
            // Content didn't reach threshold - proceed with whatever loaded
            await page.waitForTimeout(5000);
          }
          navigationSucceeded = true;
        } catch (retryError) {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
          return {
            success: false,
            url,
            error: `Navigation failed after retry: ${retryMsg}`,
            reason: 'timeout'
          };
        }
      } else {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Check for common bot detection patterns in error message
        if (errorMsg.includes('net::ERR_BLOCKED') || errorMsg.includes('403')) {
          return {
            success: false,
            url,
            error: errorMsg,
            reason: 'bot_detected'
          };
        }

        return {
          success: false,
          url,
          error: errorMsg,
          reason: 'navigation_error'
        };
      }
    }

    // Wait for JS rendering and ensure body is present
    await page.waitForTimeout(waitAfterLoad);

    // Wait for body to be present (some SPAs take time to hydrate)
    try {
      await page.waitForSelector('body', { timeout: 5000 });
    } catch {
      // Body selector failed, continue anyway
    }

    // Extra wait for heavy JS sites
    await page.waitForTimeout(2000);

    // Transient near-blank renders: some failures are one-shot, not permanent —
    // e.g. an HTTP 425 "too early" body (theverge.com gift links over TLS 1.3
    // 0-RTT) or a bot interstitial that clears on the next request. If the DOM
    // has almost no text after all waits, reload once before capturing.
    try {
      const renderedTextLen = await page.evaluate(
        () => document.body?.innerText.trim().length ?? 0
      );
      // Floor tracks the content check's 500-char minimum: a DOM with less text
      // than that is guaranteed to fail quality later, so one reload is free
      // insurance (a stub shell whose hydration died is often a one-shot
      // failure). Twitter keeps the old 200 floor — short tweets legitimately
      // render under 500 chars, and extra Nitter loads burn the rate budget.
      const nearBlankFloor = isTwitterUrl(url) ? 200 : 500;
      if (renderedTextLen < nearBlankFloor) {
        console.log(`Near-blank render (${renderedTextLen} chars) for ${url}, reloading once...`);
        try {
          await page.reload({ timeout, waitUntil: 'networkidle' });
        } catch {
          await page.reload({ timeout, waitUntil: 'domcontentloaded' });
        }
        await page.waitForTimeout(waitAfterLoad + 2000);
      }
    } catch {
      // Reload attempt failed — capture whatever the original render produced
    }

    // A status page can announce an X Article via a Nitter article card. Hop
    // the same page to Nitter's full renderer before any capture mutations so
    // the normal image/scroll/privacy/print pipeline operates on the article.
    // If the renderer is missing or thin, restore the thread and preserve the
    // existing direct-X fallback behavior below.
    let isNitterArticleCapture = false;
    if (isTwitterUrl(url) && targetUrl !== url) {
      try {
        const articleHref = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll(
            '.main-tweet .article-card a.card-container[href*="/i/article/"]',
          ));
          const link = links.find((candidate) => !candidate.closest('.quote'));
          return link?.getAttribute('href') ?? null;
        });
        const articleMatch = articleHref?.match(/\/i\/article\/(\d+)(?:[/?#]|$)/);
        if (articleMatch) {
          const articleUrl = `${env.NITTER_HOST.replace(/\/+$/, '')}/i/article/${articleMatch[1]}`;
          try {
            await page.goto(articleUrl, { timeout, waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(waitAfterLoad);
            await page.waitForSelector('body', { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2000);
            const articleLength = await page.evaluate(
              () => (document.querySelector('.article-body') as HTMLElement | null)?.innerText.trim().length ?? 0
            );
            if (articleLength >= 600) {
              isNitterArticleCapture = true;
              console.log(`Nitter article renderer loaded for ${url} (${articleLength} chars)`);
            }
          } catch (articleError) {
            console.warn(`Nitter article renderer failed for ${url}: ${articleError instanceof Error ? articleError.message : articleError}`);
          }

          if (!isNitterArticleCapture) {
            try {
              await page.goto(targetUrl, { timeout, waitUntil: 'domcontentloaded' });
              await page.waitForTimeout(waitAfterLoad);
              await page.waitForSelector('body', { timeout: 5000 }).catch(() => {});
              await page.waitForTimeout(2000);
            } catch (restoreError) {
              console.warn(`Unable to restore Nitter thread for ${url}: ${restoreError instanceof Error ? restoreError.message : restoreError}`);
            }
          }
        }
      } catch {
        // Article detection/navigation is best-effort; continue as a tweet.
      }
    }

    // HuggingFace Spaces embed the app in a cross-origin iframe (*.hf.space)
    // with a fixed layout height, so printing the huggingface.co shell clips
    // the app to at most one viewport — even a fully rendered app comes out
    // as a near-blank first page. Hop into the app frame's own URL (read from
    // the live DOM, which handles HF's subdomain-mangling rules) and print
    // that document instead, same pattern as the Datawrapper embed rewrite.
    if (/huggingface\.co\/spaces\//i.test(targetUrl)) {
      let inAppFrame = false;
      try {
        const spaceFrameSrc = await page.evaluate(() => {
          const src = Array.from(document.querySelectorAll('iframe'))
            .map(f => f.getAttribute('src') || '')
            .find(s => /\.hf\.space/i.test(s));
          return src || null;
        });
        if (spaceFrameSrc) {
          console.log(`HF Space detected for ${url}; navigating into app frame: ${spaceFrameSrc}`);
          try {
            await page.goto(spaceFrameSrc, { timeout, waitUntil: 'networkidle' });
          } catch {
            // networkidle never settles on websocket-driven apps (Gradio/Streamlit)
            await page.goto(spaceFrameSrc, { timeout, waitUntil: 'domcontentloaded' });
          }
          inAppFrame = true;
        }
      } catch (err) {
        console.warn(`HF Space frame hop failed for ${url}:`, err instanceof Error ? err.message : err);
      }

      // The app renders via websocket/XHR after load — poll until real text
      // accumulates. After the hop that's the main frame; if the hop failed
      // we're still on the HF shell, so only embedded frames count (the
      // shell's own nav chrome would satisfy the threshold spuriously).
      const SPACE_TEXT_THRESHOLD = 500;
      const SPACE_WAIT_CAP_MS = 25000;
      const spaceDeadline = Date.now() + SPACE_WAIT_CAP_MS;
      let spaceRendered = false;
      while (!spaceRendered && Date.now() < spaceDeadline) {
        for (const frame of page.frames()) {
          if (!inAppFrame && frame === page.mainFrame()) continue;
          try {
            const textLen = await frame.evaluate(
              () => document.body?.innerText.trim().length ?? 0
            );
            if (textLen >= SPACE_TEXT_THRESHOLD) {
              spaceRendered = true;
              break;
            }
          } catch {
            // Frame detached or still navigating — keep polling
          }
        }
        if (!spaceRendered) await page.waitForTimeout(1000);
      }
      if (!spaceRendered) {
        console.log(`HF Space app frame never reached ${SPACE_TEXT_THRESHOLD} chars for ${url}; capturing current state`);
      } else {
        // Give the app a beat to finish painting tables/charts after data lands
        await page.waitForTimeout(1500);
      }
    }

    // For Nitter pages: rewrite broken /pic/ proxy URLs to direct Twitter CDN URLs.
    // Nitter's image proxy is unreliable (rate-limited/broken), but pbs.twimg.com serves
    // the same images directly and reliably.
    // Mapping: /pic/media/... → https://pbs.twimg.com/media/...
    //          /pic/profile_images/... → https://pbs.twimg.com/profile_images/...
    //          /pic/video.twimg.com/... → https://video.twimg.com/...
    try {
      const rewriteCount = await page.evaluate(() => {
        let count = 0;
        document.querySelectorAll('img').forEach(img => {
          const src = img.getAttribute('src');
          if (src && src.includes('/pic/')) {
            const match = src.match(/\/pic\/(.+)/);
            if (match) {
              let path: string;
              try {
                path = decodeURIComponent(match[1].replace(/^orig\//, ''));
              } catch {
                // Malformed percent-encoding — skip this image but keep iterating.
                img.removeAttribute('loading');
                return;
              }
              let newSrc: string;
              if (path.startsWith('https://')) {
                try {
                  const parsed = new URL(path);
                  if (parsed.hostname !== 'pbs.twimg.com' && parsed.hostname !== 'video.twimg.com') {
                    img.removeAttribute('loading');
                    return;
                  }
                  newSrc = parsed.toString();
                } catch {
                  img.removeAttribute('loading');
                  return;
                }
              } else if (path.startsWith('video.twimg.com/') || path.startsWith('pbs.twimg.com/')) {
                newSrc = `https://${path}`;
              } else {
                newSrc = `https://pbs.twimg.com/${path}`;
              }
              img.setAttribute('src', newSrc);
              count++;
            }
          }
          img.removeAttribute('loading');
        });
        return count;
      });
      if (rewriteCount > 0) {
        console.log(`Rewrote ${rewriteCount} Nitter image URLs to direct Twitter CDN`);
      }
    } catch (err) {
      console.warn('Nitter image rewrite failed:', err instanceof Error ? err.message : err);
    }

    await tracePhase(page, url, 'after-navigation');

    // Scroll through page to trigger any remaining lazy-loaded content
    try {
      await Promise.race([
        page.evaluate(`(async () => {
          const delay = ms => new Promise(r => setTimeout(r, ms));
          const scrollStep = 1000;
          const maxScrolls = 50;
          let scrollCount = 0;

          while (scrollCount < maxScrolls) {
            window.scrollBy(0, scrollStep);
            await delay(50);
            scrollCount++;

            const scrollPosition = window.scrollY + window.innerHeight;
            if (scrollPosition >= document.documentElement.scrollHeight - 10) {
              break;
            }
          }

          window.scrollTo(0, 0);
        })()`),
        new Promise(resolve => setTimeout(resolve, 10000)) // 10s timeout for scroll
      ]);
    } catch {
      // Scroll failed, continue with PDF generation anyway
    }

    // Lazy-body settle: SPA article bodies (axios-style) fetch their text on
    // scroll via XHR/intersection observers, and the fast scroll above can
    // outrun that fetch — capturing only the page shell (nav + headline +
    // "what to read next"). If the body is still article-shell-thin, wait for
    // it to grow before capturing. Only runs when thin, so real articles
    // (already > threshold) pay nothing.
    //
    // Measure the ARTICLE CONTAINER (<article>/<main>), not whole-body innerText.
    // Axios renders headline + hero + a full "What to read next" related-content
    // rail + footer even when the story body never hydrates — that chrome alone
    // exceeds the whole-body threshold, so a whole-body gate never fired and the
    // re-arm below was skipped (the body stayed empty and the quality check
    // rejected it as truncated). The related/footer chrome lives OUTSIDE
    // <article>/<main>, so scoping the measurement to that container exposes the
    // empty body. Falls back to document.body when no such container exists, so
    // sites without semantic <article>/<main> keep the original behaviour.
    const ARTICLE_LEN_FN = () => {
      const main = document.querySelector('article') || document.querySelector('main');
      return (main ?? document.body)?.innerText.trim().length ?? 0;
    };
    try {
      const SHELL_THRESHOLD = 2500;
      const len0 = await page.evaluate(ARTICLE_LEN_FN);
      if (len0 < SHELL_THRESHOLD) {
        await page.waitForFunction(
          (prev) => {
            const main = document.querySelector('article') || document.querySelector('main');
            return ((main ?? document.body)?.innerText.trim().length ?? 0) > prev + 500;
          },
          len0,
          { timeout: 8000 }
        ).catch(() => { /* body didn't grow — try re-arming lazy loaders below */ });
        await page.waitForTimeout(1500);

        // Re-scroll retries. Some SPAs (axios) hydrate the article body only when
        // its container scrolls into view via an intersection observer, and a
        // single fast scroll pass can outrun (or have its XHR dropped before) that
        // fetch — leaving just the page shell (headline + hero + "what to read
        // next"), which the quality check then correctly rejects as truncated.
        // Re-arm the observers by scrolling bottom→middle→top a few more rounds,
        // re-checking growth each round. Guarded on still-shell-thin, so complete
        // articles never enter this loop and pay nothing.
        for (let attempt = 0; attempt < 3; attempt++) {
          const len = await page.evaluate(ARTICLE_LEN_FN);
          if (len >= SHELL_THRESHOLD) break;
          await page.evaluate(`(async () => {
            const delay = ms => new Promise(r => setTimeout(r, ms));
            window.scrollTo(0, document.documentElement.scrollHeight);
            await delay(400);
            window.scrollTo(0, Math.floor(document.documentElement.scrollHeight / 2));
            await delay(400);
            window.scrollTo(0, 0);
          })()`).catch(() => { /* scroll failed — keep trying */ });
          await page.waitForFunction(
            (prev) => {
              const main = document.querySelector('article') || document.querySelector('main');
              return ((main ?? document.body)?.innerText.trim().length ?? 0) > prev + 500;
            },
            len,
            { timeout: 5000 }
          ).catch(() => { /* still thin — next round, or give up after the loop */ });
          await page.waitForTimeout(1000);
        }

        // JSON-LD body rescue. If the body STILL didn't hydrate after every
        // re-scroll round, the content XHR is likely bot-gated — no amount of
        // in-page nudging will fill it (observed on axios.com: skeleton
        // placeholders persist and the quality check rejects the shell as
        // truncated). News SPAs server-embed the full text as NewsArticle
        // JSON-LD in the initial HTML, so recover the body from there and
        // inject it into the article container before capture. The injected
        // text is the publisher's own articleBody verbatim — fidelity is
        // preserved. Guarded on still-shell-thin AND the JSON-LD body being
        // meaningfully longer than what rendered, so short-but-complete pages
        // never get doubled text.
        const lenFinal = await page.evaluate(ARTICLE_LEN_FN);
        if (lenFinal < SHELL_THRESHOLD) {
          const ldScripts = await page.evaluate(() =>
            Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
              .map((s) => s.textContent || '')
          );
          const ldBody = extractJsonLdArticleBody(ldScripts);
          if (ldBody && ldBody.length > lenFinal + 500) {
            await page.evaluate((bodyText) => {
              const main = document.querySelector('article') || document.querySelector('main') || document.body;
              const container = document.createElement('div');
              for (const para of bodyText.split(/\n+/)) {
                const trimmed = para.trim();
                if (!trimmed) continue;
                const p = document.createElement('p');
                p.textContent = trimmed;
                p.style.margin = '1em 0';
                container.appendChild(p);
              }
              main.appendChild(container);
            }, ldBody);
            console.log(`[jsonld-rescue] Article body never hydrated (${lenFinal} chars rendered); injected ${ldBody.length}-char articleBody from JSON-LD`);
          }
        }
      }
    } catch {
      // Settle check failed — continue with PDF generation anyway
    }

    // Wait for images to finish downloading (especially Nitter → Twitter CDN rewrites)
    try {
      await page.waitForFunction(() => {
        const images = Array.from(document.querySelectorAll('img[src]:not([src=""])'));
        return images.every(img => (img as HTMLImageElement).complete);
      }, { timeout: 10000 });
    } catch {
      // Log which images didn't load
      try {
        const broken = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('img[src]:not([src=""])'))
            .filter(img => !(img as HTMLImageElement).complete || (img as HTMLImageElement).naturalWidth === 0)
            .map(img => img.getAttribute('src')?.substring(0, 100));
        });
        if (broken.length > 0) {
          console.warn(`${broken.length} images failed to load:`, broken);
        }
      } catch { /* ignore */ }
    }

    // Embedded-PDF viewers print as blank sheets: Chromium's print path
    // rasterizes neither the native <embed>/<iframe> PDF plugin nor PDF.js
    // canvases that aren't scrolled into view, so a page whose main content is
    // a document viewer captures as intro text + N dark pages (real case:
    // xbow.com whitepapers — a 16-page report reduced to 3.1 chars/KB and
    // rejected as truncated). Lift the source PDF's URL now, while the DOM is
    // unmutated; the worker only uses it as a pass-through fallback when the
    // printed capture fails content analysis, so pages with real prose beside
    // an embedded paper keep their normal capture.
    let embeddedPdfUrl: string | undefined;
    try {
      const embeddedPdfScan: EmbeddedPdfScan = await page.evaluate(() => {
        const VIEWER_MIN_PX = 300;
        const isLarge = (el: Element) => {
          const rect = el.getBoundingClientRect();
          return rect.width >= VIEWER_MIN_PX && rect.height >= VIEWER_MIN_PX;
        };
        const embeds: Array<{ raw: string; isPdfType: boolean; large: boolean }> = [];
        for (const el of document.querySelectorAll('embed[src], object[data], iframe[src]')) {
          const raw = el.getAttribute('src') || el.getAttribute('data') || '';
          if (!raw) continue;
          const isPdfType = (el.getAttribute('type') || '').toLowerCase() === 'application/pdf';
          if (!isPdfType && !/\.pdf(?:[?#]|$)/i.test(raw)) continue;
          embeds.push({ raw, isPdfType, large: isLarge(el) });
        }
        const pdfAnchorHrefs = Array.from(document.querySelectorAll('a[href]'))
          .map((a) => a.getAttribute('href') || '')
          .filter((href) => /\.pdf(?:[?#]|$)/i.test(href))
          .slice(0, 20);
        const hasViewerCanvas = Array.from(document.querySelectorAll('canvas')).some(isLarge);
        return { embeds, pdfAnchorHrefs, hasViewerCanvas };
      });
      embeddedPdfUrl = pickEmbeddedPdfUrl(embeddedPdfScan, page.url());
      if (embeddedPdfUrl) {
        console.log(`Embedded PDF viewer detected for ${url}: ${embeddedPdfUrl}`);
      }
    } catch {
      // Detection is best-effort — capture proceeds without a fallback URL
    }

    // Apply privacy filtering (hides elements containing configured terms).
    // Non-fatal: a throw inside the in-page evaluate (e.g. createTreeWalker on a
    // missing body) must not abort an otherwise-good capture.
    try {
      await applyPrivacyFilter(page);
    } catch (privacyError) {
      console.warn(`Privacy filter failed for ${url}: ${privacyError instanceof Error ? privacyError.message : privacyError}`);
    }

    await tracePhase(page, url, 'after-scroll-and-privacy-filter');

    // Remove ALL fixed/sticky positioned elements (cookie banners, newsletter popups,
    // dark/light toggles, floating share buttons, chat widgets, "back to top", etc.)
    // CSS attribute selectors only catch inline styles — this catches everything via computed style.
    try {
      const removed = await page.evaluate((consentPatterns: { accept: string; notAccept: string }) => {
        let count = 0;

        // Phase 1: Try clicking "accept" on cookie banners to dismiss them cleanly
        const acceptSelectors = [
          '[id*="cookie"] button', '[class*="cookie"] button',
          '[id*="consent"] button', '[class*="consent"] button',
          'button[data-testid*="accept"]', 'button[data-testid*="cookie"]',
          '.cc-accept', '.cc-dismiss', '#accept-cookies', '.accept-cookies',
        ];
        // Word-bounded, and never a settings/manage/reject control. Substring
        // matching on "ok" was clicking the wrong button: every selector above
        // scopes to a cookie/consent container, and "Cookie Settings" contains
        // "ok" — so on any CMP whose banner offers a settings button we opened
        // the preferences modal immediately before printing, leaving a bigger
        // overlay than the banner we meant to dismiss.
        const acceptRe = new RegExp(consentPatterns.accept);
        const notAcceptRe = new RegExp(consentPatterns.notAccept);
        for (const selector of acceptSelectors) {
          for (const btn of document.querySelectorAll(selector)) {
            const text = (btn.textContent || '').toLowerCase().trim();
            if (acceptRe.test(text) && !notAcceptRe.test(text)) {
              (btn as HTMLElement).click();
              break;
            }
          }
        }

        // Phase 2: Remove all fixed/sticky elements from the DOM
        // These are ALWAYS overlays in a PDF context — navbars, floating buttons,
        // cookie banners, newsletter popups, theme toggles, chat widgets, etc.
        // We walk all elements and check computed position.
        //
        // EXCEPT content-bearing wrappers: magazine-style scrollytelling layouts
        // (e.g. Business Insider "Discourse" features) pin the article body —
        // and sometimes everything below the hero — inside position:sticky
        // scroll-stage sections. Deleting those removes the article itself from
        // the DOM: the PDF keeps only the static headline/dek block and prints
        // ~190 chars, which the content check then (rightly) rejects as
        // truncated. Chrome overlays hold little text, so gate on text: an
        // element with several real paragraphs, or holding the bulk of the
        // page's text, is content — drop it into normal flow (same treatment
        // html/body get below) instead of removing it.
        const pageTextLen = (document.body?.innerText || '').trim().length;
        const isContentBearing = (el: HTMLElement): boolean => {
          let longParagraphs = 0;
          for (const p of el.querySelectorAll('p, blockquote')) {
            if ((p.textContent || '').trim().length >= 120) {
              longParagraphs++;
              if (longParagraphs >= 2) return true;
            }
          }
          const textLen = (el.innerText || '').trim().length;
          return textLen >= 500 && pageTextLen > 0 && textLen >= pageTextLen * 0.3;
        };
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const style = window.getComputedStyle(el);
          const position = style.position;
          if (position === 'fixed' || position === 'sticky') {
            const tag = el.tagName.toLowerCase();
            if (tag !== 'html' && tag !== 'body' && isContentBearing(el as HTMLElement)) {
              const h = el as HTMLElement;
              h.style.setProperty('position', 'static', 'important');
              h.style.setProperty('top', 'auto', 'important');
              h.style.setProperty('height', 'auto', 'important');
              h.style.setProperty('max-height', 'none', 'important');
              h.style.setProperty('overflow', 'visible', 'important');
              count++;
              continue;
            }
            if (tag === 'html' || tag === 'body') {
              // Never remove html/body — but app-shell layouts (e.g. thenextweb
              // sets body{position:fixed;overflow:hidden}) pin the document
              // scrollHeight to the viewport, so page.pdf captures only the first
              // screen and the article looks cut off after a few paragraphs.
              // Return them to normal flow so the full content paginates. Inline
              // !important beats the site's class-specific rule (a stylesheet
              // override loses the specificity war).
              const h = el as HTMLElement;
              h.style.setProperty('position', 'static', 'important');
              h.style.setProperty('height', 'auto', 'important');
              h.style.setProperty('max-height', 'none', 'important');
              h.style.setProperty('overflow', 'visible', 'important');
              count++;
              continue;
            }

            (el as HTMLElement).remove();
            count++;
          }
        }

        // Phase 2.5: De-floatie — force out-of-flow elements into normal flow so
        // they can't overlap body text in the flat PDF. The classic case: a hero
        // photo with position:absolute (z-index auto, so Phase 3 misses it)
        // rendered over the article column (e.g. archived Bloomberg articles).
        // We force static + unfloat rather than remove, so the image is KEPT —
        // just dropped into normal flow below/above the text instead of over it.
        // Scoped to media elements and to large absolute blocks (small absolute
        // badges/icons don't obscure text and are left alone).
        for (const el of document.querySelectorAll('img, figure, picture, video')) {
          const s = window.getComputedStyle(el);
          if (s.position === 'absolute' || s.float !== 'none') {
            const h = el as HTMLElement;
            h.style.setProperty('position', 'static', 'important');
            h.style.setProperty('float', 'none', 'important');
            count++;
          }
        }
        for (const el of document.querySelectorAll('*')) {
          const s = window.getComputedStyle(el);
          if (s.position === 'absolute') {
            const r = (el as HTMLElement).getBoundingClientRect();
            // Large absolute block likely to overlap the text column.
            if (r.width > 250 && r.height > 150) {
              const h = el as HTMLElement;
              h.style.setProperty('position', 'static', 'important');
              h.style.setProperty('float', 'none', 'important');
              count++;
            }
          } else if (s.float !== 'none') {
            (el as HTMLElement).style.setProperty('float', 'none', 'important');
            count++;
          }
        }

        // Phase 3: Remove high z-index elements that might still float over content
        // Some overlays use position:absolute with very high z-index
        const remaining = document.querySelectorAll('*');
        for (const el of remaining) {
          const style = window.getComputedStyle(el);
          const zIndex = parseInt(style.zIndex, 10);
          if (zIndex >= 10000 && style.position === 'absolute') {
            // Check it's not a large content element (overlays are typically small)
            const rect = (el as HTMLElement).getBoundingClientRect();
            const viewportArea = window.innerWidth * window.innerHeight;
            const elArea = rect.width * rect.height;
            // Skip if it covers >60% of viewport (likely a content wrapper)
            if (elArea / viewportArea > 0.6) continue;

            (el as HTMLElement).remove();
            count++;
          }
        }

        // Phase 4: Collapse empty containers left behind by removed elements
        // When fixed/sticky navbars are removed, their parent wrappers often remain
        // as empty spacers (e.g., LessWrong's Header-headerHeight span)
        for (const el of document.querySelectorAll('*')) {
          const htmlEl = el as HTMLElement;
          const tag = htmlEl.tagName.toLowerCase();
          // Skip media elements — they have no children/text but ARE content
          if (tag === 'img' || tag === 'video' || tag === 'svg' || tag === 'canvas' || tag === 'iframe') continue;
          // Only collapse elements that are visually empty but take up space
          if (htmlEl.offsetHeight > 100 && htmlEl.children.length === 0 &&
              (htmlEl.textContent?.trim().length || 0) === 0) {
            // Don't hide grid/flex ITEMS: an empty child of a grid/flex container
            // is a layout participant (e.g. a scrollytelling timeline rail/spine in
            // a CSS grid). display:none removes it from the track/item layout, which
            // reflows its siblings — collapsing the content column to min-content
            // (mid-word wrapping → hundreds of near-blank pages, e.g. europe2031.ai).
            // A genuine leftover spacer from a removed navbar is a plain block child,
            // not a grid/flex item, so this guard keeps the spacer-removal intent.
            const parentDisplay = htmlEl.parentElement
              ? window.getComputedStyle(htmlEl.parentElement).display : '';
            if (parentDisplay === 'grid' || parentDisplay === 'inline-grid' ||
                parentDisplay === 'flex' || parentDisplay === 'inline-flex') continue;
            htmlEl.style.display = 'none';
            count++;
          }
        }

        // Phase 5: Remove large decorative shapes (beehiiv black ovals, gradient
        // blobs, hero-image circles, newsletter badges, etc.)
        //
        // Pattern: sites like beehiiv use giant elements with border-radius: 50%
        // as decorative backgrounds. They render fine on-screen (overflow: hidden)
        // but explode in PDF, obscuring article text. We detect ANY large round
        // element with little/no text and remove it regardless of background color.
        const viewportArea = window.innerWidth * window.innerHeight;
        for (const el of document.querySelectorAll('*')) {
          const htmlEl = el as HTMLElement;
          const tag = htmlEl.tagName.toLowerCase();
          // Don't touch content-bearing elements
          if (['html', 'body', 'main', 'article', 'section', 'p', 'h1', 'h2',
               'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'pre', 'code',
               'blockquote', 'form', 'input', 'textarea'].includes(tag)) continue;

          const rect = htmlEl.getBoundingClientRect();
          if (rect.width < 150 || rect.height < 150) continue;

          const style = window.getComputedStyle(htmlEl);
          const br = style.borderRadius || '';
          const brPx = parseInt(br) || 0;
          const isRounded = br.includes('50%') || br.includes('9999') ||
                            br.includes('100%') || brPx > 100;

          const textLen = (htmlEl.textContent || '').trim().length;
          const elArea = rect.width * rect.height;

          // Large round elements with no meaningful text → decorative blob
          if (isRounded && textLen < 50 && elArea > viewportArea * 0.1) {
            htmlEl.remove();
            count++;
            continue;
          }

          // Also clip-path any round element (even with text) to prevent
          // overflow bleed in PDF rendering
          if (isRounded && elArea > viewportArea * 0.2) {
            htmlEl.style.overflow = 'hidden';
            htmlEl.style.clipPath = 'inset(0)';
          }

          // Large dark elements covering >40% viewport with only an image
          // (failed hero image containers with dark fallback background)
          const bg = style.backgroundColor;
          const isDark = bg === 'rgb(0, 0, 0)' || bg === 'rgba(0, 0, 0, 1)' ||
                         bg === 'rgb(17, 17, 17)' || bg === 'rgb(24, 24, 24)';
          if (isDark && elArea > viewportArea * 0.3 && textLen < 30) {
            const imgs = htmlEl.querySelectorAll('img');
            if (imgs.length <= 2) {
              htmlEl.style.backgroundColor = 'transparent';
              count++;
            }
          }
        }

        return count;
      }, { accept: CONSENT_ACCEPT_RE.source, notAccept: CONSENT_NOT_ACCEPT_RE.source });
      if (removed > 0) {
        console.log(`Removed ${removed} fixed/sticky/overlay elements from ${url}`);
      }
    } catch {
      // Element removal failed, CSS fallback will handle it
    }

    // Un-pin viewport-height scroll wrappers. SPA shells (e.g. Politico's Nuxt
    // app: a `div.h-screen.flex.flex-col` Tailwind wrapper) pin html/body/#__nuxt
    // to one viewport height (height:100vh) while the real article overflows to
    // a far larger scrollHeight. innerText reads the whole article, but page.pdf
    // paginates off the document height — so it captures only the first screen
    // and the PDF looks cut off after a few paragraphs. The Phase-1 fix only
    // handles position:fixed/sticky html/body; these wrappers are position:static
    // and pinned purely by height, so it misses them. This is self-gating: it
    // only fires when an element's content overflows its pinned box, which never
    // happens on a normally-flowing article — so other sites pay nothing.
    await tracePhase(page, url, 'after-overlay-removal');
    try {
      const unpinned = await page.evaluate(() => {
        const vh = window.innerHeight;
        let count = 0;
        const release = (el: HTMLElement) => {
          el.style.setProperty('height', 'auto', 'important');
          el.style.setProperty('min-height', '0', 'important');
          el.style.setProperty('max-height', 'none', 'important');
          el.style.setProperty('overflow', 'visible', 'important');
          el.style.setProperty('overflow-y', 'visible', 'important');
          count++;
        };

        // html + body + every block wrapper whose box is pinned ~one viewport
        // tall while its content overflows well past it.
        const candidates = [document.documentElement, document.body,
          ...Array.from(document.querySelectorAll('body > *, body > * > *, #__nuxt, #__next, #root, #app'))];
        for (const el of new Set(candidates)) {
          if (!el) continue;
          const h = el as HTMLElement;
          const clientH = h.clientHeight;
          const scrollH = h.scrollHeight;
          // Pinned to ~viewport height but holding much taller content.
          if (clientH > 0 && clientH <= vh + 50 && scrollH > clientH + 400) {
            release(h);
          }
        }

        // The same trap one layer deeper: app shells that scroll the article
        // inside a fixed-height `overflow-y:auto` div rather than the document
        // (qwen.ai nests its 27000px article in a 900px pane at
        // `body > div#ice-container > div > div#…LAYOUT_CONTENT`). The pass
        // above only reaches `body > * > *`, and even reaching the pane isn't
        // enough — every ancestor is itself height-pinned with overflow:hidden,
        // so the document height stays at one screen and page.pdf emits a
        // single clipped page. Find the pane at any depth and release its whole
        // ancestor chain.
        const bodyLen = (document.body?.innerText || '').length;
        for (const el of document.querySelectorAll('div, main, section, article')) {
          const style = window.getComputedStyle(el);
          if (!/(auto|scroll)/.test(style.overflowY)) continue;
          const clientH = el.clientHeight;
          if (clientH <= 0 || clientH > vh + 50) continue;
          if (el.scrollHeight <= clientH + 400) continue;
          // Must hold the bulk of the page's text. A nav rail, comment sidebar
          // or embedded terminal also scrolls independently, and collapsing
          // those into the flow just pads the PDF with chrome.
          const len = ((el as HTMLElement).innerText || '').length;
          if (len < 1000 || len < bodyLen * 0.3) continue;
          for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
            release(n);
          }
        }

        // Same clipping at content scale: code samples and tables capped to a
        // fixed height with their own scrollbar lose everything past the cap in
        // a flat PDF (qwen.ai caps each listing at 500px, hiding ~two-thirds of
        // the longer ones). The upper bound keeps a runaway embedded log from
        // expanding into hundreds of pages.
        for (const el of document.querySelectorAll('pre, code, table')) {
          const h = el as HTMLElement;
          if (h.clientHeight > 0 && h.scrollHeight > h.clientHeight + 20 &&
              h.scrollHeight < 20000) {
            release(h);
          }
        }
        return count;
      });
      if (unpinned > 0) {
        console.log(`Un-pinned ${unpinned} viewport-height scroll wrapper(s) from ${url}`);
      }
    } catch {
      // Un-pin failed — capture whatever rendered
    }

    // For Twitter URLs via Nitter: check whether the restored tweet page is an
    // article stub/card that still needs the existing direct-X fallback. A
    // successful hop to Nitter's article renderer must skip this — the article
    // body itself may mention /i/article/ links and would re-trigger it.
    if (isTwitterUrl(url) && targetUrl !== url && !isNitterArticleCapture) {
      const isArticleStub = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll(
          '.main-tweet .article-card a.card-container[href*="/i/article/"]',
        ));
        return links.some((candidate) =>
          !candidate.closest('.quote')
          && /\/i\/article\/\d+(?:[/?#]|$)/.test(candidate.getAttribute('href') ?? ''));
      });
      // Nitter error panel ("Tweet not found", rate-limited instance): the page
      // renders only the error box, so body text is tiny. These are usually
      // transient guest-token failures, not proof the tweet is gone — retry
      // direct so a live tweet isn't rejected as a blank capture.
      let isNitterErrorPage = false;
      if (!isArticleStub) {
        try {
          const bodyText: string = await page.evaluate(() => document.body?.innerText || '');
          isNitterErrorPage = bodyText.trim().length < 600 &&
            /tweet not found|user not found|instance has been rate limited|page not found/i.test(bodyText);
        } catch {
          // body inspection failed — fall through to normal capture
        }
      }
      if (isArticleStub || isNitterErrorPage) {
        console.log(isArticleStub
          ? `Nitter returned article stub for ${url}, retrying with direct X.com`
          : `Nitter returned error page for ${url}, retrying with direct X.com`);
        // Close current page and retry with original URL
        await page.close();
        const directPage = await context.newPage();
        const directResponse = await directPage.goto(url, {
          timeout,
          waitUntil: 'domcontentloaded'
        });
        // X serves HTTP 404 for deleted tweets/removed accounts even without
        // JS — a precise signal that separates "content is gone" from Nitter
        // guest-token hiccups (which retry) below. Archive fallback still gets
        // a shot: a tweet archived before deletion is recoverable.
        if (directResponse && directResponse.status() === 404) {
          await directPage.close().catch(() => {});
          console.warn(`Tweet gone (X returned 404) for ${url}`);
          return {
            success: false,
            url,
            error: 'Tweet no longer exists (deleted or account removed) — X returned 404',
            reason: 'navigation_error',
          };
        }
        // Wait longer for X.com JS rendering
        await directPage.waitForTimeout(3000);

        // Validate the X.com fallback actually returned the tweet. When Nitter
        // is rate-limited, X.com frequently also blocks us (login wall / "try
        // again") — capturing that would save a junk PDF in place of the tweet.
        // If the fallback is also an error/near-blank page, FAIL with a transient
        // rate_limited reason so the job retries/reprocesses instead of saving it.
        const directText = await directPage
          .evaluate(() => document.body?.innerText || '')
          .catch(() => '');
        const NITTER_OR_BLOCK_RE = /instance has been rate limited|tweet not found|user not found|use another instance|something went wrong|try again|rate limit|log in to|sign in to x|see the latest/i;
        if (directText.trim().length < 280 || NITTER_OR_BLOCK_RE.test(directText.slice(0, 600))) {
          await directPage.close().catch(() => {});
          console.warn(`Nitter error + X.com fallback failed for ${url} (${directText.trim().length} chars) — rate_limited`);
          return {
            success: false,
            url,
            error: 'Nitter instance rate-limited and the X.com fallback did not return the tweet',
            reason: 'rate_limited',
          };
        }
        // X Articles are rendered directly because the Nitter tweet page only
        // contains a stub link. Lift the article body before privacy/print DOM
        // mutations so the structured Twitter database has an x.com fallback
        // when Nitter's article renderer is unavailable. Best-effort: PDF
        // capture remains authoritative and must not fail on selector drift.
        let articleContent: {
          title?: string;
          bodyHtml?: string;
          bodyText?: string;
          authorUsername?: string;
        } | undefined;
        if (isArticleStub) {
          try {
            articleContent = await directPage.evaluate(() => {
              const article = document.querySelector(
                '[data-testid="twitterArticleRichTextView"], [data-testid="articleRichTextView"], [data-testid="ArticleBody"], article',
              ) as HTMLElement | null;
              const title = document.querySelector('h1')?.textContent?.trim()
                || document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
                || undefined;
              const authorHref = document.querySelector(
                '[data-testid="User-Name"] a[href^="/"], article a[href^="/"]',
              )?.getAttribute('href');
              const authorUsername = authorHref?.match(/^\/([A-Za-z0-9_]+)/)?.[1];
              const bodyHtml = article?.innerHTML.trim() || undefined;
              const bodyText = article?.innerText.trim() || undefined;
              if (!title && !bodyHtml && !bodyText) return undefined;
              return { title, bodyHtml, bodyText, authorUsername };
            });
          } catch {
            // Structured extraction is non-fatal; the worker logs harvest misses.
          }
        }
        // Apply privacy filtering for direct X.com capture too
        await applyPrivacyFilter(directPage);
        // Continue with directPage for PDF generation
        await directPage.emulateMedia({ media: 'screen' });
        // Use CSS-only approach to hide fixed/sticky elements (avoids expensive DOM traversal)
        await directPage.addStyleTag({
          content: `
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }

            /* Force all links and their contents to be visible */
            a, a *, a span, a strong, a em, a b, a i {
              visibility: visible !important;
              opacity: 1 !important;
              color: inherit !important;
              background-clip: border-box !important;
              -webkit-background-clip: border-box !important;
              -webkit-text-fill-color: currentColor !important;
            }
            a { display: inline !important; position: static !important; }

            /* Hide inline-styled fixed/sticky elements */
            [style*="position: fixed"], [style*="position:fixed"],
            [style*="position: sticky"], [style*="position:sticky"] {
              display: none !important;
            }
            /* Force common sticky/fixed elements to static positioning */
            header, nav, footer, aside,
            .header, .nav, .navbar, .footer, .sidebar,
            .sticky, .fixed, .floating, .toolbar, .topbar, .bottombar,
            [class*="sticky"], [class*="fixed"], [class*="floating"],
            [class*="navbar"], [class*="header"], [class*="toolbar"],
            [role="banner"], [role="navigation"], [role="complementary"] {
              position: static !important;
            }
          `
        });
        // Take screenshot for quality verification
        const screenshotBuffer = await directPage.screenshot({
          type: 'png',
          fullPage: false,
        });
        const pdfBuffer = await withTimeout(directPage.pdf({
          format,
          printBackground: true,
          margin,
          preferCSSPageSize: false,
          scale: 0.7
        }), pdfTimeout, 'PDF generation');
        return {
          success: true,
          pdfBuffer: Buffer.from(pdfBuffer),
          screenshotBuffer: Buffer.from(screenshotBuffer),
          url,
          size: pdfBuffer.length,
          // Stub = real X Article (strict checks, "article" filename). An
          // error-page retry is still a tweet: keep isXArticle false so it
          // stays a "post" and gets the lenient tweet content checks.
          // The stub heuristic also fires on regular tweets that merely LINK
          // to an X Article (news accounts post every story this way) — the
          // Nitter page contains "x.com/i/article/" either way. What x.com
          // actually rendered disambiguates: an article view has a long essay
          // body, a tweet-with-article-card stays short. Only apply strict
          // article checks (and the "article" filename) when the rendered
          // text backs up the article classification.
          isXArticle: isArticleStub && directText.trim().length >= 2000,
          expandedUrl: expandedUrl !== url ? expandedUrl : undefined,
          articleContent,
        };
      }
    }

    // Lift structured tweet relationships from the Nitter DOM before any
    // print mutations: the quoted-status link, the reply parent (last
    // .before-tweet in the thread view), and the exact publish timestamp.
    // These land in the PDF Info Dict (QuotedTweet / InReplyTo / PublishDate)
    // so the KB's timeline reconstruction gets real edges. Best-effort — a
    // missing relation must never fail a capture.
    let tweetRelations: { quotedTweet?: string; inReplyTo?: string; tweetDate?: string } | undefined;
    if (isTwitterUrl(url) && targetUrl !== url) {
      try {
        const raw = await page.evaluate(() => {
          const toCanonical = (href: string | null): string | undefined => {
            const m = href && href.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
            return m ? `https://x.com/${m[1]}/status/${m[2]}` : undefined;
          };
          const quoteLink = document.querySelector('.main-tweet .quote a.quote-link');
          const beforeLinks = document.querySelectorAll('.before-tweet a.tweet-link');
          const parentLink = beforeLinks.length ? beforeLinks[beforeLinks.length - 1] : null;
          const dateLink = document.querySelector('.main-tweet .tweet-date a');
          return {
            quotedTweet: quoteLink ? toCanonical(quoteLink.getAttribute('href')) : undefined,
            inReplyTo: parentLink ? toCanonical(parentLink.getAttribute('href')) : undefined,
            dateTitle: dateLink ? dateLink.getAttribute('title') : undefined,
          };
        });
        // Nitter renders "Jul 2, 2026 · 3:21 AM UTC" — parseable once the
        // separator dot is dropped.
        let tweetDate: string | undefined;
        if (raw.dateTitle) {
          const parsed = new Date(raw.dateTitle.replace('·', ''));
          if (!isNaN(parsed.getTime())) tweetDate = parsed.toISOString();
        }
        if (raw.quotedTweet || raw.inReplyTo || tweetDate) {
          tweetRelations = { quotedTweet: raw.quotedTweet, inReplyTo: raw.inReplyTo, tweetDate };
          console.log(`Tweet relations for ${url}: ${JSON.stringify(tweetRelations)}`);
        }
      } catch { /* best-effort */ }
    }

    // Take screenshot BEFORE any modifications for quality check
    // Wrap in timeout to avoid font loading hangs
    let screenshotBuffer: Buffer;
    try {
      screenshotBuffer = Buffer.from(await Promise.race([
        page.screenshot({ type: 'png', fullPage: false }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Screenshot timeout')), 15000)
        )
      ]));
    } catch {
      // Screenshot failed, use empty buffer - PDF will still generate
      screenshotBuffer = Buffer.alloc(0);
    }

    // Preserve screen formatting (not print CSS)
    await page.emulateMedia({ media: 'screen' });

    // Visible text before the chrome rules apply — the content guard after the
    // injection measures hidden candidates against this, not the post-hide remainder.
    const preStyleTextLen: number = await page
      .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length)
      .catch(() => 0);

    // Add print-friendly styles (wrapped in try-catch for SPAs that might not have body ready)
    try {
    // 1. Preserve colors in print
    // 2. Hide fixed/sticky elements (headers, navbars, floating UI)
    // 3. Prevent text overflow - ensure content fits within page width
    // 4. Force visibility (some sites hide content in print)
    // Use CSS-only approach for print styling (avoids expensive querySelectorAll('*') DOM traversal)
    // Tagged so the blank-print fallback below can strip it and regenerate.
    const injectedPrintStyle = await page.addStyleTag({
      content: `
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }

        /* Force content visibility - some sites hide content in print */
        body, html, main, article, .article, .content, .post, #content, #main {
          display: block !important;
          visibility: visible !important;
          opacity: 1 !important;
          height: auto !important;
          overflow: visible !important;
        }

        /* Force all links and their contents to be visible */
        /* Sites like OpenAI use gradient text (background-clip: text) which breaks PDF capture */
        a, a *, a span, a strong, a em, a b, a i {
          visibility: visible !important;
          opacity: 1 !important;
          color: inherit !important;
          background-clip: border-box !important;
          -webkit-background-clip: border-box !important;
          -webkit-text-fill-color: currentColor !important;
          text-fill-color: currentColor !important;
        }

        /* Ensure inline links display correctly (but NOT image/media wrappers) */
        a:not(.still-image):not(.attachment) {
          display: inline !important;
          position: static !important;
        }

        /* Nitter-specific: hide overlay links that break PDF layout */
        .tweet-link {
          display: none !important;
        }

        /* Nitter-specific: hide the top navigation banner */
        nav.nav, .nav-bar, header nav, .navbar {
          display: none !important;
        }

        /* Nitter-specific: ensure timeline items have proper layout */
        .timeline-item, .tweet-body, .main-tweet, .after-tweet {
          position: relative !important;
          display: block !important;
          width: auto !important;
          height: auto !important;
        }

        /* LessWrong: hide vote sidebar, nav, header chrome, ToC — but keep post title.
           Use [class~=...] (whitespace-separated word match) for the site-chrome
           class names below — substring [class*=...] also matches the article's
           LWPostsPageHeader-root / -appBar / -headerHeight block, which contains
           the title, author, and date. */
        [class*="PostsVoteDefault"], [class*="LWPostsPageTopHeaderVote"],
        [class*="PostsPageTopHeader-leftSection"],
        [class*="TableOfContents"], [class*="ToCColumn"],
        [class*="WelcomeBox"], [class*="welcomeBox"],
        [class~="Header-root"], [class~="Header-appBar"],
        [class*="headroom-wrapper"],
        [class*="Layout-searchResultsArea"] {
          display: none !important;
        }
        /* LessWrong: collapse the page wrapper height (wraps entire content) */
        [class~="Header-headerHeight"] {
          display: block !important;
          height: auto !important;
          min-height: 0 !important;
        }
        /* LessWrong: make content area fill the full width */
        [class*="PostsPage-postContent"], [class*="ContentStyles-postBody"],
        [class*="MultiToCLayout-root"], [class*="MultiToCLayout-content"],
        [class*="PostsPage-centralColumn"], [class*="RouteRootClient-centralColumn"] {
          max-width: 100% !important;
          width: 100% !important;
          margin: 0 !important;
          padding: 0 20px !important;
        }
        /* LessWrong: ensure the post title is visible and prominent */
        [class*="PostsPageTitle"] {
          display: block !important;
          visibility: visible !important;
          font-size: 2em !important;
          margin: 10px 0 !important;
        }
        /* LessWrong: ensure figures and images don't overflow */
        [class*="PostsPage-postContent"] figure,
        [class*="PostsPage-postContent"] img,
        [class*="PostsPage-postContent"] [class*="figure"],
        [class*="ContentStyles"] figure,
        [class*="ContentStyles"] img {
          max-width: 100% !important;
          height: auto !important;
        }

        /* Hide site mastheads/headers entirely for cleaner PDFs */
        [data-testid="masthead"], [data-testid="masthead-container"],
        [class*="Masthead"], [class*="masthead"],
        #masthead, .masthead,
        [data-testid="site-header"], [data-testid="nav-header"],
        .site-header, .page-header, #site-header,
        /* Audio player bars */
        [data-testid="audio-player"], [class*="AudioPlayer"],
        /* Share/social bars */
        [data-testid="share-tools"], [class*="ShareTools"], [class*="social-share"] {
          display: none !important;
          visibility: hidden !important;
        }

        /* Force-clip elements with large border-radius to prevent decorative
           blobs from overflowing their container in PDF render (beehiiv, newsletters) */
        [style*="border-radius: 50%"],
        [style*="border-radius:50%"],
        [style*="border-radius: 9999"],
        [style*="border-radius:9999"],
        [style*="border-radius: 100%"],
        [style*="border-radius:100%"] {
          overflow: hidden !important;
          clip-path: inset(0) !important;
        }

        /* beehiiv puts a Tailwind decorative shadow inside small icon buttons:
           div.absolute.h-full.w-full.rounded-full.bg-black.opacity-10. Sized
           off the parent button (28x28) via position:relative. Our rule below
           that forces a:not(...) to position:static strips the anchor, so the
           absolute child detaches to the viewport and renders as a 1280x800
           black ellipse over page 1. Drop these decorative shadows entirely. */
        .absolute.h-full.w-full.rounded-full {
          display: none !important;
        }

        /* Prevent content overflow */
        body, html {
          max-width: 100% !important;
          overflow-x: hidden !important;
        }

        /* Text wrapping. Do NOT add max-width:100% here — beehiiv wraps small
           round social icons in flex-column <div>s; max-width on the wrapper
           makes the inner SVG explode to column width (giant black ellipse on
           page 1). Wide content is already capped by the img/table/pre rule. */
        p, span, div, li, td, th, h1, h2, h3, h4, h5, h6, a {
          word-wrap: break-word !important;
          overflow-wrap: break-word !important;
        }

        /* Prevent wide elements from overflowing */
        img, video, iframe, table, pre, code {
          max-width: 100% !important;
          height: auto !important;
        }

        /* Handle pre/code blocks */
        pre, code {
          white-space: pre-wrap !important;
          word-break: break-word !important;
        }

        /* Normalize footnote/citation superscripts */
        /* Some sites (darioamodei.com) style sup as "pills" with padding/background */
        /* which can cause vertical rendering issues in PDFs */
        sup, sub {
          display: inline !important;
          vertical-align: super !important;
          font-size: 0.75em !important;
          line-height: 0 !important;
          position: relative !important;
          padding: 0 !important;
          margin: 0 2px !important;
          background: transparent !important;
          border-radius: 0 !important;
        }
        sub {
          vertical-align: sub !important;
        }

        /* Ensure footnote links display inline */
        sup a, .footnote-ref, a.footnote-ref {
          display: inline !important;
          background: transparent !important;
          padding: 0 !important;
          text-decoration: none !important;
        }

        /* Hide footnote tooltips/popovers that appear on hover */
        /* These can render incorrectly (vertically) in PDFs */
        .footnote-tooltip, [class*="tooltip"], [class*="popover"],
        [role="tooltip"], [data-tooltip], .tippy-box, .tippy-content {
          display: none !important;
          visibility: hidden !important;
        }

        /* Modals, popups, overlays, and dialogs (non-floating variants caught by CSS).
           The :not() guards matter: sites set classes like "modal-open" /
           "has-overlay" on body or the app root while a popup is up — without
           the guards these substring selectors (specificity 0-1-0) out-rank the
           body/main force-visible rules above (0-0-1) and blank the whole PDF
           even though the screenshot (taken before style injection) looks fine. */
        .modal, .modal-backdrop,
        [class*="modal"]:not(body):not(html):not(main):not(article),
        [class*="overlay"]:not(body):not(html):not(main):not(article),
        [class*="popup"]:not(body):not(html):not(main):not(article),
        [class*="dialog"]:not(body):not(html):not(main):not(article),
        [role="dialog"],
        .subscription-widget-wrap, .subscribe-widget,
        .pencraft.pc-modal, [class*="pc-modal"] {
          display: none !important;
          visibility: hidden !important;
        }

        /* Inline CTAs and signup forms (not position:fixed, so JS won't catch them) */
        /* Ghost CMS / Outpost plugin */
        [class*="gh-post-upgrade"], [class*="subscribe-form"],
        [data-portal="signup"], [data-portal="subscribe"],
        [class*="outpost-cta"], [class*="outpost-subscribe"],
        [class*="outpost-slideup"], [class*="outpost-pub-container"],
        .footer-cta, .post-footer-cta, [class*="footer-cta"],
        /* Beehiiv */
        [class*="beehiiv"], .bee-popup, .bee-modal,
        /* Generic inline signup/paywall/newsletter CTAs.
           Same body/main guards as the modal block above — "gate"/"paywall"
           substrings show up on whole-page wrappers (e.g. metered-content
           roots), and hiding those blanks the PDF. */
        [data-testid*="paywall"],
        [class*="paywall"]:not(body):not(html):not(main):not(article),
        [class*="subscribe-prompt"], [class*="subscription-prompt"],
        [class*="newsletter-signup"], [class*="email-signup"],
        [class*="signup-modal"], [class*="signup-overlay"],
        /* "gateway" is the trap: NYT wraps the WHOLE article in
           div.vi-gateway-container (their metered-content gateway), which in
           the authed case holds the full body. [class*="gate"] matches it and
           blanks the PDF. Exempt gateway explicitly; the blank-print fallback
           below is the backstop for any other over-broad match. */
        [class*="gate"]:not(body):not(html):not(main):not(article):not([class*="gateway"]):not([class*="Gateway"]),
        [class*="Gate"]:not(body):not(html):not(main):not(article):not([class*="gateway"]):not([class*="Gateway"]) {
          display: none !important;
          visibility: hidden !important;
        }
      `
    });
    await injectedPrintStyle.evaluate(el => (el as Element).setAttribute('data-pdfzipper-style', ''));
    } catch (styleError) {
      // Style injection failed - continue with PDF generation anyway
      console.warn(`Style injection failed for ${url}: ${styleError instanceof Error ? styleError.message : styleError}`);
    }

    // Content guard for the substring hide rules (see CONTENT_GUARDED_HIDE_SELECTORS):
    // an element they hid that holds the bulk of the page's text is the article,
    // not chrome — restore it. Inline !important outranks the stylesheet's.
    try {
      const restored = await page.evaluate(
        ({ selectors, pageLen }: { selectors: string; pageLen: number }) => {
          let count = 0;
          for (const el of document.querySelectorAll(selectors)) {
            const h = el as HTMLElement;
            if (['BODY', 'HTML', 'MAIN', 'ARTICLE'].includes(h.tagName)) continue;
            if (window.getComputedStyle(h).display !== 'none') continue;
            // innerText of an unrendered element falls back to its text content.
            const len = (h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim().length;
            if (len < 500 || len < pageLen * 0.3) continue;
            h.style.setProperty('display', 'revert', 'important');
            h.style.setProperty('visibility', 'visible', 'important');
            count++;
          }
          return count;
        },
        { selectors: CONTENT_GUARDED_HIDE_SELECTORS.join(', '), pageLen: preStyleTextLen }
      );
      if (restored > 0) {
        console.log(`Restored ${restored} content-bearing element(s) hidden by chrome rules from ${url}`);
      }
    } catch (guardError) {
      console.warn(`Content guard failed for ${url}: ${guardError instanceof Error ? guardError.message : guardError}`);
    }

    // archive.today snapshot chrome removal: when capturing an archive.is/.today
    // snapshot (paywall fallback), strip archive's own UI so the PDF is just the
    // archived article — #HEADER is the top toolbar ("archive.today webpage
    // capture / Saved from history / <timestamp>"), and table#hashtags is the
    // left-edge percentage ruler (0% 10% … 100%). #SOLID holds the real article
    // and is kept. Gated to archive hosts so normal pages are untouched.
    if (/^https?:\/\/archive\.(is|today|ph|li|md|vn|fo)\//i.test(targetUrl)) {
      try {
        await page.evaluate(() => {
          document.getElementById('HEADER')?.remove();
          // Percentage ruler + any tiny element whose entire text is the scale.
          document.getElementById('hashtags')?.remove();
          for (const el of document.querySelectorAll('table, div, nav, aside')) {
            const t = (el.textContent || '').replace(/\s+/g, '').trim();
            if (/^(\d{1,3}%){5,}$/.test(t)) (el as HTMLElement).remove();
          }
        });
      } catch (archiveChromeError) {
        console.warn(`archive.today chrome strip failed for ${url}: ${archiveChromeError instanceof Error ? archiveChromeError.message : archiveChromeError}`);
      }
    }

    // Extract page title for filename generation (useful for non-descriptive URLs like HN)
    let pageTitle: string | undefined;
    try {
      pageTitle = await page.title();
      // Clean up common suffixes
      if (pageTitle) {
        pageTitle = pageTitle
          .replace(/\s*\|\s*Hacker News$/, '')
          .replace(/\s*[-–—]\s*YouTube$/, '')
          .replace(/\s*on X$/, '')
          .replace(/\s*\/ X$/, '')
          .trim();
      }

      // Single-title SPAs never update <title> per route: every qwen.ai post
      // reports "Qwen", so they'd all be filed under one name and overwrite
      // each other. Fall back to the page's headline, but only when the title
      // is nothing more than the site's own name (title reduces to a substring
      // of the hostname) — a deliberately short real title like "FAR.AI
      // Leaderboard 2026" carries information the h1 shouldn't displace.
      const siteName = (() => {
        try {
          const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
          const host = alnum(new URL(page.url()).hostname.replace(/^www\./, ''));
          const t = alnum(pageTitle || '');
          return t.length > 0 && host.includes(t);
        } catch {
          return false;
        }
      })();
      if (!pageTitle || siteName) {
        const headline = await page.evaluate(() => {
          const h1s = Array.from(document.querySelectorAll('h1'))
            .map((h) => (h as HTMLElement).innerText.trim())
            .filter((t) => t.length > 0);
          return h1s.length === 1 ? h1s[0] : null;
        });
        if (headline && headline.length <= 200 &&
            headline.length >= (pageTitle?.length ?? 0) + 10) {
          pageTitle = headline;
        }
      }
    } catch {
      // Title extraction failed, continue without it
    }

    await tracePhase(page, url, 'pre-print');

    // Generate PDF with scale to fit wide content on A4
    // 1280px viewport → 595pt A4 width requires ~0.8 scale
    const pdfOptions = {
      format,
      printBackground: true,
      margin,
      preferCSSPageSize: false,
      scale: 0.7
    };
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = Buffer.from(await withTimeout(
        page.pdf(pdfOptions), pdfTimeout, 'PDF generation'
      ));
    } catch (printError) {
      // Chromium's printToPDF can transiently fail ("Protocol error
      // (Page.printToPDF): Printing failed") on heavy/animated SPAs — the
      // renderer is mid-frame (running CSS animations, an oversized canvas) when
      // the print snapshot is requested. Let the page settle and retry once
      // before giving up; a one-shot renderer hiccup shouldn't fail the whole job.
      const msg = printError instanceof Error ? printError.message : String(printError);
      if (/printToPDF|Printing failed/i.test(msg)) {
        console.log(`printToPDF failed for ${url} (${msg}); settling and retrying once...`);
        await page.waitForTimeout(1500);
        pdfBuffer = Buffer.from(await withTimeout(
          page.pdf(pdfOptions), pdfTimeout, 'PDF generation (retry)'
        ));
      } else {
        throw printError;
      }
    }

    // Blank-print fallback: a near-empty PDF off a page whose screenshot
    // clearly rendered means print styling hid a content wrapper (the
    // screenshot is taken before style injection, the PDF after). Strip the
    // injected styles and print-media emulation, regenerate once. Thresholds
    // mirror the blank-page bot_detected check in conversion.worker.ts
    // (5KB PDF / 15KB screenshot).
    if (pdfBuffer.length < 5000 && screenshotBuffer.length >= 15000) {
      console.log(`Blank PDF (${pdfBuffer.length}B) from visibly-rendered page for ${url}; regenerating without injected print styles`);
      try {
        await page.evaluate(() => {
          document.querySelectorAll('style[data-pdfzipper-style]').forEach(el => el.remove());
        });
        const retryBuffer = await withTimeout(
          page.pdf(pdfOptions), pdfTimeout, 'PDF regeneration'
        );
        if (retryBuffer.length > pdfBuffer.length) {
          pdfBuffer = Buffer.from(retryBuffer);
        }
      } catch (regenError) {
        console.warn(`PDF regeneration failed for ${url}: ${regenError instanceof Error ? regenError.message : regenError}`);
      }
    }

    // Nitter tweet pages stay lenient; a successful hop to Nitter's full
    // article renderer is long-form content and gets article naming/checks.
    const isNitterCapture = isTwitterUrl(url) && targetUrl !== url;

    return {
      success: true,
      pdfBuffer,
      screenshotBuffer: Buffer.from(screenshotBuffer),
      url,
      size: pdfBuffer.length,
      pageTitle,
      isXArticle: isNitterCapture ? isNitterArticleCapture : undefined,
      expandedUrl: expandedUrl !== url ? expandedUrl : undefined,
      tweetRelations,
      embeddedPdfUrl,
    };

  } finally {
    // CRITICAL: Always close context to prevent memory leaks
    await context.close();
  }
}
