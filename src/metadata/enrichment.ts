/**
 * AI-powered metadata enrichment for PDF documents
 *
 * Uses Ollama to extract structured metadata from PDF text content:
 * - Title, author, publication, publish date
 * - Language detection
 * - AI-generated summary
 * - Topic tags/keywords
 * - Full English translation (for non-English documents)
 */

import { env } from '../config/env.js';
import { chatText } from '../utils/llm-chat.js';

/**
 * Enriched metadata extracted from document content
 */
export interface EnrichedMetadata {
  /** Article/document title */
  title: string;
  /** Author name(s) */
  author: string | null;
  /** Publisher or publication name */
  publication: string | null;
  /** Publish date in ISO 8601 format */
  publishDate: string | null;
  /** ISO 639-1 language code (e.g., 'en', 'fr', 'de', 'ja') */
  language: string;
  /** 2-3 sentence summary of the document */
  summary: string;
  /** Topic tags/keywords */
  tags: string[];
  /** Full English translation (only for non-English documents) */
  translation: string | null;
}

/** Max chars to send for metadata extraction (keep prompt reasonable) */
const MAX_EXTRACT_CHARS = 6000;

/** Max chars to send per translation chunk */
const MAX_TRANSLATE_CHARS = 10000;

/**
 * Extract structured metadata from document text using Ollama
 */
async function extractMetadata(
  text: string,
  url: string,
  pageTitle?: string
): Promise<Omit<EnrichedMetadata, 'translation'>> {
  const truncatedText = text.slice(0, MAX_EXTRACT_CHARS);

  const prompt = `You are a document metadata extraction assistant. Analyze the following article text and extract structured metadata.

Return ONLY a valid JSON object with these fields (no markdown, no explanation):
{
  "title": "the article's actual title (not the site name)",
  "author": "author name or null if not identifiable",
  "publication": "the site's own publisher/publication name, or null if unclear",
  "publishDate": "YYYY-MM-DD date or null",
  "language": "ISO 639-1 code (e.g., 'en', 'fr', 'de', 'ja', 'zh')",
  "summary": "2-3 sentence summary capturing the key points",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}

Guidelines:
- For title: prefer the actual article headline, not navigation text or site name
- For author: look for bylines ("By John Smith", "Written by..."), footer credits, or author names near the title. Also check for patterns like "FirstName LastName" immediately before or after the date
- For publication: name the site the text was published ON, reading it off the URL domain or the page's own masthead (e.g. "example-gazette.com" → "Example Gazette"). Never answer with a famous outlet just because the topic is newsworthy — an outlet mentioned or quoted inside the article is NOT the publisher. If the site has no name you can read off the page or the URL, return null
- For publishDate: look carefully for ANY date near the top of the text — it may appear as "January 15, 2025", "Jan 2025", "2025-01-15", "15/01/2025", or just "January 2025". Convert partial dates to the 1st of that month (e.g., "July 2024" → "2024-07-01"). Return null ONLY if there is truly no date anywhere in the text
- For tags: use 3-5 lowercase hyphenated topic tags (e.g., "machine-learning", "climate-change")
- For summary: be concise, factual, and capture the main argument or findings
- For language: detect the primary language of the body text, not headers/nav

URL: ${url}
${pageTitle ? `Page title: ${pageTitle}` : ''}

Article text:
${truncatedText}`;

  // Generate, then guard against a hallucinated person-name in the summary
  // (e.g. a model inventing "Dan O'Toole" for a Mike Krieger interview). Such
  // a name appears nowhere in the source/title, so it's detectable — regenerate
  // once (LLM nondeterminism usually clears a one-off). Cheap because it only
  // retries when an unsupported name is actually found.
  const supportHaystack = `${truncatedText}\n${pageTitle || ''}\n${url}`.toLowerCase();
  let result: Omit<EnrichedMetadata, 'translation'> | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const content = await chatText({
      model: env.ENRICHMENT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      numCtx: 8192,
    });
    result = parseMetadataResponse(content, url, pageTitle, truncatedText);
    const ghost = unsupportedSummaryName(result.summary, supportHaystack);
    if (!ghost) break;
    console.log(JSON.stringify({
      event: 'enrichment_summary_ghost_name',
      name: ghost,
      attempt,
      action: attempt < 2 ? 'regenerate' : 'kept_after_retry',
      timestamp: new Date().toISOString(),
    }));
  }
  return result!;
}

