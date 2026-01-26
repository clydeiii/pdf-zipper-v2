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
import { fetchShowNotes } from './rss-parser.js';

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
    // Episode might be older than the limit - try fetching more
    console.log(JSON.stringify({
      event: 'podcast_episode_not_in_first_batch',
      episodeId: parsed.episodeId,
      fetchedCount: response.resultCount,
      timestamp: new Date().toISOString(),
    }));

    throw new Error(
      `Episode ${parsed.episodeId} not found in iTunes response. ` +
      `It may be too old (fetched ${response.resultCount} recent episodes).`
    );
  }

  console.log(JSON.stringify({
    event: 'podcast_metadata_fetched',
    podcastName: podcast.collectionName,
    episodeTitle: episode.trackName,
    audioUrl: episode.episodeUrl,
    durationMinutes: Math.round(episode.trackTimeMillis / 60000),
    timestamp: new Date().toISOString(),
  }));

  // Fetch show notes from RSS feed (has links, iTunes API doesn't)
  let showNotes: PodcastMetadata['showNotes'] | undefined;
  if (podcast.feedUrl) {
    const rssShowNotes = await fetchShowNotes(
      podcast.feedUrl,
      episode.trackName,
      episode.episodeGuid
    );
    if (rssShowNotes) {
      showNotes = {
        summary: rssShowNotes.summary,
        links: rssShowNotes.links,
        footer: rssShowNotes.footer,
      };
      console.log(JSON.stringify({
        event: 'podcast_shownotes_fetched',
        linkCount: rssShowNotes.links.length,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  return {
    // Podcast info
    podcastName: podcast.collectionName,
    podcastAuthor: podcast.artistName,
    genre: podcast.primaryGenreName,
    artworkUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
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
