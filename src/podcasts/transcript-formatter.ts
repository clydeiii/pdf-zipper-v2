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
  // For very short transcripts, skip LLM processing
  if (rawTranscript.length < 500) {
    return rawTranscript;
  }

  console.log(JSON.stringify({
    event: 'transcript_format_start',
    inputLength: rawTranscript.length,
    timestamp: new Date().toISOString(),
  }));

  const startTime = Date.now();

  // Process in chunks if transcript is very long (LLM context limits)
  // Most podcasts are 10-60 min = 5,000-30,000 chars, which should fit
  const maxChunkSize = 15000; // ~15k chars per chunk

  if (rawTranscript.length > maxChunkSize) {
    return await formatLongTranscript(rawTranscript, maxChunkSize, context);
  }

  const formatted = await formatChunk(rawTranscript, context);

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

  const prompt = `You are reformatting a podcast transcript. Your task is to make it readable while preserving the content exactly.

${spellingHints ? `CRITICAL - CORRECT THESE SPELLINGS:
The following terms appear in this podcast. When you see phonetically similar words, use these EXACT spellings:
${spellingHints}

For example: if you see "Claude Bot" or "claw bot" in the text, it should be "Clawdbot" (from the episode title).
` : ''}
FORMATTING RULES:
1. Combine short choppy sentences into flowing paragraphs (4-6 sentences each)
2. Remove filler words: "um", "uh", "like" (as filler), "you know", "I mean"
3. Add paragraph breaks when the topic changes
4. Keep ALL content including sponsor reads - just make it readable
5. Output plain text only - no markdown, no headers, no commentary

Return ONLY the reformatted transcript:

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
      options: {
        temperature: 0.3, // Low temperature for consistent formatting
        num_predict: -1,  // No limit on output tokens
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
