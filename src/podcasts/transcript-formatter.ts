/**
 * Transcript formatter using LLM post-processing
 *
 * Takes raw ASR output (choppy, pause-based paragraphs) and reformats
 * into readable, semantically-structured paragraphs using Ollama.
 */

import { chatText } from '../utils/llm-chat.js';
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
 * Normalize transcript whitespace: CRLF/CR → LF, and collapse single newlines
 * inside paragraphs to spaces. Parakeet emits only blank-line paragraph breaks,
 * so any lone \n (typically LLM reflow artifacts) is noise that downstream PDF
 * renderers would turn into a hard mid-paragraph line break.
 */
function normalizeTranscriptWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([^\n])\n(?!\n)/g, '$1 ');
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
 * Clean up Parakeet paragraph-grouping artifacts:
 * 1. Period/comma at start of line (sentence-split alignment issue)
 * 2. Orphan fragments < 80 chars that should merge with neighbors
 * 3. Collapse excessive paragraph breaks
 */
function cleanParakeetArtifacts(text: string): string {
  let cleaned = text
    // Fix period/comma/question at start of a line — merge with previous line
    // e.g. "Yeah\n. Most people" → "Yeah. Most people"
    .replace(/\n([.?!,;:]) /g, '$1 ')
    // Same across paragraph breaks: "Yeah\n\n. Most" → "Yeah.\n\nMost"
    .replace(/\n\n([.?!]) /g, '$1\n\n');

  // Merge orphan paragraphs (< 80 chars) with the next paragraph
  const paragraphs = cleaned.split(/\n\n+/);
  const merged: string[] = [];
  let carry = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (carry) {
      // Attach orphan to this paragraph
      merged.push(carry + ' ' + trimmed);
      carry = '';
    } else if (trimmed.length < 80 && merged.length > 0) {
      // Too short to be its own paragraph — try merging with previous
      merged[merged.length - 1] += ' ' + trimmed;
    } else if (trimmed.length < 80 && merged.length === 0) {
      // First paragraph is short — carry forward
      carry = trimmed;
    } else {
      merged.push(trimmed);
    }
  }
  if (carry) {
    if (merged.length > 0) {
      merged[merged.length - 1] += ' ' + carry;
    } else {
      merged.push(carry);
    }
  }

  return merged.join('\n\n');
}

/**
 * Format a transcript using LLM to create readable paragraphs
 *
 * @param rawTranscript - Raw transcript from ASR (Parakeet or Whisper)
 * @param context - Optional show notes to help with proper nouns and topics
 * @returns Formatted transcript with proper paragraph structure
 */
export async function formatTranscriptWithLLM(
  rawTranscript: string,
  context?: FormattingContext
): Promise<string> {
  // Strip SRT formatting if present (old Whisper instances may return SRT)
  let cleanedTranscript = stripSrtFormatting(normalizeTranscriptWhitespace(rawTranscript));

  // Clean Parakeet paragraph-grouping artifacts
  cleanedTranscript = cleanParakeetArtifacts(cleanedTranscript);

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

  // If no spelling hints, skip LLM entirely — Parakeet already produces
  // punctuated, cased, paragraph-broken text. No point burning 13 min of
  // Ollama time just to remove a few filler words.
  if (!spellingHints) {
    console.log(JSON.stringify({
      event: 'transcript_format_skipped',
      reason: 'no_spelling_hints',
      textLength: text.length,
      timestamp: new Date().toISOString(),
    }));
    return text;
  }

  const prompt = `Fix proper noun spellings in this transcript. You are a PROOFREADER, not an editor. This output feeds another AI that trusts it as ground truth — hallucinated substitutions corrupt the record.

PROPER NOUNS TO FIX (case-insensitive match): ${spellingHints}

RULES:
- Replace words that phonetically or textually match the proper nouns above with the correct spelling (e.g. "open claw" → "OpenClaw", "chat GPT" → "ChatGPT").
- Remove standalone verbal filler: "um", "uh", "you know", "I mean", "sort of", "kind of" — only when filler, not when meaningful.
- DO NOT change any other words. If you see something unfamiliar (e.g. "01"), leave it exactly as is.
- DO NOT add, remove, reorder, or summarize sentences. Output must be the same length as input.
- Preserve all existing paragraph breaks (blank lines).

Output plain text only. Return ONLY the corrected transcript:

${text}`;

  // Log the prompt for debugging (first 500 chars)
  console.log(JSON.stringify({
    event: 'transcript_format_prompt',
    hasSpellingHints: !!spellingHints,
    promptPreview: prompt.substring(0, 500),
    timestamp: new Date().toISOString(),
  }));

  try {
    // Routed through chatText so a mac.mini/Ollama outage fails over to the
    // llama.cpp box instead of silently dropping the proper-noun spelling pass.
    const response = await chatText({
      model: env.TRANSCRIPT_FORMAT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      think: false,       // Disable internal reasoning (saves ~3000 tokens per call)
      temperature: 0.2,   // Low temperature — this is proofreading, not creative
      numPredict: -1,     // No limit on output tokens
      numCtx: 16384,      // 16K — prompt is much shorter now (just proper-noun fix)
    });

    // The LLM sometimes reflows text with lone newlines despite the prompt —
    // normalize so its artifacts never reach the PDF generators.
    return normalizeTranscriptWhitespace(response.trim());
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
  // Separator consumed at each split, restored verbatim on rejoin so chunking
  // never invents a paragraph break that wasn't in the source (joining
  // sentence-level splits with '\n\n' used to insert a fake paragraph break
  // mid-paragraph every ~15k chars).
  const separators: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (paragraph break or sentence end)
    let splitPoint = remaining.lastIndexOf('\n\n', maxChunkSize);
    let separator = '\n\n';
    if (splitPoint === -1 || splitPoint < maxChunkSize * 0.5) {
      splitPoint = remaining.lastIndexOf('. ', maxChunkSize);
      separator = ' ';
      if (splitPoint !== -1) splitPoint += 1; // keep the '.' with the chunk
    }
    if (splitPoint === -1 || splitPoint < maxChunkSize * 0.5) {
      splitPoint = maxChunkSize;
      separator = ''; // forced mid-word split — rejoin seamlessly
    }

    chunks.push(remaining.substring(0, splitPoint));
    separators.push(separator);
    remaining = remaining.substring(splitPoint).replace(/^[ \n]+/, '');
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

  return formattedChunks
    .map((chunk, i) => (i < separators.length ? chunk + separators[i] : chunk))
    .join('');
}