/**
 * Detect a person-like proper name in the summary that appears nowhere in the
 * source text / title / URL — a hallucinated entity. Returns the offending name
 * or null. Token-level word-boundary match (like validateFactualFields), so
 * "Mike Krieger" passes when both tokens are in source but "Dan O'Toole" fails
 * because "O'Toole" is absent. Names are 2-3 capitalized words (allowing O',
 * Mc, hyphens, middle initials) — orgs/products with all tokens present pass.
 */
export function unsupportedSummaryName(summary: string, haystack: string): string | null {
  if (!summary) return null;
  // Each name word: capital + letters/apostrophes/hyphens/dot (covers
  // "O'Toole", "McAfee", "Smith-Jones", middle initial "Q."). 2-3 words total.
  const NAME_RE = /\b[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,2}\b/g;
  const candidates = summary.match(NAME_RE) || [];
  for (const name of candidates) {
    const tokens = name.toLowerCase().split(/[\s.]+/).filter((t) => t.length >= 3);
    const present = (t: string) =>
      new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack);
    if (tokens.length > 0 && !tokens.every(present)) return name;
  }
  return null;
}

/** How far into the document to look for a masthead/byline naming the site. */
const PUBLICATION_EVIDENCE_CHARS = 3000;

/**
 * True when a publication name is actually supported by the capture, rather
 * than recalled from the model's priors. Two independent kinds of evidence:
 *
 * 1. Domain agreement — the name IS the site (x.com → "X", epoch.ai →
 *    "Epoch AI", nattothoughts.com → "Natto Thoughts").
 * 2. Masthead text — the name appears near the top of the document, which is
 *    where attribution lives. Deliberately NOT the whole body: an article
 *    quoting "as The New York Times reported" must not thereby become a NYT
 *    article.
 *
 * Exported for testing.
 */
export function isPublicationSupported(
  publication: string,
  sourceText: string,
  url: string
): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  // A leading "The" is a styling choice, not part of the identity.
  const pubWords = words(publication).replace(/^the /, '');
  const pubSquashed = squash(pubWords);
  if (!pubSquashed) return false;

  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    host = '';
  }
  const hostSquashed = squash(host);
  const brand = squash(host.split('.')[0]);

  // Exact brand match covers single-letter sites ("x.com" → "X") that the
  // length-gated containment checks below can't safely accept.
  if (pubSquashed === brand || pubSquashed === hostSquashed) return true;
  if (pubSquashed.length >= 4 && hostSquashed.includes(pubSquashed)) return true;
  if (brand.length >= 4 && pubSquashed.includes(brand)) return true;

  if (pubWords.length < 3) return false;
  return words(sourceText.slice(0, PUBLICATION_EVIDENCE_CHARS)).includes(pubWords);
}

/**
 * Hallucination guard for FACTUAL fields (Fidelity > Aesthetics — the KB
 * consumer trusts these as ground truth). Smaller/faster models fabricate
 * plausible authors ("John Smith", "Elon Musk") and dates that larger models
 * leave null. We only keep:
 * - author: every name token (3+ chars) appears verbatim in the source text
 * - publishDate: its 4-digit year appears in the source text or the URL
 * - publication: a WELL-KNOWN outlet name claimed on an unrelated domain is
 *   replaced by the domain-derived name (see claimsWellKnownPublisher). This
 *   is the one publication failure that actually shows up in the library —
 *   the model reaching for a famous masthead from its priors, e.g. 265 files
 *   attributing anthropic.com, aisi.gov.uk and simonwillison.net posts to
 *   "The New York Times". Falling back to the domain rather than null keeps a
 *   true answer ("Anthropic"), and a known-publisher domain is authoritative
 *   and skips the check entirely.
 */
