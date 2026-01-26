import metascraper from 'metascraper';
import metascraperAuthor from 'metascraper-author';
import metascraperDate from 'metascraper-date';
import metascraperDescription from 'metascraper-description';
import metascraperImage from 'metascraper-image';
import metascraperTitle from 'metascraper-title';
import metascraperUrl from 'metascraper-url';
import metascraperPublisher from 'metascraper-publisher';

/**
 * Extracted metadata from URL (META-01)
 * Uses metascraper for 95% accuracy via Open Graph, JSON-LD, Schema.org, Twitter Cards
 */
export interface UrlMetadata {
  title: string;
  author?: string;
  date?: string;          // ISO 8601 format
  description?: string;
  image?: string;
  publisher?: string;
  url: string;            // Canonical URL from page
}

const scraper = metascraper([
  metascraperAuthor(),
  metascraperDate(),
  metascraperDescription(),
  metascraperImage(),
  metascraperTitle(),
  metascraperUrl(),
  metascraperPublisher(),
]);

/**
 * Extract metadata from URL with timeout protection
 *
 * Returns minimal fallback metadata if extraction fails to prevent
 * blocking the feed processing pipeline.
 *
 * @param url - URL to extract metadata from
 * @param timeoutMs - Timeout in milliseconds (default: 15000)
 */
export async function extractUrlMetadata(
  url: string,
  timeoutMs: number = 15000
): Promise<UrlMetadata> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BookmarkBot/1.0; +http://localhost)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`Metadata fetch failed for ${url}: HTTP ${response.status}`);
      return createFallbackMetadata(url);
    }

    const html = await response.text();
    const metadata = await scraper({ url, html });

    return {
      title: metadata.title || extractTitleFromUrl(url),
      author: metadata.author || undefined,
      date: metadata.date || undefined,
      description: metadata.description || undefined,
      image: metadata.image || undefined,
      publisher: metadata.publisher || undefined,
      url: metadata.url || url,
    };

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`Metadata extraction failed for ${url}: ${message}`);
    return createFallbackMetadata(url);
  }
}

/**
 * Create minimal fallback metadata when extraction fails
 */
function createFallbackMetadata(url: string): UrlMetadata {
  return {
    title: extractTitleFromUrl(url),
    url,
  };
}

/**
 * Extract a reasonable title from URL when metadata is unavailable
 */
function extractTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Use hostname without www as fallback title
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return 'Untitled';
  }
}
