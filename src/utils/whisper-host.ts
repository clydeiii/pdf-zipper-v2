/**
 * Pre-flight Whisper/Parakeet host selection.
 *
 * Both the Mac Mini (MLX Parakeet, primary) and the Ubuntu M1 Pro (ONNX
 * Parakeet, fallback) expose the same whisper-asr-webservice compatible API
 * — `/asr?output=txt|vtt` and `/health`. If the primary's `/health` doesn't
 * respond within a short timeout, transcription jobs route to the fallback
 * instead. Avoids wasting hours-long transcribe jobs when the primary is
 * offline.
 */

import { env } from '../config/env.js';

const HEALTH_TIMEOUT_MS = 2_000;

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
export async function resolveWhisperHost(): Promise<string> {
  if (await isHealthy(env.WHISPER_HOST)) return env.WHISPER_HOST;

  if (env.WHISPER_HOST_FALLBACK) {
    console.log(JSON.stringify({
      event: 'whisper_failover',
      from: env.WHISPER_HOST,
      to: env.WHISPER_HOST_FALLBACK,
      reason: 'primary /health did not return ok',
      timestamp: new Date().toISOString(),
    }));
    return env.WHISPER_HOST_FALLBACK;
  }

  return env.WHISPER_HOST;
}