export function validateFactualFields(
  meta: Omit<EnrichedMetadata, 'translation'>,
  sourceText: string,
  url: string
): Omit<EnrichedMetadata, 'translation'> {
  const haystack = sourceText.toLowerCase();

  let author = meta.author;
  if (author) {
    const tokens = author.toLowerCase().split(/[\s,]+/).filter((t) => t.length >= 3);
    // Word-boundary match, not substring: "Amode" must not pass because
    // "amodei" appears in the text (observed gemma3:4b near-miss).
    const wordPresent = (t: string) =>
      new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack);
    const allPresent = tokens.length > 0 && tokens.every(wordPresent);
    if (!allPresent) {
      console.log(JSON.stringify({
        event: 'enrichment_fact_rejected',
        field: 'author',
        value: author,
        reason: 'not_found_in_source_text',
        timestamp: new Date().toISOString(),
      }));
      author = null;
    }
  }

  let publishDate = meta.publishDate;
  if (publishDate) {
    const yearMatch = /\b(19|20)\d{2}\b/.exec(publishDate);
    const year = yearMatch ? yearMatch[0] : null;
    if (!year || !(haystack.includes(year) || url.includes(year))) {
      console.log(JSON.stringify({
        event: 'enrichment_fact_rejected',
        field: 'publishDate',
        value: publishDate,
        reason: 'year_not_in_source_or_url',
        timestamp: new Date().toISOString(),
      }));
      publishDate = null;
    }
  }

  // Only famous-outlet claims are second-guessed. A niche name the model read
  // off the page ("Transformer News" on open.substack.com) is kept as-is: the
  // domain-derived alternative there is the useless "Open", so replacing it
  // would trade a probably-right answer for a definitely-useless one.
  let publication = meta.publication;
  if (publication && !knownPublicationForUrl(url) &&
      claimsWellKnownPublisher(publication) &&
      !isPublicationSupported(publication, sourceText, url)) {
    const derived = extractPublicationFromUrl(url);
    console.log(JSON.stringify({
      event: 'enrichment_fact_rejected',
      field: 'publication',
      value: publication,
      replacedWith: derived,
      reason: 'well_known_publisher_on_unrelated_domain',
      timestamp: new Date().toISOString(),
    }));
    publication = derived;
  }

  return { ...meta, author, publishDate, publication };
}

/**
 * Parse the JSON response from Ollama, with fallback handling
 */
function parseMetadataResponse(
  content: string,
  url: string,
  pageTitle?: string,
  sourceText?: string
): Omit<EnrichedMetadata, 'translation'> {
  const fallback: Omit<EnrichedMetadata, 'translation'> = {
    title: pageTitle || extractTitleFromUrl(url),
    author: null,
    publication: extractPublicationFromUrl(url),
    publishDate: null,
    language: 'en',
    summary: '',
    tags: [],
  };

  try {
    // Try to extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]);

    const llmTitle = typeof parsed.title === 'string' && parsed.title ? parsed.title : fallback.title;
    const result = {
      // Page headline is ground truth; let the LLM only trim it, never reword it.
      title: reconcileTitle(llmTitle, pageTitle, knownPublicationForUrl(url)),
      author: typeof parsed.author === 'string' && parsed.author ? parsed.author : null,
      // For a known publisher domain the URL is authoritative — override the
      // LLM (small models mislabel publisher from in-text mentions). Otherwise
      // take the LLM's guess, falling back to the hostname.
      publication: knownPublicationForUrl(url)
        || (typeof parsed.publication === 'string' && parsed.publication ? parsed.publication : fallback.publication),
      publishDate: typeof parsed.publishDate === 'string' && parsed.publishDate ? parsed.publishDate : null,
      language: typeof parsed.language === 'string' && parsed.language.length >= 2 ? parsed.language.slice(0, 5).toLowerCase() : 'en',
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: unknown) => typeof t === 'string').slice(0, 10) : [],
    };
    return sourceText ? validateFactualFields(result, sourceText, url) : result;
  } catch (error) {
    console.warn('Failed to parse metadata response:', error instanceof Error ? error.message : error);
    return fallback;
  }
}

/**
 * Translate document text to English using Ollama
 * Handles long documents by chunking
 */
async function translateToEnglish(text: string, sourceLanguage: string): Promise<string> {
  // For very long documents, chunk the translation
  if (text.length > MAX_TRANSLATE_CHARS) {
    return translateLongDocument(text, sourceLanguage);
  }

  const prompt = `Translate the following ${sourceLanguage} text to English. Output ONLY the English translation, preserving paragraph structure. Do not add any commentary or notes.

${text}`;

  const content = await chatText({
    model: env.ENRICHMENT_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    numPredict: -1,
    numCtx: 16384,
  });

  return content.trim();
}

/**
 * Translate a long document by splitting into chunks at paragraph boundaries
 */
