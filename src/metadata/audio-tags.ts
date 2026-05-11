/**
 * Audio file metadata tagging (ID3 for MP3, basic for M4A)
 *
 * Writes rich metadata to audio files for downstream LLM consumption:
 * - Standard tags: title, artist, album, year, genre
 * - Extended: comment (summary), custom tags
 */

import { createRequire } from 'node:module';
import type { PodcastMetadata } from '../podcasts/types.js';

const require = createRequire(import.meta.url);
const NodeID3 = require('node-id3') as typeof import('node-id3');

export interface AudioMetadataOptions {
  /** Podcast metadata from iTunes API */
  podcastMetadata: PodcastMetadata;
  /** AI-generated summary of the episode */
  summary?: string;
  /** AI-generated topic tags */
  tags?: string[];
  /** Transcript character count */
  transcriptLength?: number;
  /** Full formatted transcript text (stored in USLT/lyrics frame - no size limit) */
  transcriptText?: string;
}

/**
 * Write ID3 tags to an MP3 file
 * For M4A files, this is a no-op (node-id3 only supports MP3)
 */
export function writeAudioMetadata(filePath: string, options: AudioMetadataOptions): boolean {
  const { podcastMetadata: meta, summary, tags, transcriptLength, transcriptText } = options;

  // node-id3 only supports MP3
  if (!filePath.endsWith('.mp3')) {
    console.log(`Skipping ID3 tags for non-MP3 file: ${filePath}`);
    return false;
  }

  try {
    const publishDate = new Date(meta.publishedAt);
    const year = publishDate.getFullYear();
    const durationMinutes = Math.round(meta.duration / 60000);

    // Build comment with structured metadata for LLM consumption
    const commentParts: string[] = [];
    if (summary) commentParts.push(summary);
    if (tags && tags.length > 0) commentParts.push(`Tags: ${tags.join(', ')}`);
    if (transcriptLength) commentParts.push(`Transcript: ${transcriptLength.toLocaleString()} chars`);
    commentParts.push(`Duration: ${durationMinutes} minutes`);
    commentParts.push(`Source: ${meta.episodeUrl}`);

    const id3Tags: Record<string, any> = {
      title: meta.episodeTitle,
      artist: meta.podcastAuthor,
      album: meta.podcastName,
      year: String(year),
      genre: meta.genre || 'Podcast',
      date: meta.publishedAt.slice(0, 10).replace(/-/g, ''), // DDMM format for ID3
      publisher: meta.podcastName,
      language: 'eng',
      length: String(meta.duration), // Duration in ms
      comment: {
        language: 'eng',
        text: commentParts.join('\n'),
      },
      // Full transcript in USLT/lyrics frame (no size limit - searchable by downstream LLMs)
      ...(transcriptText ? {
        unsynchronisedLyrics: {
          language: 'eng',
          text: transcriptText,
        },
      } : {}),
      // TXXX (user-defined text) frames for custom metadata
      userDefinedText: [
        { description: 'DOC_TYPE', value: 'podcast' },
        { description: 'SUMMARY', value: summary || '' },
        { description: 'TAGS', value: (tags || []).join(', ') },
        { description: 'SOURCE_URL', value: meta.episodeUrl },
        { description: 'AUDIO_URL', value: meta.audioUrl },
        { description: 'PODCAST_FEED', value: meta.feedUrl },
        { description: 'DURATION_MS', value: String(meta.duration) },
        { description: 'PUBLISHED_AT', value: meta.publishedAt },
      ].filter(t => t.value),
    };

    const success = NodeID3.write(id3Tags, filePath);
    if (success) {
      console.log(`ID3 tags written to ${filePath}: "${meta.episodeTitle}" by ${meta.podcastAuthor}`);
    }
    return !!success;
  } catch (error) {
    console.warn(`Failed to write ID3 tags to ${filePath}:`, error instanceof Error ? error.message : error);
    return false;
  }
}
