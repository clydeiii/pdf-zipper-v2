/**
 * Pre-flight Whisper/Parakeet host selection.
 *
 * Both the Mac Mini (MLX Parakeet, primary) and the Ubuntu M1 Pro (ONNX
 * Parakeet, fallback) expose a whisper-asr-webservice style API
 * — `/asr?output=txt|vtt` and `/health`. If the primary's `/health` doesn't
 * respond within a short timeout, transcription jobs route to the fallback
 * instead. Avoids wasting hours-long transcribe jobs when the primary is
 * offline.
 *
 * The two servers are NOT byte-identical: the primary's `/asr` expects the
 * audio multipart field named `audio_file`, while the ONNX fallback's FastAPI
 * `/asr` requires it named `file` (a mismatched name 422s the request). So
 * the resolved target carries the correct field name for whichever host won.
 */

import { env } from '../config/env.js';

const HEALTH_TIMEOUT_MS = 2_000;

export interface WhisperTarget {
  /** Base URL of the chosen ASR host. */
  host: string;
  /** Multipart field name the chosen host's `/asr` expects for the audio file. */
  audioFieldName: 'audio_file' | 'file';
}

async function isHealthy(host: string): Promise<boolean> {
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