async function translateLongDocument(text: string, sourceLanguage: string): Promise<string> {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_TRANSLATE_CHARS) {
      chunks.push(remaining);
      break;
    }

    // Find a paragraph break near the limit
    let splitAt = remaining.lastIndexOf('\n\n', MAX_TRANSLATE_CHARS);
    if (splitAt < MAX_TRANSLATE_CHARS * 0.5) {
      // No good paragraph break, try sentence end
      splitAt = remaining.lastIndexOf('. ', MAX_TRANSLATE_CHARS);
    }
    if (splitAt < MAX_TRANSLATE_CHARS * 0.3) {
      // Force split at limit
      splitAt = MAX_TRANSLATE_CHARS;
    }

    chunks.push(remaining.slice(0, splitAt + 1));
    remaining = remaining.slice(splitAt + 1).trimStart();
  }

  console.log(`Translating ${chunks.length} chunks from ${sourceLanguage} to English`);

  const translatedChunks: string[] = [];
  for (const chunk of chunks) {
    const translated = await translateToEnglish(chunk, sourceLanguage);
    translatedChunks.push(translated);
  }

  return translatedChunks.join('\n\n');
}

/**
 * Enrich a document with AI-extracted metadata
 *
 * @param text - Extracted text content from the PDF
 * @param url - Source URL
 * @param pageTitle - Page title from browser (optional)
 * @returns Enriched metadata including summary and optional translation
 */
export async function enrichDocumentMetadata(
  text: string,
  url: string,
  pageTitle?: string
): Promise<EnrichedMetadata> {
  // Step 1: Extract structured metadata + detect language
  console.log(`Enriching metadata for ${url} (${text.length} chars)`);
  const metadata = await extractMetadata(text, url, pageTitle);

  console.log(`Metadata extracted: lang=${metadata.language}, tags=[${metadata.tags.join(', ')}]`);

  // Step 2: Translate if non-English
  let translation: string | null = null;
  if (metadata.language !== 'en' && text.length > 100) {
    console.log(`Translating document from ${metadata.language} to English (${text.length} chars)`);
    try {
      translation = await translateToEnglish(text, metadata.language);
      console.log(`Translation complete: ${translation.length} chars`);
    } catch (error) {
      console.error('Translation failed:', error instanceof Error ? error.message : error);
    }
  }

  return {
    ...metadata,
    translation,
  };
}

function extractTitleFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Untitled';
  }
}

/** Significant words of a title: lowercase alphanumerics ≥4 chars, sans common stopwords. */
const TITLE_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'into', 'about', 'after', 'then', 'than',
  'what', 'when', 'will', 'your', 'their', 'have', 'been', 'them', 'they',
  'which', 'while', 'were', 'over', 'more', 'most', 'some', 'such', 'only',
]);
function significantTitleWords(s: string): string[] {
  return (s.toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w));
}

