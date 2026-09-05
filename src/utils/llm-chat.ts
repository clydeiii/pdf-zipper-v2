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

/**
 * Rough token estimate without a tokenizer: CJK / other non-Latin scripts
 * tokenize at roughly one token per character, Latin text at ~3.6 chars per
 * token (gemma vocab, measured on English prose). Deliberately pessimistic —
 * it's used to size chunks so input + output fit LLM_NUM_CTX, and the cost of
 * overestimating is one more chunk, while underestimating silently truncates.
 */
export function estimateTokens(text: string): number {
  let dense = 0;
  let latin = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x2e7f) dense++;  // CJK, Hangul, kana, emoji, most symbol blocks
    else latin++;
  }
  return dense + Math.ceil(latin / 3.6);
}

/**
 * Chars of `text` that fit an estimated `tokens` budget, so callers can chunk
 * by tokens while still slicing by characters. For pure Latin text this is
 * ~3.6 × tokens; for CJK-heavy text it approaches `tokens` itself.
 */
export function charBudgetForTokens(text: string, tokens: number): number {
  const total = estimateTokens(text);
  if (total <= tokens) return text.length;
  return Math.max(500, Math.floor(text.length * (tokens / total)));
}

/**
 * Tokens a chunk's INPUT may use when the call's output is expected to be
 * about as long as the input (formatting, translation): half the context
 * minus room for the prompt/hints and a safety margin.
 */
export const SAME_LENGTH_OUTPUT_INPUT_TOKENS = Math.floor((LLM_NUM_CTX - 1024) / 2); // 3584

/**
 * Server-side timing for one call, when the provider reports it (Ollama
 * does). Lets the log separate "the model was slow" from "we waited in the
 * queue / reloaded the model": client wall time − total_duration is queueing
 * and transport; load_duration > ~1s means the model was (re)loaded for this
 * call. All nanoseconds from Ollama, converted to ms here.
 */
export interface ChatCallStats {
  loadMs?: number;
  promptTokens?: number;
  promptEvalMs?: number;
  outputTokens?: number;
  evalMs?: number;
  totalMs?: number;
  /** `stop` = finished naturally; `length` = hit the output/context limit (reply is truncated). */
  doneReason?: string;
}

interface Provider {
  name: string;
  enabled(): boolean;
  chat(opts: ChatTextOptions): Promise<{ content: string; stats?: ChatCallStats }>;
}

export function ollamaStats(r: {
  total_duration?: number; load_duration?: number; prompt_eval_count?: number;
  prompt_eval_duration?: number; eval_count?: number; eval_duration?: number;
  done_reason?: string;
}): ChatCallStats {
  const ms = (ns?: number) => (typeof ns === 'number' ? Math.round(ns / 1e6) : undefined);
  return {
    loadMs: ms(r.load_duration),
    promptTokens: r.prompt_eval_count,
    promptEvalMs: ms(r.prompt_eval_duration),
    outputTokens: r.eval_count,
    evalMs: ms(r.eval_duration),
    totalMs: ms(r.total_duration),
    doneReason: r.done_reason,
  };
}

/** Last call's server stats, for callers that need `doneReason` (chatText returns only text). */
let lastCallStats: ChatCallStats | undefined;
export function getLastChatStats(): ChatCallStats | undefined {
  return lastCallStats;
}

function makeOllamaProvider(name: string, host: string, modelOverride?: string): Provider {
  const client = new Ollama({
    host,
    fetch: ((url: string | URL | Request, init?: RequestInit) => {
      return fetch(url, { ...init, dispatcher: longTimeoutAgent } as RequestInit);
    }) as typeof fetch,
  });
  return {
    name,
    enabled: () => true,
    async chat({ model, messages, temperature, numCtx, numPredict, think, format }) {
      const options: Record<string, number> = {};
      if (temperature !== undefined) options.temperature = temperature;
      // Default to the shared size rather than Ollama's server default
      // (OLLAMA_CONTEXT_LENGTH=65536 on mac.mini) — an unsized request would
      // allocate a 64K KV cache and evict everything else.
      options.num_ctx = numCtx ?? LLM_NUM_CTX;
      if (numPredict !== undefined) options.num_predict = numPredict;

      const r = await client.chat({
        model: modelOverride ?? model,
        messages,
        options,
        keep_alive: LLM_KEEP_ALIVE,
        ...(think !== undefined ? { think } : {}),
        ...(format ? { format } : {}),
      });
      return { content: r.message.content, stats: ollamaStats(r) };
    },
  };
}

const ollamaProvider: Provider = makeOllamaProvider('ollama', env.OLLAMA_HOST);

/**
 * Second Ollama host (the m1pro box) as a NATIVE Ollama provider: same
 * num_ctx / keep_alive / think / format handling as the primary. Before
 * 2026-09-04 it was reached through the llama.cpp adapter below, which drops
 * num_ctx and think and sends llama.cpp-only template kwargs — wrong for an
 * Ollama endpoint. Failover-only (≈10 tok/s vs 58 on mac.mini).
 */
const ollamaFallbackProvider: Provider | null = env.OLLAMA_FALLBACK_HOST
  ? { ...makeOllamaProvider('ollama-fallback', env.OLLAMA_FALLBACK_HOST, env.OLLAMA_FALLBACK_MODEL), enabled: () => true }
  : null;

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
    return { content };
  },
};

// Failover order: primary Ollama, then the fallback Ollama host, then a real
// llama.cpp server if one is configured.
const allProviders: Provider[] = [ollamaProvider, ...(ollamaFallbackProvider ? [ollamaFallbackProvider] : []), llamacppProvider];

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
      const { content, stats } = await provider.chat(opts);
      const elapsedMs = Date.now() - t0;
      lastCallStats = stats;
      if (stats?.doneReason === 'length') {
        // The reply hit the output/context limit — whatever the caller does
        // with it, it is incomplete. Callers that need fidelity (transcript
        // formatting, translation) check getLastChatStats() and fall back.
        console.warn(JSON.stringify({
          event: 'llm_output_truncated',
          provider: provider.name,
          promptTokens: stats.promptTokens,
          outputTokens: stats.outputTokens,
          numCtx: opts.numCtx ?? LLM_NUM_CTX,
          timestamp: new Date().toISOString(),
        }));
      }
      console.log(JSON.stringify({
        event: 'llm_chat_ok',
        provider: provider.name,
        attempt: i + 1,
        elapsedMs,
        // Server-side breakdown (Ollama): what the model spent vs what we
        // waited. queueMs is the residual — time the request sat behind
        // other work (or in transport) before the model touched it.
        ...(stats ? { ...stats, queueMs: stats.totalMs !== undefined ? Math.max(0, elapsedMs - stats.totalMs) : undefined } : {}),
      }));
      return content;
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
