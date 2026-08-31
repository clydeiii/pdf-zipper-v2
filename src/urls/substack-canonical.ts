/**
 * Substack dedup canonicalization.
 *
 * The same post has three URL spellings depending on where the bookmark was
 * made (observed live 2026-08-29, both bookmarked within hours and both
 * captured as separate PDFs):
 *   - iOS share sheet:  open.substack.com/pub/dwarkesh/p/openai-huggingface?r=…&utm_medium=ios
 *   - Chrome (custom domain): www.dwarkesh.com/p/openai-huggingface
 *   - Substack subdomain:     dwarkesh.substack.com/p/openai-huggingface
 *
 * String normalization alone can't equate them — the pub name → custom domain
 * mapping only exists on Substack's side. The pub root does expose it though:
 * `https://<pub>.substack.com/` 301s to the custom domain root when one is
 * configured. So a post URL expands to a CANDIDATE SET of dedup keys:
 *   1. the resolved custom-domain form (one cached HEAD per pub),
 *   2. the static `<pub>.substack.com` form (works with no network),
 *   3. the raw normalized URL (matches seen-set entries from before this fix).
 * `isUrlSeen` treats a hit on ANY candidate as seen; `markUrlSeen` adds ALL of
 * them. That makes dedup hold in both bookmark orders — a custom-domain
 * bookmark needs no Substack detection at all, because its plain normalized
 * key IS candidate 1 of the other spellings — and degrades to the static form
 * when resolution fails rather than flapping.
 *
 * Dedup keys only: nothing here touches the URL used for capture.
 */
import { normalizeBookmarkUrl } from './normalizer.js';

const RESOLVE_TIMEOUT_MS = 5_000;

/** Substack-operated subdomains that are never a publication. */
const NON_PUB_SUBDOMAINS = new Set(['www', 'open', 'on', 'api', 'support', 'read', 'substackcdn']);

/**
 * Recognise the two Substack-hosted post URL shapes. Custom domains return
 * null on purpose — they are already the canonical spelling.
 * Exported for testing.
 */
export function parseSubstackPubPost(url: string): { pubHost: string; slug: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '');

  if (host === 'open.substack.com') {
    const reader = path.match(/^\/pub\/([\w-]+)\/p\/([^/]+)$/);
    return reader ? { pubHost: `${reader[1]}.substack.com`, slug: reader[2] } : null;
  }

  const sub = host.match(/^([\w-]+)\.substack\.com$/);
  if (!sub || NON_PUB_SUBDOMAINS.has(sub[1])) return null;
  const post = path.match(/^\/p\/([^/]+)$/);
  return post ? { pubHost: host, slug: post[1] } : null;
}

export type PubHostResolver = (pubHost: string) => Promise<string | null>;

/**
 * Resolve a pub's canonical host via its root redirect. Returns the pub host
 * itself when there is no custom domain (root serves 2xx), null on any
 * failure so the caller can retry on a later URL from the same pub.
 */
async function resolveViaRedirect(pubHost: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${pubHost}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) return new URL(location, `https://${pubHost}/`).hostname;
    }
    return res.ok ? pubHost : null;
  } catch {
    return null;
  }
}

/** pubHost → canonical host. In-memory only: one HEAD per pub per process. */
const pubHostCache = new Map<string, string>();

/**
 * Dedup key candidates for a Substack-hosted post URL, or null when the URL
 * isn't one (caller falls back to plain normalization).
 * The resolver parameter exists for tests; production uses the redirect.
 */
export async function substackDedupCandidates(
  url: string,
  resolver: PubHostResolver = resolveViaRedirect
): Promise<string[] | null> {
  const post = parseSubstackPubPost(url);
  if (!post) return null;

  let canonicalHost = pubHostCache.get(post.pubHost);
  if (!canonicalHost) {
    const resolved = await resolver(post.pubHost);
    if (resolved) {
      canonicalHost = resolved;
      pubHostCache.set(post.pubHost, resolved);
    }
  }

  const candidates = new Set<string>();
  if (canonicalHost) candidates.add(normalizeBookmarkUrl(`https://${canonicalHost}/p/${post.slug}`));
  candidates.add(normalizeBookmarkUrl(`https://${post.pubHost}/p/${post.slug}`));
  candidates.add(normalizeBookmarkUrl(url));
  return [...candidates];
}

/**
 * Substack share params. `r=` is the sharer's personal reader token — it
 * identifies the user, so it must NEVER reach stored metadata (PDF Subject,
 * Karakeep injection, exported files). The rest is share-flow noise.
 */
const SHARE_PARAMS = ['r', 'showWelcomeOnShare', 'triedRedirect'];

/**
 * Strip Substack share params from a post-shaped URL (`/p/<slug>` on any
 * host — custom-domain "copy link" also appends `?r=…&utm_medium=web`, and
 * the host alone can't tell us it's Substack). Returns null when unchanged.
 * Exported for testing.
 */
export function stripSubstackShareParams(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^\/p\/[^/]+\/?$/.test(parsed.pathname)) return null;
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (SHARE_PARAMS.includes(key) || /^utm_/i.test(key)) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? parsed.toString().replace(/\?$/, '') : null;
}

/**
 * The URL a Substack post should be STORED under — capture target, PDF
 * Subject, filename, Karakeep injection — regardless of which device made
 * the bookmark. Substack-hosted spellings are rebuilt as
 * `https://<canonical host>/p/<slug>` (custom domain when the pub root
 * resolves, `<pub>.substack.com` otherwise — the share token is gone either
 * way); custom-domain post URLs just lose their share params. Returns null
 * when the URL isn't a Substack post or is already clean.
 */
export async function canonicalizeSubstackUrl(
  url: string,
  resolver: PubHostResolver = resolveViaRedirect
): Promise<string | null> {
  const post = parseSubstackPubPost(url);
  if (!post) return stripSubstackShareParams(url);

  let host = pubHostCache.get(post.pubHost);
  if (!host) {
    const resolved = await resolver(post.pubHost);
    if (resolved) {
      host = resolved;
      pubHostCache.set(post.pubHost, resolved);
    }
  }
  const canonical = `https://${host ?? post.pubHost}/p/${post.slug}`;
  return canonical === url ? null : canonical;
}
