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

import { Ollama } from 'ollama';
import { Agent } from 'undici';
import { env } from '../config/env.js';

/**
 * Dedicated Ollama client for enrichment tasks with extended timeout.
 * Model swaps (e.g., e4b→26b) + generation on large texts can take minutes.
 */
const enrichmentAgent = new Agent({
  headersTimeout: 10 * 60 * 1000,  // 10 minutes
  bodyTimeout: 10 * 60 * 1000,
  connectTimeout: 30 * 1000,
});

const ollama = new Ollama({
  host: env.OLLAMA_HOST,
  fetch: ((url: string | URL | Request, init?: RequestInit) => {
    return fetch(url, { ...init, dispatcher: enrichmentAgent } as RequestInit);
  }) as typeof fetch,
});

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
  "publication": "publisher or website name (e.g., 'The New York Times', 'Hacker News') or null",
  "publishDate": "YYYY-MM-DD date or null",
  "language": "ISO 639-1 code (e.g., 'en', 'fr', 'de', 'ja', 'zh')",
  "summary": "2-3 sentence summary capturing the key points",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}

Guidelines:
- For title: prefer the actual article headline, not navigation text or site name
- For author: look for bylines ("By John Smith", "Written by..."), footer credits, or author names near the title. Also check for patterns like "FirstName LastName" immediately before or after the date
- For publication: infer from the URL domain or text clues (e.g., "nytimes.com" → "The New York Times")
- For publishDate: look carefully for ANY date near the top of the text — it may appear as "January 15, 2025", "Jan 2025", "2025-01-15", "15/01/2025", or just "January 2025". Convert partial dates to the 1st of that month (e.g., "July 2024" → "2024-07-01"). Return null ONLY if there is truly no date anywhere in the text
- For tags: use 3-5 lowercase hyphenated topic tags (e.g., "machine-learning", "climate-change")
- For summary: be concise, factual, and capture the main argument or findings
- For language: detect the primary language of the body text, not headers/nav

URL: ${url}
${pageTitle ? `Page title: ${pageTitle}` : ''}

Article text:
${truncatedText}`;

  const response = await ollama.chat({
    model: env.OLLAMA_MODEL,
    messages: [{ role: 'user', content: prompt }],
    options: { temperature: 0.2, num_ctx: 8192 },
  });

  return parseMetadataResponse(response.message.content, url, pageTitle);
}

/**
 * Parse the JSON response from Ollama, with fallback handling
 */
function parseMetadataResponse(
  content: string,
  url: string,
  pageTitle?: string
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

    return {
      title: typeof parsed.title === 'string' && parsed.title ? parsed.title : fallback.title,
      author: typeof parsed.author === 'string' && parsed.author ? parsed.author : null,
      publication: typeof parsed.publication === 'string' && parsed.publication ? parsed.publication : fallback.publication,
      publishDate: typeof parsed.publishDate === 'string' && parsed.publishDate ? parsed.publishDate : null,
      language: typeof parsed.language === 'string' && parsed.language.length >= 2 ? parsed.language.slice(0, 5).toLowerCase() : 'en',
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: unknown) => typeof t === 'string').slice(0, 10) : [],
    };
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

  const response = await ollama.chat({
    model: env.OLLAMA_MODEL,
    messages: [{ role: 'user', content: prompt }],
    options: { temperature: 0.3, num_predict: -1, num_ctx: 16384 },
  });

  return response.message.content.trim();
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

function extractPublicationFromUrl(url: string): string | null {
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
