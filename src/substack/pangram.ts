/**
 * Substack × Pangram AI-detection capture.
 *
 * Substack shipped reader-facing AI detection on 2026-07-21: any post over
 * ~100 words can be scanned by Pangram for machine-written text, and writers
 * can attach a "How I make this" disclosure statement. Both are things the KB
 * wants recorded at capture time — the verdict is computed against the post as
 * it stands, and a post edited later would score differently.
 *
 * The score is NOT in the page. Substack's server-rendered HTML carries only
 * the `enable_pangram_ai_detection` feature flag; the verdict is fetched on
 * demand when a reader opens the scan panel. So this is a plain HTTP harvest
 * (same shape as the Nitter tweet harvest — no Playwright), two unauthenticated
 * GETs:
 *
 *   1. /api/v1/posts/<slug>                 → the numeric post id
 *   2. /api/v1/pangram/detection/p-<id>     → the verdict
 *
 * Non-fatal and additive by construction: every failure path returns null and
 * the capture proceeds without the fields. Never throws.
 */

/** Detection results are small; a slow Substack must not stall a capture. */
const REQUEST_TIMEOUT_MS = 15000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

export interface PangramDetection {
  /** Raw API status: success | disabled | error | pending | … */
  type: string;
  /** Human-readable verdict, e.g. "Fully Human-Written", "Subscription required". */
  header?: string;
  /** Longer explanation shown under the verdict. */
  details?: string;
  /** Present only on `success`. Fractions of the post's text, summing to ~1. */
  fractionAi?: number;
  fractionAiAssisted?: number;
  fractionHuman?: number;
  /** The writer's own "How I make this" statement, when they've written one. */
  disclosure?: string;
}

/**
 * Split a Substack post URL into the API origin and the post slug.
 *
 * Handles both the canonical form (`<pub>.substack.com/p/<slug>`, and custom
 * domains like `newsletter.semianalysis.com/p/<slug>`, which serve the same
 * API) and the app/reader share form (`open.substack.com/pub/<pub>/p/<slug>`),
 * whose own host has no post API — it has to be resolved to the publication.
 *
 * Exported for testing.
 */
export function parseSubstackPostUrl(
  url: string
): { apiBase: string; slug: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '');

    if (host === 'open.substack.com') {
      const reader = path.match(/^\/pub\/([^/]+)\/p\/([^/]+)$/);
      return reader
        ? { apiBase: `https://${reader[1]}.substack.com`, slug: reader[2] }
        : null;
    }

    const post = path.match(/^\/p\/([^/]+)$/);
    if (!post) return null;
    return { apiBase: `${parsed.protocol}//${parsed.host}`, slug: post[1] };
  } catch {
    return null;
  }
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Longest disclosure we'll embed; writers can be expansive. */
const MAX_DISCLOSURE_CHARS = 1200;

/**
 * Writers type these by hand, so they arrive with CRLFs and stray blank lines.
 * Normalise to LF and cap the length — this is a metadata field, and the post
 * itself is right there in the PDF if someone needs the unabridged version.
 */
function normalizeDisclosure(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const clean = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return undefined;
  return clean.length > MAX_DISCLOSURE_CHARS
    ? `${clean.slice(0, MAX_DISCLOSURE_CHARS - 1).trimEnd()}…`
    : clean;
}

/**
 * Fetch the Pangram verdict for a Substack post URL. Returns null when the URL
 * isn't a Substack post, the post can't be resolved, or anything goes wrong.
 */
export async function fetchPangramDetection(url: string): Promise<PangramDetection | null> {
  const target = parseSubstackPostUrl(url);
  if (!target) return null;

  const post = await getJson(`${target.apiBase}/api/v1/posts/${encodeURIComponent(target.slug)}`);
  const postId = asNumber((post as { id?: unknown } | null)?.id);
  if (postId === undefined) return null;

  const raw = await getJson(`${target.apiBase}/api/v1/pangram/detection/p-${postId}`);
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const type = asString(record.type);
  if (!type) return null;

  const disclosure = (record.disclosure ?? null) as Record<string, unknown> | null;

  return {
    type,
    header: asString(record.header),
    details: asString(record.details),
    fractionAi: asNumber(record.fraction_ai),
    fractionAiAssisted: asNumber(record.fraction_ai_assisted),
    fractionHuman: asNumber(record.fraction_human),
    disclosure: normalizeDisclosure(disclosure?.text),
  };
}

/** Render a fraction as a whole-number percentage ("0.67" → "67%"). */
function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Convert a detection into PDF Info Dict fields.
 *
 * `AIDetection` is always set when we got any answer at all, including the
 * unhappy ones ("Subscription required", "Not eligible for AI detection") —
 * recording that the check ran and couldn't produce a score is strictly more
 * informative to the KB than silence, which is indistinguishable from "this
 * isn't a Substack post". Percentages are only present on a real verdict.
 *
 * Exported for testing.
 */
export function pangramInfoDictFields(
  detection: PangramDetection,
  now: Date = new Date()
): Record<string, string> {
  const fields: Record<string, string> = {
    AIDetection: detection.header || detection.type,
    AIDetectionStatus: detection.type,
    AIDetectionSource: 'Pangram via Substack',
    AIDetectionCheckedAt: now.toISOString(),
  };
  if (detection.details) fields.AIDetectionDetails = detection.details;
  if (detection.fractionAi !== undefined) fields.AIDetectionAI = percent(detection.fractionAi);
  if (detection.fractionAiAssisted !== undefined) {
    fields.AIDetectionAIAssisted = percent(detection.fractionAiAssisted);
  }
  if (detection.fractionHuman !== undefined) {
    fields.AIDetectionHuman = percent(detection.fractionHuman);
  }
  if (detection.disclosure) fields.AIDisclosure = detection.disclosure;
  return fields;
}
