/** Shared by capture, the nightly report, and the host calibration script. */
export function normalizeForAnchorMatch(text: string): string {
  return text
    // Join discretionary wraps before collapsing whitespace, which would
    // otherwise erase the distinction between a line wrap and a real hyphen.
    .replace(/\u00ad[\t ]*(?:\r?\n[\t ]*)?/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/(\p{L})-[\t ]*\r?\n\s*(?=\p{L})/gu, '$1')
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Exactly three unique sentences, or none: a weak substitute for a missing
 * tail candidate would make "last anchor missing" claim evidence we lack.
 * sourceText keeps positions relative to the entire container (including
 * code/other ineligible text); callers with prose alone can omit it.
 */
export function pickAnchors(paragraphs: string[], sourceText = paragraphs.join('\n')): string[] {
  const source = normalizeForAnchorMatch(sourceText);
  if (!source) return [];
  const candidates: Array<{ text: string; position: number }> = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  let cursor = 0;
  for (const paragraph of paragraphs) {
    const text = normalizeForAnchorMatch(paragraph);
    if (!text) continue;
    const start = source.indexOf(text, cursor);
    if (start < 0) continue;
    cursor = start + text.length;
    let sentenceCursor = 0;
    // Segment before lowercasing: Intl uses the capital after a period to
    // distinguish a sentence boundary from an abbreviation.
    for (const sentence of segmenter.segment(paragraph)) {
      const anchor = normalizeForAnchorMatch(sentence.segment);
      const sentenceStart = text.indexOf(anchor, sentenceCursor);
      if (sentenceStart < 0 || !anchor) continue;
      sentenceCursor = sentenceStart + anchor.length;
      if (anchor.length < 60 || anchor.length > 200 || anchor.split(' ').length < 6) continue;
      // Reserve JSON punctuation/escaping so even three long anchors fit
      // in the 600-character Info Dict field without cutting a sentence.
      if (JSON.stringify(anchor).length > 198) continue;
      const offset = source.indexOf(anchor);
      if (source.indexOf(anchor, offset + 1) !== -1) continue;
      candidates.push({ text: anchor, position: (start + sentenceStart + anchor.length / 2) / source.length });
    }
  }
  const regions = [
    candidates.filter(c => c.position <= 0.1),
    candidates.filter(c => c.position > 0.1 && c.position < 0.9),
    candidates.filter(c => c.position >= 0.9),
  ];
  const anchors = regions.map((region, index) => {
    const target = index / 2;
    region.sort((a, b) => Math.abs(a.position - target) - Math.abs(b.position - target));
    return region[0]?.text;
  });
  return anchors.every((a): a is string => Boolean(a)) ? anchors : [];
}

/** Malformed/partial metadata is unmeasured, never evidence of truncation. */
export function checkAnchors(anchorsJson: string | undefined, pdfText: string): { missing: number[]; lastMissing: boolean } {
  let anchors: unknown;
  try { anchors = JSON.parse(anchorsJson || 'null'); } catch { return { missing: [], lastMissing: false }; }
  if (!Array.isArray(anchors) || anchors.length !== 3 ||
      !anchors.every(a => typeof a === 'string' && normalizeForAnchorMatch(a).length > 0)) {
    return { missing: [], lastMissing: false };
  }
  const text = normalizeForAnchorMatch(pdfText);
  const missing = anchors.flatMap((anchor: string, index: number) =>
    text.includes(normalizeForAnchorMatch(anchor)) ? [] : [index]);
  return { missing, lastMissing: missing.includes(2) };
}

/** Report-only evidence; never call this from a save-time quality gate. */
export function buildAnchorFlags(
  anchorsJson: string | undefined,
  pdfText: string,
  sourceTextChars?: number | string,
): string[] {
  const { missing, lastMissing } = checkAnchors(anchorsJson, pdfText);
  if (!missing.length) return [];
  const flags: string[] = [];
  if (lastMissing) flags.push('truncation_suspect: last anchor missing');
  flags.push(`truncation_suspect: ${missing.length} of 3 anchors missing`);
  const sourceLength = Number(sourceTextChars);
  const ratio = normalizeForAnchorMatch(pdfText).length / sourceLength;
  if (Number.isFinite(sourceLength) && sourceLength > 0 && ratio < 0.6) {
    flags.push(`length_mismatch: PDF text is ${Math.round(ratio * 100)}% of SourceTextChars`);
  }
  return flags;
}
