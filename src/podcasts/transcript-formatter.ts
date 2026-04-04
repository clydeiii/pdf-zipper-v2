/**
 * Transcript formatter using LLM post-processing
 *
 * Takes raw ASR output (choppy, pause-based paragraphs) and reformats
 * into readable, semantically-structured paragraphs using Ollama.
 */

import { ollama } from '../quality/ollama.js';
import { env } from '../config/env.js';
import type { PodcastMetadata } from './types.js';

/**
 * Context hints from show notes to help LLM format correctly
 */
interface FormattingContext {
  showNotes?: PodcastMetadata['showNotes'];
  episodeTitle?: string;
}

/**
 * Strip SRT subtitle formatting to get plain text
 * Handles both standard SRT (sequence + timestamps + text) and partial formats
 */
function stripSrtFormatting(text: string): string {
  // Check if this looks like SRT format (has timestamp patterns)
  if (!/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(text)) {
    return text; // Not SRT, return as-is
  }

  return text
    // Remove sequence numbers (standalone digits on their own line)
    .replace(/^\d+\s*$/gm, '')
    // Remove timestamp lines
    .replace(/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s*$/gm, '')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    // Rejoin lines broken mid-sentence (lowercase continuation)
    .replace(/\n([a-z])/g, ' $1')
    .trim();
}

/**
 * Format a transcript using LLM to create readable paragraphs
 *
 * @param rawTranscript - Raw transcript from Whisper (choppy paragraphs)
 * @param context - Optional show notes to help with proper nouns and topics
 * @returns Formatted transcript with proper paragraph structure
 */
export async function formatTranscriptWithLLM(
  rawTranscript: string,
  context?: FormattingContext
): Promise<string> {
  // Strip SRT formatting if present (old Whisper instances may return SRT)
  const cleanedTranscript = stripSrtFormatting(rawTranscript);

  // For very short transcripts, skip LLM processing
  if (cleanedTranscript.length < 500) {
    return cleanedTranscript;
  }

  console.log(JSON.stringify({
    event: 'transcript_format_start',
    rawLength: rawTranscript.length,
    cleanedLength: cleanedTranscript.length,
    srtStripped: cleanedTranscript.length !== rawTranscript.length,
    timestamp: new Date().toISOString(),
  }));

  const startTime = Date.now();

  // Process in chunks if transcript is very long (LLM context limits)
  // Most podcasts are 10-60 min = 5,000-30,000 chars, which should fit
  const maxChunkSize = 15000; // ~15k chars per chunk

  if (cleanedTranscript.length > maxChunkSize) {
    return await formatLongTranscript(cleanedTranscript, maxChunkSize, context);
  }

  const formatted = await formatChunk(cleanedTranscript, context);

  const elapsed = Date.now() - startTime;
  console.log(JSON.stringify({
    event: 'transcript_format_complete',
    inputLength: rawTranscript.length,
    outputLength: formatted.length,
    elapsedMs: elapsed,
    timestamp: new Date().toISOString(),
  }));

  return formatted;
}

/**
 * Build spelling corrections from show notes
 * Extract proper nouns that might be misheard by ASR
 */
function buildSpellingCorrections(context?: FormattingContext): string {
  if (!context) return '';

  const corrections: string[] = [];

  // Episode title often contains the key proper noun
  if (context.episodeTitle) {
    corrections.push(`"${context.episodeTitle}" (episode title - use this exact spelling)`);
  }

  // Extract key terms from show notes links - only multi-word proper nouns or unusual spellings
  if (context.showNotes?.links && context.showNotes.links.length > 0) {
    for (const link of context.showNotes.links) {
      // Look for brand names, product names, and unusual capitalizations
      // Skip common words that happen to be capitalized at sentence start
      const skipWords = new Set(['The', 'Here', 'Are', 'Is', 'Now', 'What', 'How', 'Why', 'More', 'New', 'About', 'Over', 'Your', 'Its', 'Data', 'Users', 'Keys', 'Even', 'Biggest', 'Changes', 'Latest', 'Model', 'Uses', 'Gave', 'FBI', 'Future', 'Personal', 'Assistants', 'Looks', 'Like', 'Collecting']);

      // Extract likely brand/product names (consecutive capitals or camelCase)
      const brandMatches = link.text.match(/[A-Z][a-z]+[A-Z][a-z]+|[A-Z]{2,}[a-z]+|[a-z]+[A-Z]/g) || [];
      for (const match of brandMatches) {
        if (!corrections.some(c => c.includes(match))) {
          corrections.push(`"${match}"`);
        }
      }

      // Also grab obvious product names (single words with mixed case or followed by numbers)
      const productMatches = link.text.match(/\b(TikTok|AirTag|BitLocker|ChatGPT|Grok|Grokipedia|xAI|Clawdbot)\b/gi) || [];
      for (const match of productMatches) {
        if (!corrections.some(c => c.toLowerCase().includes(match.toLowerCase()))) {
          corrections.push(`"${match}"`);
        }
      }
    }
  }

  if (corrections.length === 0) return '';

  return corrections.join(', ');
}

