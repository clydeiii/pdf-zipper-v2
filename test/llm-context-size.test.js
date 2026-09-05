import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { LLM_NUM_CTX } from '../dist/utils/llm-chat.js';
import { AUDIO_USER_AGENTS } from '../dist/podcasts/transcriber.js';

// Every call to the shared gemma4 model must ask for the SAME context size:
// a different num_ctx makes Ollama evict and reload the 9GB model (measured
// ~100 reloads/day on mac.mini before this was unified, 2026-08-30..09-04).
// s1-normalizer talks to a different, tiny model and is exempt.

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('all gemma4 calls use LLM_NUM_CTX (no stray literal num_ctx / numCtx values)', () => {
  const srcDir = new URL('../src/', import.meta.url).pathname;
  const offenders = [];
  for (const file of walk(srcDir)) {
    if (file.endsWith('s1-normalizer.ts')) continue;
    if (file.endsWith('llm-chat.ts')) continue; // defines the constant
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\b(num_ctx|numCtx)\s*:\s*(\d+)/g)) {
      offenders.push(`${path.relative(srcDir, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `literal context sizes found; use LLM_NUM_CTX (${LLM_NUM_CTX}) instead`);
});

test('LLM_NUM_CTX is 8K — the transcript chunk size is tuned to it', () => {
  assert.equal(LLM_NUM_CTX, 8192);
});

test('podcast audio downloads present a browser UA first, then a podcast client', () => {
  assert.ok(AUDIO_USER_AGENTS.length >= 2);
  assert.match(AUDIO_USER_AGENTS[0], /^Mozilla\/5\.0/);
  assert.match(AUDIO_USER_AGENTS[1], /AppleCoreMedia|Podcasts|iTunes/);
});
