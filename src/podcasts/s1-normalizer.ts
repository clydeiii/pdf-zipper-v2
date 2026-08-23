/**
 * Stage-1 transcript normalization via S1-mini by Superwhisper.
 *
 * A 0.6B single-task model (Qwen3 fine-tune, Apache 2.0) trained purely to
 * normalize ASR output: remove fillers and stutters, fix punctuation and
 * casing of known names, resolve spoken forms. Side-by-side on real Parakeet
 * output (2026-08-21, Sharp Tech chunk) it was MORE faithful than our gemma
 * formatter — it kept hedging words ("sort of") gemma silently deleted, fixed
 * "Deep Mind"→"DeepMind" and "anthropic"→"Anthropic" without hints, and left
 * ASR garbles ("Sunar Batai", "Quad") untouched rather than hallucinating
 * fixes. It does NO paragraphing and has no hint channel, so it runs as
 * stage 1 only; the gemma pass (paragraphs + show-notes noun repair) follows.
 *
 * Invocation quirks (both verified the hard way):
 * - The exact documented system prompt is required, or output degrades.
 * - Ollama's /api/chat template yields BLANK output for this model — the
 *   assistant turn must be primed with an empty <think> block, which needs
 *   the raw Qwen3 template via /api/generate.
 *
 * Fidelity guardrails: this is a 0.6B model editing the KB's ground truth, so
 * every chunk's output must pass a length-ratio sanity check or the RAW chunk
 * is kept instead (per-chunk fallback, never per-transcript). Any transport
 * error also keeps the raw chunk. The stage as a whole can only ever be a
 * no-op, never a failure.
 *
 * Enabled by TRANSCRIPT_NORMALIZE_MODEL (empty = stage disabled).
 */

import { env } from '../config/env.js';

const SYSTEM_PROMPT =
  'You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.';

const CONTROL_LINE = '[Styling: semi-formal] [Structure: prose] [Context: general]';

/** ~1,000-token budget per pass per the model card; ~3,500 chars ≈ 850 tokens. */
export const NORMALIZE_CHUNK_CHARS = 3500;

/**
 * Output/input length ratio bounds. Disfluency removal shrinks text (observed
 * ~2% on clean Parakeet output, more on filler-heavy speech); the model should
 * never grow it much. Outside these bounds we assume the model went off the
 * rails (dropped a passage, looped) and keep the raw chunk.
 */
export const MIN_OUTPUT_RATIO = 0.55;
export const MAX_OUTPUT_RATIO = 1.15;

const CHUNK_TIMEOUT_MS = 180_000;

/**
 * Cold-loading s1-mini takes ~30s idle but can exceed the chunk timeout when
 * e4b is saturated with back-to-back vision/enrichment/tag calls (observed
 * 2026-08-22: first live run fell back on a 1,333-char chunk during a
 * 15-bookmark burst). So the model is loaded explicitly before the chunk loop
 * with its own generous timeout, and pinned resident afterwards — its 0.5GB is
 * part of the planned steady state (e4b + s1-mini + parakeet ≈ 13GB of 24GB).
 */
const WARMUP_TIMEOUT_MS = 300_000;
const KEEP_ALIVE = '2h';

async function warmUpModel(): Promise<void> {
  try {
    await fetch(`${env.OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.TRANSCRIPT_NORMALIZE_MODEL,
        keep_alive: KEEP_ALIVE,
      }),
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
    });
  } catch {
    // Best effort — the chunk loop has its own per-chunk fallback.
  }
}

/**
 * Split at paragraph boundaries (falling back to sentence boundaries inside
 * oversized paragraphs) into chunks under NORMALIZE_CHUNK_CHARS.
 * Exported for testing.
 */
export function chunkForNormalization(text: string): string[] {
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trimEnd());
    current = '';
  };

  for (const para of text.split(/\n\n+/)) {
    if (para.length > NORMALIZE_CHUNK_CHARS) {
      // Oversized paragraph: flush, then split it at sentence boundaries.
      pushCurrent();
      let sentenceChunk = '';
      for (const sentence of para.split(/(?<=[.!?])\s+/)) {
        if (sentenceChunk && sentenceChunk.length + sentence.length + 1 > NORMALIZE_CHUNK_CHARS) {
          chunks.push(sentenceChunk.trimEnd());
          sentenceChunk = '';
        }
        sentenceChunk += (sentenceChunk ? ' ' : '') + sentence;
      }
      if (sentenceChunk.trim()) chunks.push(sentenceChunk.trimEnd());
      continue;
    }
    if (current && current.length + para.length + 2 > NORMALIZE_CHUNK_CHARS) {
      pushCurrent();
    }
    current += (current ? '\n\n' : '') + para;
  }
  pushCurrent();
  return chunks;
}

/** True when the model's output passes the keep-it sanity check. Exported for testing. */
export function normalizedOutputAcceptable(input: string, output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  const ratio = trimmed.length / input.trim().length;
  return ratio >= MIN_OUTPUT_RATIO && ratio <= MAX_OUTPUT_RATIO;
}

/** Raw Qwen3 chat template with the primed empty think block. Exported for testing. */
export function buildS1Prompt(chunk: string): string {
  return (
    `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n` +
    `<|im_start|>user\n${CONTROL_LINE}\n${chunk}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n\n</think>\n\n`
  );
}

async function normalizeChunk(chunk: string): Promise<string | null> {
  const numPredict = Math.ceil((chunk.length / 4) * 1.3) + 64;
  try {
    const res = await fetch(`${env.OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.TRANSCRIPT_NORMALIZE_MODEL,
        prompt: buildS1Prompt(chunk),
        raw: true,
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: {
          temperature: 0,
          num_predict: numPredict,
          num_ctx: 4096,
          stop: ['<|im_end|>'],
        },
      }),
      signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    return typeof data.response === 'string' ? data.response.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a full transcript chunk-by-chunk. Chunks whose output fails the
 * sanity check (or whose call fails) keep their raw text. Returns the
 * reassembled transcript plus telemetry counts.
 */
export async function normalizeTranscript(
  text: string
): Promise<{ text: string; chunks: number; fallbacks: number; elapsedMs: number }> {
  const start = Date.now();
  if (!env.TRANSCRIPT_NORMALIZE_MODEL) {
    return { text, chunks: 0, fallbacks: 0, elapsedMs: 0 };
  }

  const chunks = chunkForNormalization(text);
  const out: string[] = [];
  let fallbacks = 0;

  await warmUpModel();

  for (const chunk of chunks) {
    // One retry on transport failure only — a timeout during an Ollama burst
    // often clears within the chunk window. Unacceptable OUTPUT is not
    // retried: temperature 0 would reproduce it.
    let normalized = await normalizeChunk(chunk);
    if (normalized === null) normalized = await normalizeChunk(chunk);
    if (normalized !== null && normalizedOutputAcceptable(chunk, normalized)) {
      out.push(normalized);
    } else {
      fallbacks++;
      out.push(chunk);
    }
  }

  return {
    text: out.join('\n\n'),
    chunks: chunks.length,
    fallbacks,
    elapsedMs: Date.now() - start,
  };
}
