/**
 * A/B test harness — runs metadata extraction + transcript formatting
 * through every installed Ollama model, captures timing and outputs.
 *
 * Outputs:
 *   data/ablation/outputs/{model-sanitized}/{source}-metadata.json
 *   data/ablation/outputs/{model-sanitized}/{source}-transcript.txt
 *   data/ablation/outputs/{model-sanitized}/summary.json
 *
 * Idempotent: skips (model, source, task) combos whose output already exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { Ollama } from 'ollama';
import { Agent } from 'undici';
import type { PodcastMetadata } from '../src/podcasts/types.js';

const ABLATION_DIR = '/home/clyde/pdf-zipper-v2/data/ablation';
const INPUTS_DIR = path.join(ABLATION_DIR, 'inputs');
const OUTPUTS_DIR = path.join(ABLATION_DIR, 'outputs');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://mac.mini:11434';

// 20-minute timeout per call — large models can be slow
const agent = new Agent({
  headersTimeout: 20 * 60 * 1000,
  bodyTimeout: 20 * 60 * 1000,
  connectTimeout: 30 * 1000,
});

const ollama = new Ollama({
  host: OLLAMA_HOST,
  fetch: ((url: string | URL | Request, init?: RequestInit) => {
    return fetch(url, { ...init, dispatcher: agent } as RequestInit);
  }) as typeof fetch,
});

// All 8 models (gemma4:latest and gemma4:e4b share a digest — both tested for completeness)
const MODELS = [
  'gemma4:latest',
  'gemma4:e4b',
  'qwen3.5:9b',
  'gemma3:12b',
  'gpt-oss:20b',
  'qwen3:8b',
  'gemma3:4b',
  'qwen3:4b',
];

const sanitize = (m: string) => m.replace(/[:/]/g, '_');

// Some models (qwen3, gpt-oss) leak <think>...</think> blocks even with think:false
// Strip them to get the real output
function stripThinkTags(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')  // orphan closing tag (response was cut off mid-think)
    .trim();
}

// ----------------- prompt builders (copied from pipeline) -----------------

const MAX_EXTRACT_CHARS = 6000;

function buildMetadataPrompt(text: string, url: string, pageTitle?: string): string {
  const truncated = text.slice(0, MAX_EXTRACT_CHARS);
  return `You are a document metadata extraction assistant. Analyze the following article text and extract structured metadata.

Return ONLY a valid JSON object with these fields (no markdown, no explanation):
{
  "title": "the article's actual title (not the site name)",
  "author": "author name or null if not identifiable",
  "publication": "publisher or website name (e.g., 'The New York Times', 'Hacker News') or null",
  "publishDate": "YYYY-MM-DD date or null",
  "language": "ISO 639-1 code (e.g., 'en', 'fr', 'de', 'ja', 'zh')",
  "summary": "2-3 sentence summary capturing the key points",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}

Guidelines:
- For title: prefer the actual article headline, not navigation text or site name
- For author: look for bylines ("By John Smith", "Written by..."), footer credits, or author names near the title. Also check for patterns like "FirstName LastName" immediately before or after the date
- For publication: infer from the URL domain or text clues (e.g., "nytimes.com" → "The New York Times")
- For publishDate: look carefully for ANY date near the top of the text — it may appear as "January 15, 2025", "Jan 2025", "2025-01-15", "15/01/2025", or just "January 2025". Convert partial dates to the 1st of that month (e.g., "July 2024" → "2024-07-01"). Return null ONLY if there is truly no date anywhere in the text
- For tags: use 3-5 lowercase hyphenated topic tags (e.g., "machine-learning", "climate-change")
- For summary: be concise, factual, and capture the main argument or findings
- For language: detect the primary language of the body text, not headers/nav

URL: ${url}
${pageTitle ? `Page title: ${pageTitle}` : ''}

Article text:
${truncated}`;
}

function buildSpellingHints(meta?: PodcastMetadata): string {
  if (!meta) return '';
  const corrections: string[] = [];
  if (meta.episodeTitle) {
    corrections.push(`"${meta.episodeTitle}" (episode title - use this exact spelling)`);
  }
  if (meta.showNotes?.links?.length) {
    const skipWords = new Set(['The','Here','Are','Is','Now','What','How','Why','More','New','About','Over','Your','Its','Data','Users','Keys','Even','Biggest','Changes','Latest','Model','Uses','Gave','FBI','Future','Personal','Assistants','Looks','Like','Collecting']);
    for (const link of meta.showNotes.links) {
      const brandMatches = link.text.match(/[A-Z][a-z]+[A-Z][a-z]+|[A-Z]{2,}[a-z]+|[a-z]+[A-Z]/g) || [];
      for (const match of brandMatches) {
        if (!corrections.some(c => c.includes(match))) corrections.push(`"${match}"`);
      }
      const productMatches = link.text.match(/\b(TikTok|AirTag|BitLocker|ChatGPT|Grok|Grokipedia|xAI|Clawdbot)\b/gi) || [];
      for (const match of productMatches) {
        if (!corrections.some(c => c.toLowerCase().includes(match.toLowerCase()))) corrections.push(`"${match}"`);
      }
    }
    // also capture stand-alone TitleCase product-like words users expect (fuzzy catch-all)
    for (const link of meta.showNotes.links) {
      const tokens = link.text.split(/\s+/);
      for (const tok of tokens) {
        if (/^[A-Z][a-z]{2,}$/.test(tok) && !skipWords.has(tok) && !corrections.some(c => c.includes(tok))) {
          // heuristic only — don't go wild
        }
      }
    }
  }
  return corrections.join(', ');
}

function buildTranscriptPrompt(text: string, meta?: PodcastMetadata): string {
  const spellingHints = buildSpellingHints(meta);
  return `Reformat this podcast transcript into clean, readable prose.

INPUT CONTEXT:
- This is a podcast transcript (may be conversational or a narrated blog post)
- It may contain ASR artifacts from speech-to-text: "Subtitle", "Heading", "Subheading" are structural markers spoken aloud — remove them
- Image/figure descriptions ("There's an image here...") should be condensed to just the figure number and caption
${spellingHints ? `- Proper nouns to correct: ${spellingHints}` : ''}

RULES:
1. CRITICAL: Insert a paragraph break (blank line) every 4-5 sentences. Never let prose run longer than 5 sentences without a break. Prefer breaks at topic shifts, but if none occurs within 5 sentences, break anyway. Output MUST have visible paragraph structure — walls of text are unacceptable.
2. Remove TTS artifacts: "Subtitle", "Heading", "Subheading", "There's a heading here"
3. For figure references, keep only: [Figure N: caption text]
4. Remove verbal filler: "um", "uh", "you know", "I mean", "sort of", "kind of" (as filler)
5. Fix punctuation and capitalization where ASR got it wrong
6. Preserve ALL substantive content — do not summarize or skip anything
7. Output plain text only. No markdown formatting, no headers, no commentary.

Return ONLY the cleaned transcript:

${text}`;
}

// ----------------- task runners -----------------

interface TaskResult {
  model: string;
  source: string;
  task: 'metadata' | 'transcript';
  elapsedMs: number;
  inputChars: number;
  outputChars: number;
  error?: string;
  parsedMetadata?: unknown;
  rawOutputFile: string;
}

async function runMetadata(
  model: string,
  source: string,
  text: string,
  url: string,
  pageTitle: string,
  outDir: string
): Promise<TaskResult> {
  const prompt = buildMetadataPrompt(text, url, pageTitle);
  const rawFile = path.join(outDir, `${source}-metadata.raw.txt`);
  const parsedFile = path.join(outDir, `${source}-metadata.json`);

  if (fs.existsSync(parsedFile) && fs.existsSync(rawFile)) {
    const prev = JSON.parse(fs.readFileSync(parsedFile, 'utf8'));
    return {
      model, source, task: 'metadata',
      elapsedMs: prev._elapsedMs ?? 0,
      inputChars: text.length,
      outputChars: fs.readFileSync(rawFile, 'utf8').length,
      parsedMetadata: prev,
      rawOutputFile: rawFile,
    };
  }

  const t0 = Date.now();
  try {
    const res = await ollama.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      think: false,
      options: { temperature: 0.2, num_ctx: 8192 },
    });
    const elapsedMs = Date.now() - t0;
    const content = stripThinkTags(res.message.content);
    await writeFile(rawFile, content);

    // try to parse JSON
    let parsed: Record<string, unknown> = { _rawOnly: true };
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { parsed = { _parseError: true, _raw: m[0] }; }
    }
    (parsed as any)._elapsedMs = elapsedMs;
    await writeFile(parsedFile, JSON.stringify(parsed, null, 2));

    return {
      model, source, task: 'metadata', elapsedMs,
      inputChars: text.length, outputChars: content.length,
      parsedMetadata: parsed, rawOutputFile: rawFile,
    };
  } catch (e) {
    return {
      model, source, task: 'metadata',
      elapsedMs: Date.now() - t0,
      inputChars: text.length, outputChars: 0,
      error: e instanceof Error ? e.message : String(e),
      rawOutputFile: rawFile,
    };
  }
}

async function runTranscript(
  model: string,
  source: string,
  fullText: string,
  meta: PodcastMetadata | undefined,
  outDir: string,
  maxInputChars?: number
): Promise<TaskResult> {
  // For super-long inputs (marc=101K) we only process first chunk to keep ablation tractable
  // Finalist model(s) can re-run the whole thing afterward.
  const text = maxInputChars ? fullText.slice(0, maxInputChars) : fullText;
  // Chunking at 15k chars like the pipeline
  const maxChunk = 15000;
  const outFile = path.join(outDir, `${source}-transcript.txt`);
  const metaFile = path.join(outDir, `${source}-transcript.meta.json`);

  if (fs.existsSync(outFile) && fs.existsSync(metaFile)) {
    const prev = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return {
      model, source, task: 'transcript',
      elapsedMs: prev.elapsedMs ?? 0,
      inputChars: text.length,
      outputChars: fs.statSync(outFile).size,
      rawOutputFile: outFile,
    };
  }

  const chunks: string[] = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= maxChunk) { chunks.push(rem); break; }
    let splitAt = rem.lastIndexOf('\n\n', maxChunk);
    if (splitAt === -1 || splitAt < maxChunk * 0.5) splitAt = rem.lastIndexOf('. ', maxChunk);
    if (splitAt === -1 || splitAt < maxChunk * 0.5) splitAt = maxChunk;
    chunks.push(rem.substring(0, splitAt + 1));
    rem = rem.substring(splitAt + 1).trim();
  }

  const t0 = Date.now();
  try {
    const outputs: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const prompt = buildTranscriptPrompt(chunks[i], meta);
      const res = await ollama.chat({
        model,
        messages: [{ role: 'user', content: prompt }],
        think: false,
        options: { temperature: 0.3, num_predict: -1, num_ctx: 32768 },
      });
      outputs.push(stripThinkTags(res.message.content));
    }
    const elapsedMs = Date.now() - t0;
    const joined = outputs.join('\n\n');
    await writeFile(outFile, joined);
    await writeFile(metaFile, JSON.stringify({
      elapsedMs, chunkCount: chunks.length, chunkSizes: chunks.map(c => c.length),
      inputChars: text.length, outputChars: joined.length,
    }, null, 2));
    return {
      model, source, task: 'transcript', elapsedMs,
      inputChars: text.length, outputChars: joined.length,
      rawOutputFile: outFile,
    };
  } catch (e) {
    return {
      model, source, task: 'transcript',
      elapsedMs: Date.now() - t0,
      inputChars: text.length, outputChars: 0,
      error: e instanceof Error ? e.message : String(e),
      rawOutputFile: outFile,
    };
  }
}

// ----------------- main -----------------

async function main() {
  await mkdir(OUTPUTS_DIR, { recursive: true });

  // Load inputs
  const podcastMeta: PodcastMetadata = JSON.parse(
    fs.readFileSync(path.join(INPUTS_DIR, 'podcast-metadata.json'), 'utf8')
  );
  const podcastTranscript = fs.readFileSync(path.join(INPUTS_DIR, 'podcast.transcript.txt'), 'utf8');
  const videoTranscript = fs.readFileSync(path.join(INPUTS_DIR, 'video.transcript.txt'), 'utf8');
  const marcTranscript = fs.readFileSync(path.join(INPUTS_DIR, 'marc.transcript.txt'), 'utf8');

  console.log(`podcast: ${podcastMeta.episodeTitle} (${podcastTranscript.length} chars)`);
  console.log(`video: (${videoTranscript.length} chars)`);
  console.log(`marc: (${marcTranscript.length} chars)`);

  // Synthetic "PodcastMetadata" for marc — uses only the episode title as a hint
  const marcMeta: PodcastMetadata = {
    podcastName: 'Latent Space Packets',
    podcastAuthor: '',
    genre: '',
    artworkUrl: '',
    feedUrl: '',
    episodeTitle: 'Marc Andreessen introspects on Death of the Browser, Pi + OpenClaw, and Why "This Time Is Different"',
    episodeUrl: 'https://youtube.com/watch?v=knx2wrILP1M',
    audioUrl: '',
    audioExtension: 'mp4',
    duration: 0,
    publishedAt: '2026-04-04',
    description: '',
    shortDescription: '',
    episodeGuid: '',
    showNotes: {
      summary: '',
      links: [
        { text: 'OpenClaw (Anthropic)', url: 'https://anthropic.com' },
        { text: 'Pi by Inflection AI', url: 'https://pi.ai' },
        { text: 'AlexNet (2013)', url: '' },
        { text: 'A16Z', url: 'https://a16z.com' },
        { text: 'ChatGPT', url: '' },
        { text: 'GPT-4, o1', url: '' },
      ],
    },
  } as PodcastMetadata;

  const PODCAST_URL = 'https://podcasts.apple.com/us/podcast/80-000-hours-podcast/id1245002988?i=1000759061525';
  const VIDEO_URL = 'local://stop-using-claude-code-in-terminal-its-holding-you-back.mp4';
  const VIDEO_TITLE = 'Stop using Claude Code in terminal — it\'s holding you back';

  const allResults: TaskResult[] = [];

  for (const model of MODELS) {
    const outDir = path.join(OUTPUTS_DIR, sanitize(model));
    await mkdir(outDir, { recursive: true });

    console.log(`\n========== ${model} ==========`);

    // Task 1: metadata on podcast transcript
    console.log(`[${model}] metadata on podcast transcript...`);
    const r1 = await runMetadata(
      model, 'podcast',
      podcastTranscript, PODCAST_URL, podcastMeta.episodeTitle, outDir
    );
    console.log(`  ${r1.error ? 'ERROR: ' + r1.error : `${(r1.elapsedMs/1000).toFixed(1)}s, ${r1.outputChars} chars`}`);
    allResults.push(r1);

    // Task 2: metadata on video transcript
    console.log(`[${model}] metadata on video transcript...`);
    const r2 = await runMetadata(
      model, 'video',
      videoTranscript, VIDEO_URL, VIDEO_TITLE, outDir
    );
    console.log(`  ${r2.error ? 'ERROR: ' + r2.error : `${(r2.elapsedMs/1000).toFixed(1)}s, ${r2.outputChars} chars`}`);
    allResults.push(r2);

    // Task 3: transcript formatting on podcast
    console.log(`[${model}] formatting podcast transcript...`);
    const r3 = await runTranscript(model, 'podcast', podcastTranscript, podcastMeta, outDir);
    console.log(`  ${r3.error ? 'ERROR: ' + r3.error : `${(r3.elapsedMs/1000).toFixed(1)}s, ${r3.outputChars} chars`}`);
    allResults.push(r3);

    // Task 4: transcript formatting on video
    console.log(`[${model}] formatting video transcript...`);
    const r4 = await runTranscript(model, 'video', videoTranscript, undefined, outDir);
    console.log(`  ${r4.error ? 'ERROR: ' + r4.error : `${(r4.elapsedMs/1000).toFixed(1)}s, ${r4.outputChars} chars`}`);
    allResults.push(r4);

    // Task 5: metadata on marc transcript
    console.log(`[${model}] metadata on marc transcript...`);
    const r5 = await runMetadata(
      model, 'marc',
      marcTranscript, 'https://youtube.com/watch?v=knx2wrILP1M', marcMeta.episodeTitle, outDir
    );
    console.log(`  ${r5.error ? 'ERROR: ' + r5.error : `${(r5.elapsedMs/1000).toFixed(1)}s, ${r5.outputChars} chars`}`);
    allResults.push(r5);

    // Task 6: transcript formatting on marc (first 15K only — 1 chunk sample for ablation speed)
    console.log(`[${model}] formatting marc transcript (first 15K chars, 1 chunk)...`);
    const r6 = await runTranscript(model, 'marc', marcTranscript, marcMeta, outDir, 15000);
    console.log(`  ${r6.error ? 'ERROR: ' + r6.error : `${(r6.elapsedMs/1000).toFixed(1)}s, ${r6.outputChars} chars`}`);
    allResults.push(r6);

    // Write per-model summary
    await writeFile(
      path.join(outDir, 'summary.json'),
      JSON.stringify(allResults.filter(r => r.model === model), null, 2)
    );
  }

  // Global summary
  await writeFile(
    path.join(OUTPUTS_DIR, 'all-results.json'),
    JSON.stringify(allResults, null, 2)
  );

  console.log('\n========== ALL DONE ==========');
  for (const r of allResults) {
    const status = r.error ? `ERROR` : `${(r.elapsedMs/1000).toFixed(1)}s`;
    console.log(`  ${r.model.padEnd(16)} ${r.source.padEnd(8)} ${r.task.padEnd(11)} ${status}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
