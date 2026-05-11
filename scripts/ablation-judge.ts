/**
 * Analyze ablation outputs — numeric scores + qualitative summary
 * Produces data/ablation/JUDGMENT.md
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT = '/home/clyde/pdf-zipper-v2/data/ablation/outputs';
const REPORT = '/home/clyde/pdf-zipper-v2/data/ablation/JUDGMENT.md';

const MODELS = ['gemma4:latest','gemma4:e4b','qwen3.5:9b','gemma3:12b','gpt-oss:20b','qwen3:8b','gemma3:4b','qwen3:4b'];
const sanitize = (m: string) => m.replace(/[:/]/g, '_');

// Ground-truth proper nouns that should appear in each transcript
const GROUND_TRUTH = {
  marc: {
    mustHave: ['OpenClaw', 'A16Z', 'Alessio', 'AlexNet', 'ChatGPT', 'Andreessen', 'AI dungeon'],
    badForms: ['open claw', 'A 16 Z', 'chat GPT', 'chat-GPT', 'Alex Net', 'AI Dungeon'],
    title: 'Marc Andreessen introspects on Death of the Browser, Pi + OpenClaw',
  },
  video: {
    mustHave: ['Claude', 'Claude Code', 'terminal', 'agent'],
    badForms: [],
    title: "Stop Using Claude Code in Terminal",
  },
  podcast: {
    mustHave: ['Anthropic', 'Meta'],
    badForms: [],
    title: "Is there a case against Anthropic",
  },
};

interface Row {
  model: string;
  podcastMetaMs: number; podcastMetaOK: boolean; podcastMetaSummary: string;
  videoMetaMs: number; videoMetaOK: boolean; videoMetaSummary: string;
  marcMetaMs: number; marcMetaOK: boolean; marcMetaSummary: string;
  podcastTxMs: number; podcastTxBreaks: number; podcastTxOut: number;
  videoTxMs: number; videoTxBreaks: number; videoTxOut: number;
  marcTxMs: number; marcTxBreaks: number; marcTxOut: number;
  marcOpenClaw: boolean;  // did it use "OpenClaw" correctly?
  marcA16Z: boolean;
  error?: string;
}

function countParaBreaks(text: string): number {
  return (text.match(/\n\n/g) || []).length;
}

function checkPhrase(text: string, phrase: string): boolean {
  return text.includes(phrase);
}

function loadJson(p: string): any | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadText(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

const rows: Row[] = [];

for (const model of MODELS) {
  const dir = path.join(OUT, sanitize(model));
  if (!fs.existsSync(dir)) {
    console.log(`[skip] no outputs for ${model}`);
    continue;
  }

  const pMeta = loadJson(path.join(dir, 'podcast-metadata.json'));
  const vMeta = loadJson(path.join(dir, 'video-metadata.json'));
  const mMeta = loadJson(path.join(dir, 'marc-metadata.json'));

  const pTx = loadText(path.join(dir, 'podcast-transcript.txt')) || '';
  const vTx = loadText(path.join(dir, 'video-transcript.txt')) || '';
  const mTx = loadText(path.join(dir, 'marc-transcript.txt')) || '';

  const pTxMeta = loadJson(path.join(dir, 'podcast-transcript.meta.json')) || {};
  const vTxMeta = loadJson(path.join(dir, 'video-transcript.meta.json')) || {};
  const mTxMeta = loadJson(path.join(dir, 'marc-transcript.meta.json')) || {};

  rows.push({
    model,
    podcastMetaMs: pMeta?._elapsedMs ?? 0,
    podcastMetaOK: !!(pMeta && pMeta.title && !pMeta._parseError && !pMeta._rawOnly),
    podcastMetaSummary: pMeta?.summary?.slice(0,80) ?? '',
    videoMetaMs: vMeta?._elapsedMs ?? 0,
    videoMetaOK: !!(vMeta && vMeta.title && !vMeta._parseError && !vMeta._rawOnly),
    videoMetaSummary: vMeta?.summary?.slice(0,80) ?? '',
    marcMetaMs: mMeta?._elapsedMs ?? 0,
    marcMetaOK: !!(mMeta && mMeta.title && !mMeta._parseError && !mMeta._rawOnly),
    marcMetaSummary: mMeta?.summary?.slice(0,80) ?? '',
    podcastTxMs: pTxMeta.elapsedMs ?? 0,
    podcastTxBreaks: countParaBreaks(pTx),
    podcastTxOut: pTx.length,
    videoTxMs: vTxMeta.elapsedMs ?? 0,
    videoTxBreaks: countParaBreaks(vTx),
    videoTxOut: vTx.length,
    marcTxMs: mTxMeta.elapsedMs ?? 0,
    marcTxBreaks: countParaBreaks(mTx),
    marcTxOut: mTx.length,
    marcOpenClaw: checkPhrase(mTx, 'OpenClaw'),
    marcA16Z: checkPhrase(mTx, 'A16Z') || checkPhrase(mTx, 'a16z') || checkPhrase(mTx, 'A 16 Z') === false,
  });
}

// Render markdown
let md = '# Ablation Test Results\n\n';
md += `Generated: ${new Date().toISOString()}\n\n`;
md += '## Timing (seconds)\n\n';
md += '| Model | PodMeta | VidMeta | MarcMeta | PodTx | VidTx | MarcTx(15K) | Total |\n';
md += '|-------|--------:|--------:|---------:|------:|------:|------------:|------:|\n';
for (const r of rows) {
  const total = (r.podcastMetaMs + r.videoMetaMs + r.marcMetaMs + r.podcastTxMs + r.videoTxMs + r.marcTxMs) / 1000;
  md += `| \`${r.model}\` | ${(r.podcastMetaMs/1000).toFixed(1)} | ${(r.videoMetaMs/1000).toFixed(1)} | ${(r.marcMetaMs/1000).toFixed(1)} | ${(r.podcastTxMs/1000).toFixed(1)} | ${(r.videoTxMs/1000).toFixed(1)} | ${(r.marcTxMs/1000).toFixed(1)} | **${total.toFixed(1)}** |\n`;
}

md += '\n## Metadata JSON validity\n\n';
md += '| Model | Podcast | Video | Marc |\n|---|---|---|---|\n';
for (const r of rows) {
  md += `| \`${r.model}\` | ${r.podcastMetaOK ? '✓':'✗'} | ${r.videoMetaOK ? '✓':'✗'} | ${r.marcMetaOK ? '✓':'✗'} |\n`;
}

md += '\n## Transcript formatting (paragraph breaks)\n\n';
md += '| Model | PodBreaks | VidBreaks | MarcBreaks | Marc OpenClaw? |\n|---|---:|---:|---:|:---:|\n';
for (const r of rows) {
  md += `| \`${r.model}\` | ${r.podcastTxBreaks} | ${r.videoTxBreaks} | ${r.marcTxBreaks} | ${r.marcOpenClaw ? '✓':'✗'} |\n`;
}

md += '\n## Metadata summaries (first 80 chars)\n\n';
for (const r of rows) {
  md += `### \`${r.model}\`\n`;
  md += `- **podcast**: ${r.podcastMetaSummary || '(none)'}\n`;
  md += `- **video**: ${r.videoMetaSummary || '(none)'}\n`;
  md += `- **marc**: ${r.marcMetaSummary || '(none)'}\n\n`;
}

fs.writeFileSync(REPORT, md);
console.log(`Written: ${REPORT}`);
console.log('\n' + md);
