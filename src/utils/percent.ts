/**
 * Parse an Info Dict percentage value ("67%") into a number.
 *
 * Lives in its own module so tests can import it without pulling in the API
 * router (which opens Redis connections and never lets the process exit).
 *
 * Returns undefined for absent or malformed values, and never conflates those
 * with 0 — "measured, no AI detected" and "never checked" are different facts
 * and the UI has to be able to tell them apart.
 */
export function parsePercentField(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

/**
 * Share of a post's text that Pangram did NOT attribute to a human — i.e.
 * fully-AI plus AI-assisted.
 *
 * This, not the fully-AI figure alone, is what "how much AI is in this?" means.
 * A real capture in the library reads ai=0%, assisted=51%, human=49%: Pangram
 * calls it "Partially AI-assisted text", but keying off the fully-AI number
 * would badge it "AI 0%" and hide it from every threshold filter.
 *
 * Derived from the human fraction where available, since that's the one figure
 * guaranteed to be the complement of everything else; falls back to summing the
 * two AI fractions.
 */
export function aiInvolvementPercent(parts: {
  ai?: number;
  assisted?: number;
  human?: number;
}): number | undefined {
  if (typeof parts.human === 'number') return Math.round(100 - parts.human);
  if (typeof parts.ai === 'number') return Math.round(parts.ai + (parts.assisted ?? 0));
  return undefined;
}
