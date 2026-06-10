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
