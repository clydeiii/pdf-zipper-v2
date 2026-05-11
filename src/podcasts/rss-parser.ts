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
 * Combined feed data parsed in a single RSS fetch
 */
export interface PodcastFeedData {
  channelImage?: string;     // Channel-level <itunes:image> or <image><url>
  showNotes?: ShowNotes;     // Episode-specific show notes (if matched)
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
  enclosure?: {
    '@_url'?: string;
    '@_length'?: string | number;
    '@_type'?: string;
  };
  'itunes:duration'?: string;
}

/**
 * Episode details extracted from an RSS item — used as a fallback when the
 * iTunes Lookup API can't return the episode (200-result limit).
 */
export interface RssEpisodeDetails {
  title: string;
  audioUrl: string;
  audioExtension: string;
  durationMs: number;
  description: string;
  guid?: string;
  publishedAt?: string;
  showNotes?: ShowNotes;
  channelImage?: string;
}

/**
 * Parse iTunes-style HH:MM:SS or MM:SS or seconds string into milliseconds.
 */
function parseDurationToMs(duration: string | undefined): number {
  if (!duration) return 0;
  const parts = String(duration).trim().split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 1) return parts[0] * 1000;
  return 0;
}

/**
 * Strip punctuation, lowercase, and collapse whitespace — for forgiving
 * title comparison (Apple slug "the-ai-models-smart-enough" vs RSS title
 * "The AI Models Smart Enough to Know They're Cheating — Beth Barnes...").
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Find episode by title in a list of RSS items.
 *
 * Tries exact normalized match first; if no exact match, treats the query
 * as a prefix and matches when an RSS title starts with it (lets the
 * Apple-page slug fallback work even though it omits the episode subtitle).
 * Falls back to GUID match if all title attempts fail.
 */
function matchRssItem(items: RssItem[], episodeTitle: string, episodeGuid?: string): RssItem | undefined {
  const normalizedTitle = normalizeForMatch(episodeTitle);

  let item = items.find(i => normalizeForMatch(i.title || '') === normalizedTitle);

  if (!item && normalizedTitle.length >= 12) {
    item = items.find(i => normalizeForMatch(i.title || '').startsWith(normalizedTitle));
  }

  if (!item && episodeGuid) {
    item = items.find(i => {
      const guid = typeof i.guid === 'string' ? i.guid : i.guid?.['#text'];
      return guid === episodeGuid;
    });
  }
  return item;
}

/**
 * Fetch the RSS feed and extract full episode details — the audio URL fallback
 * path used when the iTunes Lookup API doesn't include this episode.
 */
export async function fetchEpisodeFromRss(
  feedUrl: string,
  episodeTitle: string,
  episodeGuid?: string
): Promise<RssEpisodeDetails | null> {
  try {
    const response = await fetch(feedUrl, {
      headers: { 'User-Agent': 'pdf-zipper/2.0 podcast-transcriber' },
    });
    if (!response.ok) return null;

    const xml = await response.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const feed = parser.parse(xml);
    const channel = feed?.rss?.channel;
    const items: RssItem[] = channel?.item || [];
    const channelImage = extractChannelImage(channel);

    const item = matchRssItem(items, episodeTitle, episodeGuid);
    if (!item) {
      console.log(JSON.stringify({
        event: 'rss_episode_fallback_not_found',
        episodeTitle, availableCount: items.length,
        timestamp: new Date().toISOString(),
      }));
      return null;
    }

    const audioUrl = item.enclosure?.['@_url'];
    if (!audioUrl) return null;

    const audioType = item.enclosure?.['@_type'] || '';
    const audioExtension = audioType.includes('mp4') || audioType.includes('m4a') ? 'm4a' : 'mp3';
    const html = item['content:encoded'] || item.description || '';
    const guid = typeof item.guid === 'string' ? item.guid : item.guid?.['#text'];

    return {
      title: item.title,
      audioUrl,
      audioExtension,
      durationMs: parseDurationToMs(item['itunes:duration']),
      description: stripHtml(html),
      guid,
      publishedAt: item.pubDate,
      showNotes: html ? parseShowNotesHtml(html) : undefined,
      channelImage,
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'rss_episode_fallback_error',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));
    return null;
  }
}

/**
 * Extract channel-level cover image from a parsed RSS channel.
 * Prefers <itunes:image href="..."/>; falls back to <image><url>.
 */
function extractChannelImage(channel: any): string | undefined {
  if (!channel) return undefined;

  const itunesImage = channel['itunes:image'];
  if (itunesImage) {
    if (typeof itunesImage === 'string') return itunesImage;
    const href = itunesImage['@_href'] ?? itunesImage.href;
    if (typeof href === 'string' && href) return href;
  }

  const image = channel.image;
  if (image) {
    if (typeof image === 'string') return image;
    if (typeof image.url === 'string' && image.url) return image.url;
  }

  return undefined;
}

/**
 * Fetch RSS feed and extract both channel image and episode show notes
 * in a single request.
 */
export async function fetchFeedData(
  feedUrl: string,
  episodeTitle: string,
  episodeGuid?: string
): Promise<PodcastFeedData | null> {
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
    const channel = feed?.rss?.channel;
    const items: RssItem[] = channel?.item || [];
    const channelImage = extractChannelImage(channel);

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
        hasChannelImage: !!channelImage,
        timestamp: new Date().toISOString(),
      }));
      return channelImage ? { channelImage } : null;
    }

    // Get the HTML content (prefer content:encoded, fallback to description)
    const html = episode['content:encoded'] || episode.description || '';

    if (!html) {
      return channelImage ? { channelImage } : null;
    }

    console.log(JSON.stringify({
      event: 'rss_episode_found',
      episodeTitle,
      htmlLength: html.length,
      hasChannelImage: !!channelImage,
      timestamp: new Date().toISOString(),
    }));

    return {
      channelImage,
      showNotes: parseShowNotesHtml(html),
    };
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
