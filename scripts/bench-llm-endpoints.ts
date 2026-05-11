/**
 * Side-by-side benchmark of the two text LLM endpoints we have available.
 *
 *   ollama:   http://mac.mini:11434  model "gemma4:latest"  (dense ~8B)
 *   llamacpp: http://10.0.0.81:8080  model "gemma4"         (gemma-4-26B-A4B MoE)
 *
 * Uses three workloads modeled after real call sites:
 *   1) extract — short metadata extraction prompt (~6KB input, JSON output)
 *   2) format  — transcript-formatter chunk (~12KB input, ~12KB output)
 *   3) translate — long translation chunk (~9KB input, ~9KB output)
 *
 * Reports prompt-eval and generation throughput (tokens/sec), wall time,
 * and a sample of the output so quality can be eyeballed.
 *
 * Run with:
 *   npx tsx --env-file=.env scripts/bench-llm-endpoints.ts
 */
import { Ollama } from 'ollama';
import { Agent } from 'undici';
import { env } from '../src/config/env.js';

const longTimeoutAgent = new Agent({
  headersTimeout: 30 * 60 * 1000,
  bodyTimeout: 30 * 60 * 1000,
  connectTimeout: 30 * 1000,
});

const ollama = new Ollama({
  host: env.OLLAMA_HOST,
  fetch: ((url: string | URL | Request, init?: RequestInit) => {
    return fetch(url, { ...init, dispatcher: longTimeoutAgent } as RequestInit);
  }) as typeof fetch,
});

interface RunResult {
  endpoint: string;
  model: string;
  workload: string;
  wallMs: number;
  promptTokens: number;
  outputTokens: number;
  promptTokPerSec: number | null;
  outputTokPerSec: number | null;
  preview: string;
  error?: string;
}

async function runOllama(workload: string, model: string, prompt: string, numCtx: number): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const r = await ollama.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.2, num_ctx: numCtx, num_predict: -1 },
    });
    const wallMs = Date.now() - t0;
    // Ollama returns timing fields directly on the response
    const anyR = r as unknown as {
      prompt_eval_count?: number;
      prompt_eval_duration?: number;
      eval_count?: number;
      eval_duration?: number;
    };
    const promptTokens = anyR.prompt_eval_count ?? 0;
    const outputTokens = anyR.eval_count ?? 0;
    const promptDurNs = anyR.prompt_eval_duration ?? 0;
    const outDurNs = anyR.eval_duration ?? 0;
    return {
      endpoint: env.OLLAMA_HOST,
      model,
      workload,
      wallMs,
      promptTokens,
      outputTokens,
      promptTokPerSec: promptDurNs > 0 ? (promptTokens / (promptDurNs / 1e9)) : null,
      outputTokPerSec: outDurNs > 0 ? (outputTokens / (outDurNs / 1e9)) : null,
      preview: r.message.content.slice(0, 160).replace(/\s+/g, ' '),
    };
  } catch (err) {
    return {
      endpoint: env.OLLAMA_HOST, model, workload,
      wallMs: Date.now() - t0,
      promptTokens: 0, outputTokens: 0, promptTokPerSec: null, outputTokPerSec: null,
      preview: '', error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runLlamacpp(workload: string, model: string, prompt: string, maxTokens: number): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const url = `${env.LLAMACPP_HOST!.replace(/\/$/, '')}/v1/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LLAMACPP_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
      dispatcher: longTimeoutAgent,
    } as RequestInit);
    const wallMs = Date.now() - t0;
    if (!res.ok) {
      return {
        endpoint: env.LLAMACPP_HOST!, model, workload, wallMs,
        promptTokens: 0, outputTokens: 0, promptTokPerSec: null, outputTokPerSec: null,
        preview: '', error: `${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      timings?: {
        prompt_n?: number; prompt_per_second?: number;
        predicted_n?: number; predicted_per_second?: number;
      };
    };
    const promptTokens = json.timings?.prompt_n ?? json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.timings?.predicted_n ?? json.usage?.completion_tokens ?? 0;
    return {
      endpoint: env.LLAMACPP_HOST!,
      model,
      workload,
      wallMs,
      promptTokens,
      outputTokens,
      promptTokPerSec: json.timings?.prompt_per_second ?? null,
      outputTokPerSec: json.timings?.predicted_per_second ?? null,
      preview: json.choices[0].message.content.slice(0, 160).replace(/\s+/g, ' '),
    };
  } catch (err) {
    return {
      endpoint: env.LLAMACPP_HOST!, model, workload,
      wallMs: Date.now() - t0,
      promptTokens: 0, outputTokens: 0, promptTokPerSec: null, outputTokPerSec: null,
      preview: '', error: err instanceof Error ? err.message : String(err),
    };
  }
}

const SHORT_ARTICLE = `Anthropic released Claude Opus 4.7 today, the latest in the Claude 4 family. The new model achieves state-of-the-art results on SWE-bench Verified and is the first frontier model with a 1M-token context window enabled by default for long-context users. CEO Dario Amodei said the launch is "the most capable coding model we've shipped." Pricing remains the same as Opus 4.6: $15 per million input tokens and $75 per million output tokens. The release follows a quiet rollout of internal evaluations earlier this month showing significant gains on agentic benchmarks like OSWorld and WebArena, where Claude must operate a virtual computer to complete multi-step tasks. Several enterprise customers including Notion and Replit gained early access; both report measurable productivity gains for their engineering teams. The release was announced on Anthropic's blog at 9am Pacific. Reuters reported that Anthropic is in talks to raise additional capital at a valuation north of $200 billion. — By Kai Tanaka, San Francisco bureau, January 26, 2026.`.repeat(8);

