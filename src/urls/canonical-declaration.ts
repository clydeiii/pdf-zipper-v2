/**
 * General canonical-URL dedup layer: `rel="canonical"` / `og:url`.
 *
 * The per-domain rules (YouTube ids, Substack pub resolution, X share
 * params) encode verified knowledge of which URL parts are identity vs
 * noise. This layer is the general fallback for the long tail: ask the page
 * itself. Nearly every site declares its canonical URL in the head — the
 * clean spelling without share tokens or tracking params — so two different
 * bookmarked spellings of one article meet at the declared key.
 *
 * DEDUP KEYS ONLY. The declared canonical never touches storage (filenames,
 * PDF Subject) — sites mis-declare canonicals, and a wrong storage URL
 * overwrites the wrong file. A wrong dedup candidate is benign by
 * construction: articles refresh-on-seen rather than skip, and media items
 * never consult this layer (their skip gate stays on the exact per-domain
 * rules).
 *
 * Guards, because sites lie:
 * - the declared canonical must retain an identity token of the original
 *   URL (last path segment or a long query value) — rejects the classic
 *   homepage/section mis-declaration that would collapse many articles
 *   into one key;
 * - hosts with dedicated handling (YouTube, X, Substack, Apple Podcasts)
 *   and direct-file URLs are ineligible — no wasted fetch, no interference;
 * - any fetch failure yields no candidate: behavior degrades to plain
 *   string normalization, never worse than before this layer existed.
 */
import { normalizeBookmarkUrl, canonicalizeYouTubeUrl } from './normalizer.js';
import { parseSubstackPubPost } from './substack-canonical.js';

const FETCH_TIMEOUT_MS = 6_000;
const HEAD_SCAN_CHARS = 200_000;
const CACHE_MAX = 1_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Hosts already covered by dedicated canonicalization or routing. */
const INELIGIBLE_HOSTS = /(^|\.)((x|twitter|youtube)\.com|youtu\.be|substack\.com|podcasts\.apple\.com|arxiv\.org)$/i;

/** True when this URL is worth a declaration fetch. Exported for testing. */
export function isDeclarationEligible(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (INELIGIBLE_HOSTS.test(parsed.hostname)) return false;
  if (canonicalizeYouTubeUrl(url)) return false;
  if (parseSubstackPubPost(url)) return false;
  if (/\.(pdf|mp[34]|zip)$/i.test(parsed.pathname)) return false;
  return true;
}

/**
 * Pull rel=canonical (or og:url as fallback) out of a page head. Relative
 * hrefs resolve against the page URL. Exported for testing.
 */
export function extractDeclaredCanonical(html: string, pageUrl: string): string | null {
  const head = html.slice(0, HEAD_SCAN_CHARS);
  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  let href: string | null = null;
  for (const tag of links) {
    if (!/rel\s*=\s*["']?canonical["']?/i.test(tag)) continue;
    const m = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (m) {
      href = m[1];
      break;
    }
  }
  if (!href) {
    const og = head.match(/<meta\b[^>]*property\s*=\s*["']og:url["'][^>]*content\s*=\s*["']([^"']+)["']/i)
      ?? head.match(/<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:url["']/i);
    if (og) href = og[1];
  }
  if (!href) return null;
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}

/** Identity tokens the canonical must retain: a sluggy last path segment
 * (with and without extension) and long query values. Generic section words
 * ("blog", "news") must NOT count — on sites where the post id lives in the
 * query string (qwen.ai/blog?id=…) they'd let a bare section page pass. A
 * slug's signature: 5+ chars with a hyphen/underscore/digit, or 12+ chars. */
function identityTokens(url: URL): string[] {
  const tokens: string[] = [];
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const sluggy = last && ((last.length >= 5 && /[-_0-9]/.test(last)) || last.length >= 12);
  if (last && sluggy) {
    tokens.push(last.toLowerCase());
    const bare = last.replace(/\.[a-z0-9]{1,5}$/i, '');
    if (bare.length >= 4 && bare !== last) tokens.push(bare.toLowerCase());
  }
  for (const value of url.searchParams.values()) {
    if (value.length >= 4) tokens.push(value.toLowerCase());
  }
  return tokens;
}

/**
 * Accept a declared canonical only when it keeps an identity token of the
 * original — the guard against homepage/section mis-declarations.
 * Exported for testing.
 */
export function acceptDeclaredCanonical(originalUrl: string, canonicalUrl: string): boolean {
  let original: URL;
  let canonical: URL;
  try {
    original = new URL(originalUrl);
    canonical = new URL(canonicalUrl);
  } catch {
    return false;
  }
  if (canonical.protocol !== 'http:' && canonical.protocol !== 'https:') return false;
  const tokens = identityTokens(original);
  if (tokens.length === 0) return false;
  const haystack = canonicalUrl.toLowerCase();
  return tokens.some((t) => haystack.includes(t));
}

export type PageFetcher = (url: string) => Promise<{ finalUrl: string; html: string } | null>;

async function fetchPage(url: string): Promise<{ finalUrl: string; html: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type && !type.includes('html')) return null;
    return { finalUrl: res.url || url, html: await res.text() };
  } catch {
    return null;
  }
}

/** url → resolved candidates (or null), so isUrlSeen/markUrlSeen/getUrlSource
 * on the same bookmark share one fetch. Insertion-order eviction. */
const declarationCache = new Map<string, string[] | null>();

/**
 * Extra dedup-key candidates from the page's own canonical declaration (and
 * the post-redirect URL, which un-shortens share links). Returns null when
 * the URL is ineligible, the fetch fails, or nothing passes the guards.
 */
export async function declaredCanonicalCandidates(
  url: string,
  fetcher: PageFetcher = fetchPage
): Promise<string[] | null> {
  if (!isDeclarationEligible(url)) return null;
  if (declarationCache.has(url)) return declarationCache.get(url) ?? null;

  const page = await fetcher(url);
  let result: string[] | null = null;
  if (page) {
    const found = new Set<string>();
    const declared = extractDeclaredCanonical(page.html, page.finalUrl);
    if (declared && acceptDeclaredCanonical(url, declared)) {
      found.add(normalizeBookmarkUrl(declared));
    }
    if (page.finalUrl && page.finalUrl !== url && acceptDeclaredCanonical(url, page.finalUrl)) {
      found.add(normalizeBookmarkUrl(page.finalUrl));
    }
    found.delete(normalizeBookmarkUrl(url));
    if (found.size > 0) result = [...found];
  }

  if (declarationCache.size >= CACHE_MAX) {
    const oldest = declarationCache.keys().next().value;
    if (oldest !== undefined) declarationCache.delete(oldest);
  }
  declarationCache.set(url, result);
  return result;
}
