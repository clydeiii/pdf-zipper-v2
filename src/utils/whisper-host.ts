/**
 * Pre-flight Whisper/Parakeet host selection.
 *
 * Both the Mac Mini (MLX Parakeet, primary) and the Ubuntu M1 Pro (ONNX
 * Parakeet, fallback) expose a whisper-asr-webservice style API
 * — `/asr?output=txt|vtt` and `/health`. If the primary's `/health` doesn't
 * respond, transcription jobs route to the fallback instead. Avoids wasting
 * hours-long transcribe jobs when the primary is offline.
 *
 * The two servers are NOT byte-identical: the primary's `/asr` expects the
 * audio multipart field named `audio_file`, while the ONNX fallback's FastAPI
 * `/asr` requires it named `file` (a mismatched name 422s the request). So
 * the resolved target carries the correct field name for whichever host won.
 */

import { env } from '../config/env.js';

/**
 * `/health` probe timeout. The primary MLX server is single-threaded, so
 * while it's mid-transcription it answers `/health` slowly — a tight timeout
 * here triggers needless failover. Kept generous on purpose.
 */
const HEALTH_TIMEOUT_MS = 8_000;
/** Wait before the second `/health` probe (see isHealthy). */
const HEALTH_RETRY_DELAY_MS = 1_500;

/** Transcription is attempted this many times across transient ASR failures. */
export const TRANSCRIBE_ATTEMPTS = 3;
/** Backoff before retry attempt N (index 0 → after attempt 1, etc.). */
const TRANSCRIBE_RETRY_DELAYS_MS = [15_000, 45_000];

export interface WhisperTarget {
  /** Base URL of the chosen ASR host. */
  host: string;
  /** Multipart field name the chosen host's `/asr` expects for the audio file. */
  audioFieldName: 'audio_file' | 'file';
}

async function probeHealth(host: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    const resp = await fetch(`${host.replace(/\/$/, '')}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Health check with one retry. A single missed `/health` (the primary was
 * momentarily busy) shouldn't condemn the host — probe twice before declaring
 * it down and failing over.
 */
async function isHealthy(host: string): Promise<boolean> {
  if (await probeHealth(host)) return true;
  await new Promise((r) => setTimeout(r, HEALTH_RETRY_DELAY_MS));
  return probeHealth(host);
}

/**
 * Resolve the active ASR host. Probes the primary; falls back if it's
 * unhealthy. If no fallback is configured (or it's also down), returns
 * the primary anyway so the real transcribe call surfaces the error.
 */
export async function resolveWhisperHost(): Promise<WhisperTarget> {
  if (await isHealthy(env.WHISPER_HOST)) {
    return { host: env.WHISPER_HOST, audioFieldName: 'audio_file' };
  }

  if (env.WHISPER_HOST_FALLBACK) {
    console.log(JSON.stringify({
      event: 'whisper_failover',
      from: env.WHISPER_HOST,
      to: env.WHISPER_HOST_FALLBACK,
      reason: 'primary /health did not return ok',
      timestamp: new Date().toISOString(),
    }));
    return { host: env.WHISPER_HOST_FALLBACK, audioFieldName: 'file' };
  }

  return { host: env.WHISPER_HOST, audioFieldName: 'audio_file' };
}

/**
 * Run an ASR transcription with retries. Each attempt re-resolves the host,
 * so a primary that was briefly busy (and failed its /health pre-flight) gets
 * picked up again once it frees, and a transient fallback 5xx gets another
 * shot on a later attempt.
 *
 * Without this, a single ASR hiccup permanently drops the transcript: video
 * enrichment treats a failed transcription as non-fatal and never revisits it.
 */
export async function transcribeWithRetry<T>(
  label: string,
  run: (target: WhisperTarget) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSCRIBE_ATTEMPTS; attempt++) {
    const target = await resolveWhisperHost();
    try {
      return await run(target);
    } catch (err) {
      lastError = err;
      const delayMs = TRANSCRIBE_RETRY_DELAYS_MS[attempt - 1];
      if (attempt >= TRANSCRIBE_ATTEMPTS || delayMs == null) break;
      console.log(JSON.stringify({
        event: 'transcribe_retry',
        label,
        attempt,
        host: target.host,
        error: err instanceof Error ? err.message : String(err),
        retryInMs: delayMs,
        timestamp: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}
