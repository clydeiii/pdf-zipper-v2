/**
 * JSON-LD articleBody rescue for SPA shells.
 *
 * News SPAs (Axios and similar) server-embed the full article text as
 * NewsArticle JSON-LD in the initial HTML, while the visible body hydrates
 * client-side via XHR. When that XHR is dropped or bot-gated, the rendered
 * page is a shell (headline + hero + related-content rail) but the JSON-LD
 * still carries the complete text — recover the body from there instead of
 * failing the capture as truncated.
 */

/** Article-ish @type values whose articleBody we trust as page content. */
const ARTICLE_TYPES = new Set([
  'Article',
  'NewsArticle',
  'ReportageNewsArticle',
  'AnalysisNewsArticle',
  'BackgroundNewsArticle',
  'OpinionNewsArticle',
  'ReviewNewsArticle',
  'BlogPosting',
  'TechArticle',
]);

function isArticleType(type: unknown): boolean {
  if (typeof type === 'string') return ARTICLE_TYPES.has(type);
  if (Array.isArray(type)) return type.some((t) => typeof t === 'string' && ARTICLE_TYPES.has(t));
  return false;
}

/** Recursively collect articleBody strings from any JSON-LD shape (@graph, arrays, nesting). */
function collectBodies(node: unknown, out: string[], depth = 0): void {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectBodies(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.articleBody === 'string' && isArticleType(obj['@type'])) {
    out.push(obj.articleBody);
  }
  // Only descend into the containers JSON-LD actually uses for nesting —
  // walking every key would happily pull articleBody out of unrelated
  // embedded structures (e.g. a "relatedArticles" list of OTHER stories).
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    if (key in obj) collectBodies(obj[key], out, depth + 1);
  }
}

/**
 * Given the raw text of every `<script type="application/ld+json">` on a page,
 * return the longest Article/NewsArticle `articleBody`, or null if none found.
 */
export function extractJsonLdArticleBody(scriptContents: string[]): string | null {
  const bodies: string[] = [];
  for (const raw of scriptContents) {
    if (!raw || raw.length > 2_000_000) continue;
    try {
      collectBodies(JSON.parse(raw), bodies);
    } catch {
      // malformed JSON-LD — skip this script block
    }
  }
  if (bodies.length === 0) return null;
  return bodies.reduce((a, b) => (b.length > a.length ? b : a));
}
