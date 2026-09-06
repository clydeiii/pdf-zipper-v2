/**
 * Substack preview gate — the one paywall no text heuristic can see.
 *
 * A Substack post rendered without the reader's subscription is a PREVIEW:
 * the free portion, ending on whatever sentence the writer put before the
 * paywall, followed by the normal footer. Our print stylesheet hides the
 * "This post is for paid subscribers" box (it matches the paywall chrome
 * rules), so the PDF reads as a short, complete, cleanly-ending article and
 * clears every length/density/pattern gate — confirmed false accepts:
 * groundlevel-ai.com 2026-08-21 (via smry), aidisruption.ai 2026-09-05
 * (primary capture, QualityScore 95, 270 of 1,346 words archived as a
 * success). Substack's own post API reports `audience` and the TRUE
 * `wordcount`, so the gate compares against that instead.
 *
 * Free posts (`audience: everyone`) can render as previews too — Substack's
 * sign-in gate truncated sources.news at 120 of 1,314 words — but a free
 * post's extraction also legitimately drops captions, embeds and footnotes,
 * so they are held only to a gross-shortfall bar.
 *
 * Lives in src/quality (inside the self-heal write boundary) on purpose: the
 * fidelity corpus records `substackPost` facts for its Substack entries and
 * replays this check, so a fix batch that loosens it fails the gate.
 */

import { parseSubstackPostUrl } from '../substack/pangram.js';

export interface SubstackPostFacts {
  audience: string;
  wordcount: number;
}

/** Paid audiences: a real preview is well under half the post. 0.9 leaves room for dropped captions/embeds. */
const PAID_MIN_RATIO = 0.9;
/** Free posts: only a gross shortfall is evidence of a preview, not extraction loss. */
const FREE_MIN_RATIO = 0.5;

/**
 * CJK scripts don't space-separate words, so whitespace splitting counts a
 * Chinese post at ~1/7 of Substack's figure and the gate rejects a complete
 * free post as a preview (2026-09-06: funeralai.substack.com/p/manus —
 * 298 whitespace tokens vs a declared 2,088). Calibrated on that post:
 * Substack's counter comes out near one word per 1.6 CJK characters
 * (3,048 chars + 457 Latin words → 2,362 vs 2,088). Slight overcounting is
 * the safe direction — a real preview is a fraction of the body either way.
 */
const CJK_CHARS = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g;
const CJK_CHARS_PER_WORD = 1.6;

export function countWords(text: string): number {
  const cjkChars = (text.match(CJK_CHARS) || []).length;
  const latinWords = text.replace(CJK_CHARS, ' ').split(/\s+/).filter(Boolean).length;
  return latinWords + Math.round(cjkChars / CJK_CHARS_PER_WORD);
}

/**
 * Human-readable rejection reason when the extracted text is a preview of the
 * post the API describes, or null when the extraction is acceptable (or the
 * facts are unusable). Pure; exported for the harness and tests.
 */
export function substackPreviewShortfall(
  extractedText: string,
  audience: string | undefined,
  wordcount: number | undefined,
): string | null {
  if (!audience) return null;
  if (typeof wordcount !== 'number' || !Number.isFinite(wordcount) || wordcount <= 0) return null;
  const extractedWords = countWords(extractedText);
  const ratio = audience === 'everyone' ? FREE_MIN_RATIO : PAID_MIN_RATIO;
  if (extractedWords < wordcount * ratio) {
    return `Substack ${audience} post: extracted ${extractedWords} of ${wordcount} words — ${audience === 'everyone' ? 'preview only (free post rendered without the body)' : 'paid-preview only'}`;
  }
  return null;
}

/**
 * `audience` + `wordcount` from Substack's post API for a post URL of any
 * spelling (pub subdomain, custom domain, open.substack.com share link).
 * Null when the URL is not a Substack post or on any network/API failure —
 * callers treat null as "no evidence", never as a verdict.
 */
export async function fetchSubstackPostFacts(postUrl: string): Promise<SubstackPostFacts | null> {
  const target = parseSubstackPostUrl(postUrl);
  if (!target) return null;
  try {
    const res = await fetch(`${target.apiBase}/api/v1/posts/${encodeURIComponent(target.slug)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const post = (await res.json()) as { audience?: unknown; wordcount?: unknown } | null;
    if (!post || typeof post !== 'object') return null;
    if (typeof post.audience !== 'string' || typeof post.wordcount !== 'number') return null;
    return { audience: post.audience, wordcount: post.wordcount };
  } catch {
    return null;
  }
}

/**
 * Fetch-side wrapper: the rejection reason for a preview, or null. A network
 * blip is never a reason to fail a capture (the page may be gone tomorrow).
 */
export async function checkSubstackPreview(postUrl: string, extractedText: string): Promise<string | null> {
  const facts = await fetchSubstackPostFacts(postUrl);
  if (!facts) return null;
  return substackPreviewShortfall(extractedText, facts.audience, facts.wordcount);
}
