/**
 * RSS feed parser for extracting show notes with links
 *
 * The iTunes API returns plain text descriptions, but the RSS feed
 * has the full HTML with clickable links for source articles.
 */

import { XMLParser } from 'fast-xml-parser';

/**
 * Parsed link from show notes
 */
export interface ShowNotesLink {
  text: string;
  url: string;
  source?: string;  // e.g., "(Wired)" extracted from text
}

/**
 * Parsed show notes with structured content
 */
export interface ShowNotes {
  summary: string;           // Intro paragraph
  links: ShowNotesLink[];    // Article links
  footer?: string;           // Ad choices, etc.
  rawHtml: string;           // Original HTML for debugging
}

/**
 * RSS feed item structure
 */
interface RssItem {
  title: string;
  description?: string;
  'content:encoded'?: string;
  guid?: string | { '#text': string };
  pubDate?: string;
}

/**
 * Fetch and parse show notes from RSS feed
 *
 * @param feedUrl - Podcast RSS feed URL
 * @param episodeTitle - Episode title to find
 * @param episodeGuid - Episode GUID as fallback
 * @returns Parsed show notes with links
 */
export async function fetchShowNotes(
  feedUrl: string,
  episodeTitle: string,
  episodeGuid?: string
): Promise<ShowNotes | null> {
  console.log(JSON.stringify({
    event: 'rss_fetch_start',
    feedUrl,
    episodeTitle,
    timestamp: new Date().toISOString(),
  }));

  try {
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'pdf-zipper/2.0 podcast-transcriber',
      },
    });

    if (!response.ok) {
      console.error(`RSS fetch failed: ${response.status}`);
      return null;
    }

    const xml = await response.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });

    const feed = parser.parse(xml);
    const items: RssItem[] = feed?.rss?.channel?.item || [];

    // Find the episode by title (case-insensitive, trimmed)
    const normalizedTitle = episodeTitle.toLowerCase().trim();
    let episode = items.find(
      (item) => item.title?.toLowerCase().trim() === normalizedTitle
    );

    // Fallback: try matching by GUID
    if (!episode && episodeGuid) {
      episode = items.find((item) => {
        const guid = typeof item.guid === 'string' ? item.guid : item.guid?.['#text'];
        return guid === episodeGuid;
      });
    }

    if (!episode) {
      console.log(JSON.stringify({
        event: 'rss_episode_not_found',
        episodeTitle,
        availableCount: items.length,
        timestamp: new Date().toISOString(),
      }));
      return null;
    }

    // Get the HTML content (prefer content:encoded, fallback to description)
    const html = episode['content:encoded'] || episode.description || '';

    if (!html) {
      return null;
    }

    console.log(JSON.stringify({
      event: 'rss_episode_found',
      episodeTitle,
      htmlLength: html.length,
      timestamp: new Date().toISOString(),
    }));

    return parseShowNotesHtml(html);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'rss_fetch_error',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));
    return null;
  }
}

/**
 * Parse HTML show notes into structured data
 */
function parseShowNotesHtml(html: string): ShowNotes {
  // Extract links with their text and URLs
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
  const links: ShowNotesLink[] = [];
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    let text = match[2].trim();

    // Skip ad choices and internal links
    if (url.includes('megaphone.fm/adchoices')) continue;

    // Extract source in parentheses if it follows the link
    const afterLink = html.substring(match.index + match[0].length, match.index + match[0].length + 50);
    const sourceMatch = afterLink.match(/^\s*\(([^)]+)\)/);
    const source = sourceMatch ? sourceMatch[1] : undefined;

    links.push({ text, url, source });
  }

  // Extract summary (text before the first link or list)
  let summary = '';
  const summaryMatch = html.match(/^([\s\S]*?)(?:<ul>|<li>|<a\s+href)/i);
  if (summaryMatch) {
    summary = stripHtml(summaryMatch[1]).trim();
  }

  // Extract footer (usually ad choices)
  let footer: string | undefined;
  const footerMatch = html.match(/Learn more about your ad choices[^<]*/i);
  if (footerMatch) {
    footer = footerMatch[0].trim();
  }

  return {
    summary,
    links,
    footer,
    rawHtml: html,
  };
}

/**
 * Strip HTML tags and decode entities
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Format show notes as plain text with URLs
 * Used as fallback if PDF link annotations don't work
 */
export function formatShowNotesAsText(showNotes: ShowNotes): string {
  const lines: string[] = [];

  if (showNotes.summary) {
    lines.push(showNotes.summary);
    lines.push('');
  }

  if (showNotes.links.length > 0) {
    lines.push('Links mentioned:');
    for (const link of showNotes.links) {
      const source = link.source ? ` (${link.source})` : '';
      lines.push(`• ${link.text}${source}`);
      lines.push(`  ${link.url}`);
    }
  }

  return lines.join('\n');
}
