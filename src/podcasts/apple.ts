/**
 * Apple Podcasts URL parsing and iTunes API client
 *
 * Handles:
 * - Parsing Apple Podcasts URLs to extract podcast/episode IDs
 * - Fetching podcast metadata from iTunes Lookup API
 * - Finding specific episodes by ID
 */

import type {
  ApplePodcastsUrl,
  iTunesPodcast,
  iTunesEpisode,
  PodcastMetadata,
} from './types.js';
import { fetchFeedData, fetchEpisodeFromRss } from './rss-parser.js';

/**
 * Check if a URL is an Apple Podcasts URL
 */
export function isApplePodcastsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'podcasts.apple.com';
  } catch {
    return false;
  }
}

/**
 * Parse an Apple Podcasts URL to extract IDs
 *
 * URL format: https://podcasts.apple.com/{country}/podcast/{slug}/id{podcastId}?i={episodeId}
 * Example: https://podcasts.apple.com/us/podcast/the-ai-daily-brief/id1680633614?i=1000746731002
 *
 * @throws Error if URL format is invalid or missing episode ID
 */
export function parseApplePodcastsUrl(url: string): ApplePodcastsUrl {
  const parsed = new URL(url);

  if (parsed.hostname !== 'podcasts.apple.com') {
    throw new Error(`Not an Apple Podcasts URL: ${url}`);
  }

  // Path: /us/podcast/the-ai-daily-brief/id1680633614
  const pathParts = parsed.pathname.split('/').filter(Boolean);

  if (pathParts.length < 4 || pathParts[1] !== 'podcast') {
    throw new Error(`Invalid Apple Podcasts URL path: ${url}`);
  }

  const country = pathParts[0];
  const podcastSlug = pathParts[2];
  const idPart = pathParts[3]; // "id1680633614"

  if (!idPart.startsWith('id')) {
    throw new Error(`Invalid podcast ID in URL: ${url}`);
  }

  const podcastId = idPart.substring(2); // Remove "id" prefix

  // Episode ID from query param ?i=1000746731002
  const episodeId = parsed.searchParams.get('i');

  if (!episodeId) {
    throw new Error(`Missing episode ID (?i=) in URL: ${url}`);
  }

  return {
    podcastId,
    episodeId,
    country,
    podcastSlug,
  };
}

/**
 * Scrape an Apple Podcasts episode page for the episode title.
 *
 * Apple server-renders a JSON shoebox embedding LegacyEpisodeLockup objects
 * keyed by the iTunes track ID (adamId). We anchor on the episodeId so we
 * extract the right title even when the page mentions many episodes.
 *
 * Used only when iTunes Lookup doesn't return the episode (200-result cap).
 */