/**
 * Format a single chunk of transcript
 */
async function formatChunk(text: string, context?: FormattingContext): Promise<string> {
  const spellingHints = buildSpellingCorrections(context);

  const prompt = `Reformat this podcast transcript into clean, readable prose.

INPUT CONTEXT:
- This is a podcast transcript (may be conversational or a narrated blog post)
- It may contain ASR artifacts from speech-to-text: "Subtitle", "Heading", "Subheading" are structural markers spoken aloud — remove them
- Image/figure descriptions ("There's an image here...") should be condensed to just the figure number and caption
${spellingHints ? `- Proper nouns to correct: ${spellingHints}` : ''}

RULES:
1. Group related sentences into paragraphs of 3-5 sentences. Break at topic shifts.
2. Remove TTS artifacts: "Subtitle", "Heading", "Subheading", "There's a heading here"
3. For figure references, keep only: [Figure N: caption text]
4. Remove verbal filler: "um", "uh", "you know", "I mean", "sort of", "kind of" (as filler)
5. Fix punctuation and capitalization where ASR got it wrong
6. Preserve ALL substantive content — do not summarize or skip anything
7. Output plain text only. No markdown formatting, no headers, no commentary.

Return ONLY the cleaned transcript:

${text}`;

  // Log the prompt for debugging (first 500 chars)
  console.log(JSON.stringify({
    event: 'transcript_format_prompt',
    hasSpellingHints: !!spellingHints,
    promptPreview: prompt.substring(0, 500),
    timestamp: new Date().toISOString(),
  }));

  try {
    const response = await ollama.chat({
      model: env.TRANSCRIPT_FORMAT_MODEL,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      think: false,       // Disable internal reasoning (saves ~3000 tokens per call)
      options: {
        temperature: 0.3, // Low temperature for consistent formatting
        num_predict: -1,  // No limit on output tokens
        num_ctx: 32768,   // 32K context for long transcript chunks
      },
    });

    return response.message.content.trim();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'transcript_format_error',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));

    // Return original on error
    return text;
  }
}

/**
 * Format a long transcript by processing in chunks
 * Splits at paragraph boundaries to avoid cutting mid-sentence
 */
async function formatLongTranscript(
  text: string,
  maxChunkSize: number,
  context?: FormattingContext
): Promise<string> {
  console.log(JSON.stringify({
    event: 'transcript_format_chunked',
    totalLength: text.length,
    maxChunkSize,
    timestamp: new Date().toISOString(),
  }));

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (paragraph break or sentence end)
    let splitPoint = remaining.lastIndexOf('\n\n', maxChunkSize);
    if (splitPoint === -1 || splitPoint < maxChunkSize * 0.5) {
      splitPoint = remaining.lastIndexOf('. ', maxChunkSize);
    }
    if (splitPoint === -1 || splitPoint < maxChunkSize * 0.5) {
      splitPoint = maxChunkSize;
    }

    chunks.push(remaining.substring(0, splitPoint + 1));
    remaining = remaining.substring(splitPoint + 1).trim();
  }

  console.log(JSON.stringify({
    event: 'transcript_format_chunks_created',
    chunkCount: chunks.length,
    chunkSizes: chunks.map(c => c.length),
    timestamp: new Date().toISOString(),
  }));

  // Process chunks sequentially to avoid overwhelming Ollama
  const formattedChunks: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(JSON.stringify({
      event: 'transcript_format_chunk_start',
      chunkIndex: i + 1,
      totalChunks: chunks.length,
      chunkLength: chunks[i].length,
      timestamp: new Date().toISOString(),
    }));

    const formatted = await formatChunk(chunks[i], context);
    formattedChunks.push(formatted);
  }

  return formattedChunks.join('\n\n');
}
