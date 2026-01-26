/**
 * Type definitions for podcast transcription
 */

/**
 * Parsed Apple Podcasts URL components
 */
export interface ApplePodcastsUrl {
  podcastId: string;      // e.g., "1680633614"
  episodeId: string;      // e.g., "1000746731002" from ?i= param
  country: string;        // e.g., "us"
  podcastSlug: string;    // e.g., "the-ai-daily-brief-artificial-intelligence-news"
}

/**
 * iTunes API podcast result
 */
export interface iTunesPodcast {
  wrapperType: 'track';
  kind: 'podcast';
  collectionId: number;
  trackId: number;
  artistName: string;
  collectionName: string;
  trackName: string;
  feedUrl: string;
  artworkUrl100?: string;
  artworkUrl600?: string;
  trackCount: number;
  primaryGenreName: string;
  releaseDate: string;
}

/**
 * iTunes API episode result
 */
export interface iTunesEpisode {
  wrapperType: 'podcastEpisode';
  kind: 'podcast-episode';
  collectionId: number;
  trackId: number;
  artistName: string;
  collectionName: string;
  trackName: string;
  episodeUrl: string;         // Direct audio URL
  episodeFileExtension: string;  // "mp3" or "m4a"
  episodeGuid: string;
  trackTimeMillis: number;
  description: string;
  shortDescription?: string;
  releaseDate: string;
  artworkUrl160?: string;
  artworkUrl600?: string;
  previewUrl?: string;
}

/**
 * Combined podcast metadata for PDF generation
 */
export interface PodcastMetadata {
  // Podcast info
  podcastName: string;
  podcastAuthor: string;
  genre: string;
  artworkUrl?: string;
  feedUrl: string;

  // Episode info
  episodeTitle: string;
  episodeUrl: string;        // Apple Podcasts URL
  audioUrl: string;          // Direct MP3/M4A URL
  audioExtension: string;    // "mp3" or "m4a"
  duration: number;          // milliseconds
  publishedAt: string;       // ISO date
  description: string;
  shortDescription?: string;
  episodeGuid: string;

  // Show notes from RSS feed (with links)
  showNotes?: {
    summary: string;
    links: Array<{
      text: string;
      url: string;
      source?: string;
    }>;
    footer?: string;
  };
}

/**
 * Whisper ASR transcription segment
 */
export interface TranscriptSegment {
  start: number;   // seconds
  end: number;     // seconds
  text: string;
}

/**
 * Whisper ASR response
 */
export interface WhisperResponse {
  text: string;              // Full transcript text
  segments?: TranscriptSegment[];
  language?: string;
}

/**
 * Result from transcription pipeline (includes audio path for archival)
 */
export interface TranscriptionResult {
  transcript: WhisperResponse;
  audioPath: string;         // Path to downloaded audio file (for archival)
  audioSize: number;         // Size in bytes
}

/**
 * Job data for podcast transcription queue
 */
export interface PodcastJobData {
  url: string;               // Apple Podcasts URL
  originalUrl: string;       // Preserved original
  bookmarkedAt?: string;     // For weekly bin organization
  source: 'matter' | 'karakeep' | 'rerun';
}

/**
 * Job result for podcast transcription
 */
export interface PodcastJobResult {
  success: boolean;
  pdfPath?: string;
  metadata?: PodcastMetadata;
  transcriptLength?: number;
  audioDuration?: number;
  error?: string;
  completedAt: string;
}