async function scrapeAppleEpisodeTitle(
  applePodcastsUrl: string,
  episodeId: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(applePodcastsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
    });
    if (!response.ok) return undefined;
    const html = await response.text();

    // Primary: LegacyEpisodeLockup with id matching this episode.
    // Pattern: "id":"<episodeId>","title":"<...>"  (within ~500 chars of the id)
    const lockupRe = new RegExp(
      `"id":"${episodeId}","title":"((?:[^"\\\\]|\\\\.){1,400})"`,
    );
    const lockupMatch = html.match(lockupRe);
    if (lockupMatch) return JSON.parse('"' + lockupMatch[1] + '"');

    // Fallback: derive from the canonical pageUrl slug Apple includes for
    // this episode (e.g. "/podcast/the-ai-models-smart-enough.../id...?i=<episodeId>").
    const pageUrlRe = new RegExp(
      `"pageUrl":"https://podcasts\\.apple\\.com/[^"]+/podcast/([^/"]+)/id\\d+\\?i=${episodeId}"`,
    );
    const pageMatch = html.match(pageUrlRe);
    if (pageMatch) {
      // Slug → words: hyphen → space (good enough for the title-match step
      // since matchRssItem also lowercases & trims).
      return pageMatch[1].replace(/-/g, ' ');
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * iTunes Lookup API response structure
 */
interface iTunesLookupResponse {
  resultCount: number;
  results: Array<iTunesPodcast | iTunesEpisode>;
}

/**
 * Fetch podcast and episode metadata from iTunes Lookup API
 *
 * @param podcastId - The podcast collection ID
 * @param episodeLimit - Max episodes to fetch (default 200 for searching)
 */
export async function fetchiTunesMetadata(
  podcastId: string,
  episodeLimit = 200
): Promise<iTunesLookupResponse> {
  const url = new URL('https://itunes.apple.com/lookup');
  url.searchParams.set('id', podcastId);
  url.searchParams.set('media', 'podcast');
  url.searchParams.set('entity', 'podcastEpisode');
  url.searchParams.set('limit', episodeLimit.toString());

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`iTunes API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as iTunesLookupResponse;

  if (data.resultCount === 0) {
    throw new Error(`Podcast not found: ${podcastId}`);
  }

  return data;
}

/**
 * Extract podcast info from iTunes response (first result is always the podcast)
 */
function extractPodcast(results: iTunesLookupResponse['results']): iTunesPodcast {
  const podcast = results.find(
    (r): r is iTunesPodcast => r.wrapperType === 'track' && r.kind === 'podcast'
  );

  if (!podcast) {
    throw new Error('Podcast metadata not found in iTunes response');
  }

  return podcast;
}

/**
 * Find a specific episode by its track ID
 */
function findEpisode(
  results: iTunesLookupResponse['results'],
  episodeId: string
): iTunesEpisode | null {
  const numericId = parseInt(episodeId, 10);

  return results.find(
    (r): r is iTunesEpisode =>
      r.wrapperType === 'podcastEpisode' && r.trackId === numericId
  ) || null;
}

/**
 * Get full podcast metadata for an Apple Podcasts episode URL
 *
 * @param applePodcastsUrl - The full Apple Podcasts URL
 * @returns Combined metadata for PDF generation
 * @throws Error if episode not found or API fails
 */
export async function getPodcastMetadata(applePodcastsUrl: string): Promise<PodcastMetadata> {
  // Parse the URL
  const parsed = parseApplePodcastsUrl(applePodcastsUrl);

  console.log(JSON.stringify({
    event: 'podcast_fetching_metadata',
    podcastId: parsed.podcastId,
    episodeId: parsed.episodeId,
    timestamp: new Date().toISOString(),
  }));

  // Fetch from iTunes API
  const response = await fetchiTunesMetadata(parsed.podcastId);

  // Extract podcast info
  const podcast = extractPodcast(response.results);

  // Find the specific episode
  const episode = findEpisode(response.results, parsed.episodeId);

  if (!episode) {
    // iTunes Lookup caps at ~200 results per podcast; older episodes get cut.
    // Fall back to the RSS feed (typically holds the full archive).
    console.log(JSON.stringify({
      event: 'podcast_episode_not_in_first_batch',
      episodeId: parsed.episodeId,
      fetchedCount: response.resultCount,
      timestamp: new Date().toISOString(),
    }));

    if (!podcast.feedUrl) {
      throw new Error(
        `Episode ${parsed.episodeId} not found in iTunes response and podcast has no RSS feed.`
      );
    }

    const episodeTitle = await scrapeAppleEpisodeTitle(applePodcastsUrl, parsed.episodeId);
    if (!episodeTitle) {
      throw new Error(
        `Episode ${parsed.episodeId} not in iTunes response (fetched ${response.resultCount}); ` +
        `couldn't scrape title from Apple Podcasts page for RSS fallback.`
      );
    }

    const rssEpisode = await fetchEpisodeFromRss(podcast.feedUrl, episodeTitle);
    if (!rssEpisode) {
      throw new Error(
        `Episode ${parsed.episodeId} ("${episodeTitle}") not found in iTunes ` +
        `(fetched ${response.resultCount}) or in RSS feed at ${podcast.feedUrl}.`
      );
    }

    console.log(JSON.stringify({
      event: 'podcast_episode_resolved_via_rss',
      episodeId: parsed.episodeId,
      episodeTitle: rssEpisode.title,
      audioUrl: rssEpisode.audioUrl,
      durationMinutes: Math.round(rssEpisode.durationMs / 60000),
      timestamp: new Date().toISOString(),
    }));

    return {
      podcastName: podcast.collectionName,
      podcastAuthor: podcast.artistName,
      genre: podcast.primaryGenreName,
      artworkUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
      feedChannelImage: rssEpisode.channelImage,
      feedUrl: podcast.feedUrl,
      episodeTitle: rssEpisode.title,
      episodeUrl: applePodcastsUrl,
      audioUrl: rssEpisode.audioUrl,
      audioExtension: rssEpisode.audioExtension,
      duration: rssEpisode.durationMs,
      publishedAt: rssEpisode.publishedAt || '',
      description: rssEpisode.description,
      episodeGuid: rssEpisode.guid || '',
      showNotes: rssEpisode.showNotes,
    };
  }

  console.log(JSON.stringify({
    event: 'podcast_metadata_fetched',
    podcastName: podcast.collectionName,
    episodeTitle: episode.trackName,
    audioUrl: episode.episodeUrl,
    durationMinutes: Math.round(episode.trackTimeMillis / 60000),
    timestamp: new Date().toISOString(),
  }));

  // Fetch show notes + channel image from RSS feed (one fetch, two payloads)
  let showNotes: PodcastMetadata['showNotes'] | undefined;
  let feedChannelImage: string | undefined;
  if (podcast.feedUrl) {
    const feedData = await fetchFeedData(
      podcast.feedUrl,
      episode.trackName,
      episode.episodeGuid
    );
    if (feedData?.showNotes) {
      showNotes = {
        summary: feedData.showNotes.summary,
        links: feedData.showNotes.links,
        footer: feedData.showNotes.footer,
      };
      console.log(JSON.stringify({
        event: 'podcast_shownotes_fetched',
        linkCount: feedData.showNotes.links.length,
        timestamp: new Date().toISOString(),
      }));
    }
    feedChannelImage = feedData?.channelImage;
  }

  return {
    // Podcast info
    podcastName: podcast.collectionName,
    podcastAuthor: podcast.artistName,
    genre: podcast.primaryGenreName,
    artworkUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
    feedChannelImage,
    feedUrl: podcast.feedUrl,

    // Episode info
    episodeTitle: episode.trackName,
    episodeUrl: applePodcastsUrl,
    audioUrl: episode.episodeUrl,
    audioExtension: episode.episodeFileExtension || 'mp3',
    duration: episode.trackTimeMillis,
    publishedAt: episode.releaseDate,
    description: episode.description,
    shortDescription: episode.shortDescription,
    episodeGuid: episode.episodeGuid,
    showNotes,
  };
}
