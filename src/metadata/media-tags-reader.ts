/**
 * Read Karpathy-compliant metadata back out of MP3 (ID3) and MP4 (ffmpeg) files.
 * Used by the file listing API to surface enrichment status in the UI.
 */

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const NodeID3 = require('node-id3') as typeof import('node-id3');
const execFileAsync = promisify(execFile);

export interface MediaMetadata {
  title?: string;
  author?: string;         // ID3 artist / MP4 artist
  publication?: string;    // ID3 album / MP4 album
  summary?: string;        // from TXXX SUMMARY or MP4 comment
  tags?: string[];         // from TXXX TAGS or MP4 keywords
  sourceUrl?: string;      // from TXXX SOURCE_URL or MP4 custom field
  durationMs?: number;
}

/**
 * Read ID3 tags from an MP3 file and map to our MediaMetadata shape.
 * Returns undefined if the file has no tags or can't be read.
 */
export async function readAudioMetadata(mp3Path: string): Promise<MediaMetadata | undefined> {
  if (!mp3Path.toLowerCase().endsWith('.mp3')) return undefined;

  try {
    const tags = NodeID3.read(mp3Path);
    if (!tags) return undefined;

    // Look for TXXX custom frames for summary/tags/source URL
    const summary = findUserDefined(tags, 'SUMMARY');
    const tagsCsv = findUserDefined(tags, 'TAGS');
    const sourceUrl = findUserDefined(tags, 'SOURCE_URL');

    const hasAnyMeta = !!(tags.title || tags.artist || summary || tagsCsv || sourceUrl);
    if (!hasAnyMeta) return undefined;

    return {
      title: tags.title,
      author: tags.artist,
      publication: tags.album,
      summary: summary || (tags.comment?.text ? tags.comment.text.slice(0, 500) : undefined),
      tags: tagsCsv ? tagsCsv.split(/,\s*/).filter(Boolean) : undefined,
      sourceUrl,
    };
  } catch {
    return undefined;
  }
}

type UserDefinedFrames = { description?: string; value?: string }[] | undefined;

function findUserDefined(tags: import('node-id3').Tags, description: string): string | undefined {
  const txxx = (tags.userDefinedText as UserDefinedFrames) ?? [];
  const match = txxx.find((f) => f.description === description);
  return match?.value;
}

/**
 * Read metadata tags from an MP4 file via ffprobe.
 * Our video enrichment pipeline writes: title, comment (summary+tags+source),
 * and custom fields: summary, tags, source_url.
 */
export async function readVideoMetadata(mp4Path: string): Promise<MediaMetadata | undefined> {
  const lower = mp4Path.toLowerCase();
  if (!lower.endsWith('.mp4') && !lower.endsWith('.m4a') && !lower.endsWith('.webm')) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      mp4Path,
    ], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });

    const info = JSON.parse(stdout) as {
      format?: {
        duration?: string;
        tags?: Record<string, string>;
      };
    };
    const tags = info.format?.tags || {};
    // ffmpeg lowercases keys; some come from our custom writer
    const pick = (k: string) => tags[k] || tags[k.toLowerCase()] || tags[k.toUpperCase()];

    const title = pick('title');
    const author = pick('artist') || pick('author');
    const publication = pick('album');
    const commentRaw = pick('comment');

    // MP4 containers silently drop non-standard metadata keys, so our enrichment
    // pipeline packs everything into the `comment` field as:
    //   <summary paragraph>
    //   Tags: tag1, tag2, ...
    //   Transcript: N chars
    //   Source: https://...
    // We parse those out here. Direct keys (summary/tags/source_url) are checked
    // first for forward-compatibility with other writers.
    let summary = pick('summary');
    let tagsCsv = pick('tags');
    let sourceUrl = pick('source_url');

    if (commentRaw) {
      const lines = commentRaw.split('\n');
      const summaryLines: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        const tagsMatch = trimmed.match(/^Tags:\s*(.+)$/i);
        const sourceMatch = trimmed.match(/^Source:\s*(\S+)/i);
        const transcriptMatch = trimmed.match(/^Transcript:\s*/i);
        if (tagsMatch) {
          if (!tagsCsv) tagsCsv = tagsMatch[1];
        } else if (sourceMatch) {
          if (!sourceUrl) sourceUrl = sourceMatch[1];
        } else if (!transcriptMatch && trimmed) {
          summaryLines.push(trimmed);
        }
      }
      if (!summary && summaryLines.length > 0) {
        summary = summaryLines.join(' ');
      }
    }

    const hasAnyMeta = !!(title || summary || tagsCsv || sourceUrl);
    if (!hasAnyMeta) return undefined;

    const resolvedSummary = summary;

    const durationMs = info.format?.duration
      ? Math.round(parseFloat(info.format.duration) * 1000)
      : undefined;

    return {
      title,
      author,
      publication,
      summary: resolvedSummary,
      tags: tagsCsv ? tagsCsv.split(/,\s*/).filter(Boolean) : undefined,
      sourceUrl,
      durationMs,
    };
  } catch {
    return undefined;
  }
}