const TRANSCRIPT_CHUNK = `So I think we're entering a phase where the bottleneck is no longer model intelligence — it's how much context the model can actually keep in working memory. And what's interesting about the 1 million token release is that it changes the kind of question you can ask. You can put a whole codebase in the context window. You can put a quarter of legal filings in there. You don't have to do retrieval, you don't have to chunk, you don't have to argue with a vector database about which chunks were relevant.

Right and I think the other thing people aren't internalizing is that prompt caching means the marginal cost of a 900K-token query is basically zero after the first hit. You're not paying full price every time. So the real workflow is: load the whole repo once, then ask it twenty questions back to back, and each follow-up question is cheap.

There's a tradeoff though. The latency on a cold cache is high — multiple seconds before the first token. And if your traffic is bursty, you can't keep the cache warm. So there's a kind of tension between how you want to architect the request pattern and how the cache works in practice. We've been experimenting with a heartbeat scheme where you send a tiny query every four minutes just to keep the cache from expiring.

Yeah and that's actually how Claude Code does it under the hood — it's not magic, it's just disciplined about cache hygiene. The other thing worth saying is that for code review specifically, the long context unlocks a category of feedback that was just impossible before: cross-file consistency, architectural drift, "you're reimplementing this helper that already exists in another package." That stuff requires the model to actually see the whole repo at once.`.repeat(6);

const TRANSLATION_TEXT = `人工知能の急速な発展は、ソフトウェア工学の風景を根本的に変えつつある。大規模言語モデルがコードベース全体を文脈として保持できるようになったことで、開発者は単なるコード補完を超えた支援を受けられるようになった。クロスファイルのリファクタリング、アーキテクチャの整合性チェック、既存ヘルパーの重複検出など、これまで人間のレビュアーにしかできなかった作業が自動化され始めている。一方で、新たな課題も浮上している。モデルの判断を信頼するために、根拠の透明性、再現性、そして失敗モードの理解が必要となる。日本企業の多くは、これらの技術を業務に統合する際、データの機密性と国内規制への準拠を最優先課題として位置付けている。`.repeat(15);

const WORKLOADS = [
  {
    name: 'extract',
    prompt: `Extract metadata from the following article. Return ONLY a JSON object: {"title":"...","author":"...","publishDate":"YYYY-MM-DD","tags":["t1","t2","t3"],"summary":"2-3 sentence summary"}\n\n${SHORT_ARTICLE}`,
    numCtx: 8192,
    maxTokens: 600,
  },
  {
    name: 'format',
    prompt: `You are a proofreader, not an editor. Fix proper-noun spellings and remove filler words ("um", "uh", "you know"). Do not change anything else. Preserve paragraph breaks. Return only the corrected transcript.\n\n${TRANSCRIPT_CHUNK}`,
    numCtx: 16384,
    maxTokens: 4096,
  },
  {
    name: 'translate',
    prompt: `Translate the following Japanese text to English. Output ONLY the English translation, preserving paragraph structure.\n\n${TRANSLATION_TEXT}`,
    numCtx: 16384,
    maxTokens: 4096,
  },
];

function fmt(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return '   —  ';
  return n.toFixed(digits).padStart(7);
}

async function main(): Promise<void> {
  console.log(`OLLAMA_HOST=${env.OLLAMA_HOST}  model=gemma4:latest`);
  console.log(`LLAMACPP_HOST=${env.LLAMACPP_HOST}  model=${env.LLAMACPP_MODEL}`);
  console.log('');

  const results: RunResult[] = [];

  for (const w of WORKLOADS) {
    console.log(`\n=== workload: ${w.name}  (prompt ~${w.prompt.length} chars) ===`);

    console.log('  → ollama gemma4:latest …');
    const a = await runOllama(w.name, 'gemma4:latest', w.prompt, w.numCtx);
    results.push(a);
    if (a.error) console.log(`    ERROR: ${a.error}`);
    else console.log(`    wall=${(a.wallMs / 1000).toFixed(1)}s  prompt=${a.promptTokens}t @${fmt(a.promptTokPerSec)}t/s  out=${a.outputTokens}t @${fmt(a.outputTokPerSec)}t/s`);

    console.log('  → llamacpp 26B-A4B …');
    const b = await runLlamacpp(w.name, env.LLAMACPP_MODEL, w.prompt, w.maxTokens);
    results.push(b);
    if (b.error) console.log(`    ERROR: ${b.error}`);
    else console.log(`    wall=${(b.wallMs / 1000).toFixed(1)}s  prompt=${b.promptTokens}t @${fmt(b.promptTokPerSec)}t/s  out=${b.outputTokens}t @${fmt(b.outputTokPerSec)}t/s`);
  }

  console.log('\n\n=== summary ===');
  console.log('workload   provider                 wall_s  prompt_t  prompt_t/s  out_t  out_t/s');
  console.log('---------  -----------------------  ------  --------  ----------  -----  -------');
  for (const r of results) {
    const provider = r.endpoint.includes('mac.mini') ? `ollama ${r.model}` : `llamacpp ${r.model}`;
    console.log(
      `${r.workload.padEnd(9)}  ${provider.padEnd(23)}  ${(r.wallMs / 1000).toFixed(1).padStart(6)}  ${String(r.promptTokens).padStart(8)}  ${fmt(r.promptTokPerSec)}  ${String(r.outputTokens).padStart(5)}  ${fmt(r.outputTokPerSec)}` +
        (r.error ? `  [ERROR: ${r.error.slice(0, 60)}]` : ''),
    );
  }

  console.log('\n=== output samples ===');
  for (const r of results) {
    const provider = r.endpoint.includes('mac.mini') ? `ollama` : `llamacpp`;
    console.log(`\n[${r.workload} | ${provider}] ${r.preview}`);
  }
}

main().catch((err) => {
  console.error('benchmark failed:', err);
  process.exit(1);
});
