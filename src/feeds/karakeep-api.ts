/**
 * Minimal Karakeep write API client.
 *
 * Used by manual capture to inject the captured URL into Karakeep, so a later
 * bookmark of the same URL via the Karakeep Chrome plugin dedupes there
 * ("already saved") instead of creating a fresh bookmark. The pdf-zipper-side
 * overwrite protection is separate (deduplicator.markUrlSeen) — this is about
 * keeping Karakeep itself consistent with what's already been captured.
 *
 * Auth mirrors src/maintenance/karakeep-cleaner.ts: Bearer KARAKEEP_API_TOKEN
 * against KARAKEEP_API_BASE. No-op (returns null) when either is unset.
 */

const KARAKEEP_API_BASE = process.env.KARAKEEP_API_BASE;
const KARAKEEP_API_TOKEN = process.env.KARAKEEP_API_TOKEN;

export interface KarakeepBookmarkResult {
  id: string;
  alreadyExists: boolean;
}

/**
 * Create a link bookmark in Karakeep. Karakeep dedupes link bookmarks by URL
 * and returns the existing bookmark with `alreadyExists: true` when present.
 * Returns null when the API isn't configured. Throws on HTTP/network errors —
 * callers treat this as non-fatal.
 */
export async function createKarakeepBookmark(
  url: string,
  title?: string
): Promise<KarakeepBookmarkResult | null> {
  if (!KARAKEEP_API_BASE || !KARAKEEP_API_TOKEN) return null;

  const endpoint = new URL('/api/v1/bookmarks', KARAKEEP_API_BASE);
  const res = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KARAKEEP_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'link',
      url,
      ...(title ? { title: title.slice(0, 250) } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Karakeep bookmark create failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { id?: string; alreadyExists?: boolean };
  return {
    id: json.id || '',
    alreadyExists: json.alreadyExists === true,
  };
}

/**
 * Find bookmark ids whose link URL matches `url` (normalized equality). The
 * API has no URL lookup and its search indexes titles, so this walks the
 * newest pages; dead-URL pruning is rare enough that a few pages is fine.
 * Returns [] when the API isn't configured.
 */
export async function findKarakeepBookmarkIdsByUrl(
  url: string,
  maxPages = 15
): Promise<string[]> {
  if (!KARAKEEP_API_BASE || !KARAKEEP_API_TOKEN) return [];
  const { normalizeBookmarkUrl } = await import('../urls/normalizer.js');
  const target = normalizeBookmarkUrl(url);
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const endpoint = new URL('/api/v1/bookmarks', KARAKEEP_API_BASE);
    endpoint.searchParams.set('limit', '100');
    if (cursor) endpoint.searchParams.set('cursor', cursor);
    const res = await fetch(endpoint.toString(), {
      headers: { Authorization: `Bearer ${KARAKEEP_API_TOKEN}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Karakeep list failed: HTTP ${res.status}`);
    const data = (await res.json()) as { bookmarks?: Array<{ id: string; content?: { url?: string } }>; nextCursor?: string };
    for (const b of data.bookmarks ?? []) {
      const u = b.content?.url;
      if (u && normalizeBookmarkUrl(u) === target) ids.push(b.id);
    }
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  return ids;
}

/** Delete one Karakeep bookmark by id. Throws on HTTP/network errors. */
export async function deleteKarakeepBookmark(id: string): Promise<void> {
  if (!KARAKEEP_API_BASE || !KARAKEEP_API_TOKEN) return;
  const endpoint = new URL(`/api/v1/bookmarks/${encodeURIComponent(id)}`, KARAKEEP_API_BASE);
  const res = await fetch(endpoint.toString(), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${KARAKEEP_API_TOKEN}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Karakeep delete failed: HTTP ${res.status}`);
}

/** Delete every Karakeep bookmark for a URL; returns how many were removed. */
export async function deleteKarakeepBookmarksByUrl(url: string): Promise<number> {
  const ids = await findKarakeepBookmarkIdsByUrl(url);
  for (const id of ids) {
    await deleteKarakeepBookmark(id);
    console.log(`[karakeep] Deleted bookmark ${id} for dead URL ${url}`);
  }
  return ids.length;
}
