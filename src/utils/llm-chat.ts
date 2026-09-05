/**
 * Text-only LLM chat helper with failover across providers.
 *
 * Providers (text only — vision must use the Ollama client directly):
 * - ollama        — Ollama server at OLLAMA_HOST (primary, always enabled)
 * - llamacpp      — llama.cpp OpenAI-compatible server at LLAMACPP_HOST
 *                   (backup, enabled when LLAMACPP_HOST + LLAMACPP_API_KEY are set)
 *
 * Always tries Ollama first. On error, falls through to llama.cpp. The 26B-A4B
 * MoE on the llama.cpp box is roughly 6x slower end-to-end than the Ollama 8B,
 * so it's wired as failover-only rather than round-robin.
 *
 * Vision/image inputs are NOT routed here — llama.cpp has no mmproj.
 *
 * llama.cpp gemma4 thinking-mode note: the 26B-A4B emits chain-of-thought into
 * `reasoning_content` and returns an empty `content` if it runs out of budget
 * mid-thought. We send `chat_template_kwargs: {enable_thinking: false}` to
 * suppress this so the response lands in `content` directly.
 */
import { Ollama } from 'ollama';
import { Agent } from 'undici';
import { env } from '../config/env.js';

const longTimeoutAgent = new Agent({
  headersTimeout: 10 * 60 * 1000,
  bodyTimeout: 10 * 60 * 1000,
  connectTimeout: 30 * 1000,
});

const ollamaClient = new Ollama({
  host: env.OLLAMA_HOST,
  fetch: ((url: string | URL | Request, init?: RequestInit) => {
    return fetch(url, { ...init, dispatcher: longTimeoutAgent } as RequestInit);
  }) as typeof fetch,
});

/**
 * The ONE context size every pdf-zipper call to the shared Ollama host must
 * use — vision scoring, metadata enrichment, translation, and transcript
 * formatting alike. Ollama sizes the runner's KV cache from the request's
 * num_ctx (× OLLAMA_NUM_PARALLEL slots); a request for a different size
 * evicts the loaded model and reloads it. With enrichment at 8K and the
 * transcript formatter at 16K, mac.mini's server.log showed ~100 reloads of
 * the 9GB model per day and 30–60 "predicted to exceed available memory"
 * evictions (2026-08-30..09-04) — every article↔transcript switch paid a
 * reload and lost the prompt cache. Callers that need more room chunk their
 * input instead of raising this.
 */
export const LLM_NUM_CTX = 8192;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatTextOptions {
  /** Ollama model name (e.g. "gemma4:e4b"). The llama.cpp provider uses LLAMACPP_MODEL instead. */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** Ollama only — context window. llama.cpp's n_ctx is fixed server-side. */
  numCtx?: number;
  /** Max output tokens. Ollama: -1 = unlimited. llama.cpp: omitted when <= 0. */
  numPredict?: number;
  /**
   * Ollama only — disable internal reasoning. llama.cpp already suppresses
   * thinking server-side via chat_template_kwargs, so this is a no-op there.
   */
  think?: boolean;
  /**
   * Constrain the reply to a JSON object (Ollama `format: "json"`; llama.cpp
   * `response_format: json_object`). Use for every call that will be
   * JSON.parse'd — free-text replies wrapped in prose or code fences were the
   * cause of silently empty enrichment.
   */
  format?: 'json' | Record<string, unknown>;
}

/**
 * How long the shared model stays resident after a call. Ollama's default is
 * 5 minutes; at ~200 captures/day the gaps between jobs routinely exceed
 * that, so roughly half of mac.mini's ~100 daily model loads were idle
 * expiry rather than eviction. gemma4:e4b is meant to be resident (CLAUDE.md:
 * e4b + s1-mini + parakeet ≈ 13GB of 24GB is the intended steady state).
 * Same value the s1-normalizer already uses for its model.
 */
export const LLM_KEEP_ALIVE = '2h';

interface Provider {
  name: string;
  enabled(): boolean;
  chat(opts: ChatTextOptions): Promise<string>;
}

const ollamaProvider: Provider = {
  name: 'ollama',
  enabled: () => true,
  async chat({ model, messages, temperature, numCtx, numPredict, think, format }) {
    const options: Record<string, number> = {};
    if (temperature !== undefined) options.temperature = temperature;
    // Default to the shared size rather than Ollama's server default
    // (OLLAMA_CONTEXT_LENGTH=65536 on mac.mini) — an unsized request would
    // allocate a 64K KV cache and evict everything else.
    options.num_ctx = numCtx ?? LLM_NUM_CTX;
    if (numPredict !== undefined) options.num_predict = numPredict;

    const r = await ollamaClient.chat({
      model,
      messages,
      options,
      keep_alive: LLM_KEEP_ALIVE,
      ...(think !== undefined ? { think } : {}),
      ...(format ? { format } : {}),
    });
    return r.message.content;
  },
};

const llamacppProvider: Provider = {
  name: 'llamacpp',
  enabled: () => !!env.LLAMACPP_HOST && !!env.LLAMACPP_API_KEY,
  async chat({ messages, temperature, numPredict, format }) {
    const url = `${env.LLAMACPP_HOST!.replace(/\/$/, '')}/v1/chat/completions`;
    const body: Record<string, unknown> = {
      model: env.LLAMACPP_MODEL,
      messages,
      // Suppress gemma4 thinking-mode CoT — without this, content is empty
      // when the model runs out of max_tokens mid-thought.
      chat_template_kwargs: { enable_thinking: false },
    };
    if (temperature !== undefined) body.temperature = temperature;
    if (numPredict !== undefined && numPredict > 0) body.max_tokens = numPredict;
    if (format === 'json') body.response_format = { type: 'json_object' };
    else if (format && typeof format === 'object') {
      body.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema: format } };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LLAMACPP_API_KEY}`,
      },
      body: JSON.stringify(body),
      dispatcher: longTimeoutAgent,
    } as RequestInit);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`llamacpp ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const message = json?.choices?.[0]?.message;
    const content = message?.content;
    if (typeof content !== 'string') {
      throw new Error('llamacpp: unexpected response shape (no choices[0].message.content)');
    }
    // Defensive: if thinking suppression ever fails server-side and the answer
    // ends up in reasoning_content, surface that instead of an empty string.
    if (content.length === 0 && typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0) {
      throw new Error('llamacpp: empty content with non-empty reasoning_content (thinking-mode leak)');
    }
    return content;
  },
};

// Failover order: Ollama is tried first (faster on 8B), llama.cpp is the backup.
const allProviders = [ollamaProvider, llamacppProvider];

/**
 * Run a text chat with failover across configured providers.
 * Tries providers in fixed order (Ollama → llama.cpp); on error falls through.
 * Returns the first successful provider's response. Throws if all fail.
 */
export async function chatText(opts: ChatTextOptions): Promise<string> {
  const providers = allProviders.filter((p) => p.enabled());
  if (providers.length === 0) {
    throw new Error('chatText: no LLM providers configured');
  }

  let lastError: unknown;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const t0 = Date.now();
    try {
      const result = await provider.chat(opts);
      console.log(JSON.stringify({
        event: 'llm_chat_ok',
        provider: provider.name,
        attempt: i + 1,
        elapsedMs: Date.now() - t0,
      }));
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(JSON.stringify({
        event: 'llm_chat_failed',
        provider: provider.name,
        attempt: i + 1,
        elapsedMs: Date.now() - t0,
        error: message,
      }));
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('chatText: all providers failed');
}