/** Strip a trailing " - Publication" / " | Publication" site-name suffix from a page title. */
function stripPublicationSuffix(pageTitle: string, publication: string | null): string {
  let t = pageTitle.trim();
  if (publication) {
    // e.g. "Headline - The Washington Post" → "Headline". Only " - " / " | " /
    // " : " separators (regular hyphen/pipe/colon) — NOT em/en dashes, which
    // headlines themselves use ("trust — and then its flagship product").
    const re = new RegExp(`\\s*[-|:]\\s*${publication.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    t = t.replace(re, '').trim();
  }
  return t || pageTitle.trim();
}

/**
 * The page headline is ground truth for the title; a small LLM should only ever
 * TRIM it (drop the site name), never reword it. When the model introduces a
 * significant word that isn't in the real page title, it has paraphrased —
 * classically by splicing the lede's subject into the headline (e.g. WaPo's
 * "How Anthropic lost…" became "Trump administration lost…"). In that case fall
 * back to the page title itself. Only validates when the page title is a real
 * headline (≥3 significant words); otherwise (junk/generic titles) trust the LLM.
 */
export function reconcileTitle(llmTitle: string, pageTitle: string | undefined, publication: string | null): string {
  if (!pageTitle) return llmTitle;
  const pageWords = new Set(significantTitleWords(pageTitle));
  if (pageWords.size < 3) return llmTitle; // page title too thin to trust as headline
  const llmWords = significantTitleWords(llmTitle);
  if (llmWords.length === 0) return stripPublicationSuffix(pageTitle, publication);
  const introduced = llmWords.filter((w) => !pageWords.has(w));
  if (introduced.length > 0) {
    console.log(JSON.stringify({
      event: 'enrichment_title_diverged',
      llmTitle, pageTitle, introduced,
      action: 'use_page_title',
      timestamp: new Date().toISOString(),
    }));
    return stripPublicationSuffix(pageTitle, publication);
  }
  return llmTitle;
}

/**
 * Authoritative domain → publication name map. The domain is ground truth, so
 * for these the URL beats the LLM's guess (a small model reading "New York
 * University" 22x in a Nature paper, primed by the prompt's lone "nytimes.com
 * → The New York Times" example, mislabeled it "The New York Times"). Keyed by
 * registrable domain; subdomains match via suffix.
 */
const PUBLICATION_BY_DOMAIN: Record<string, string> = {
  'nature.com': 'Nature',
  'science.org': 'Science',
  'nytimes.com': 'The New York Times',
  'wsj.com': 'The Wall Street Journal',
  'ft.com': 'Financial Times',
  'bloomberg.com': 'Bloomberg',
  'washingtonpost.com': 'The Washington Post',
  'economist.com': 'The Economist',
  'reuters.com': 'Reuters',
  'theatlantic.com': 'The Atlantic',
  'newyorker.com': 'The New Yorker',
  'wired.com': 'Wired',
  'theverge.com': 'The Verge',
  'arstechnica.com': 'Ars Technica',
  'technologyreview.com': 'MIT Technology Review',
  'axios.com': 'Axios',
  'thenextweb.com': 'The Next Web',
  'cnn.com': 'CNN',
  'theinformation.com': 'The Information',
  'semafor.com': 'Semafor',
  'techcrunch.com': 'TechCrunch',
  'arxiv.org': 'arXiv',
  'nejm.org': 'The New England Journal of Medicine',
  'thelancet.com': 'The Lancet',
  // Below: added primarily so claimsWellKnownPublisher can recognise these
  // names as famous-outlet claims on unrelated domains. They double as
  // authoritative naming for their own domains.
  'theguardian.com': 'The Guardian',
  'forbes.com': 'Forbes',
  'bbc.com': 'BBC',
  'bbc.co.uk': 'BBC',
  'npr.org': 'NPR',
  'cnbc.com': 'CNBC',
  'businessinsider.com': 'Business Insider',
  'fortune.com': 'Fortune',
  'time.com': 'TIME',
  'politico.com': 'Politico',
  'vox.com': 'Vox',
  'thehill.com': 'The Hill',
  'nbcnews.com': 'NBC News',
  'cbsnews.com': 'CBS News',
  'abcnews.go.com': 'ABC News',
  'apnews.com': 'The Associated Press',
  'engadget.com': 'Engadget',
  'venturebeat.com': 'VentureBeat',
  'thetimes.co.uk': 'The Times',
  'latimes.com': 'Los Angeles Times',
  'usatoday.com': 'USA Today',
  'newscientist.com': 'New Scientist',
  'scientificamerican.com': 'Scientific American',
  'ieee.org': 'IEEE Spectrum',
};

/**
 * True when the name is one of the well-known outlets above — i.e. a name the
 * model could produce from memory alone rather than from the capture. Matched
 * on the name, ignoring case/punctuation and a leading "The".
 */
export function claimsWellKnownPublisher(publication: string): boolean {
  const squash = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^the/, '');
  const target = squash(publication);
  if (!target) return false;
  return Object.values(PUBLICATION_BY_DOMAIN).some((name) => squash(name) === target);
}

/** Authoritative publication for a known publisher domain, else null. */
export function knownPublicationForUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    for (const [domain, pub] of Object.entries(PUBLICATION_BY_DOMAIN)) {
      if (host === domain || host.endsWith('.' + domain)) return pub;
    }
    return null;
  } catch {
    return null;
  }
}

function extractPublicationFromUrl(url: string): string | null {
  // Curated map first — authoritative for major publishers.
  const known = knownPublicationForUrl(url);
  if (known) return known;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    // Strip common TLDs to get a cleaner publication name
    const name = hostname.split('.')[0];
    if (name && name !== hostname) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return hostname;
  } catch {
    return null;
  }
}
