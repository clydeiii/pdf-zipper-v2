import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  charBudgetForTokens,
  SAME_LENGTH_OUTPUT_INPUT_TOKENS,
  LLM_NUM_CTX,
  ollamaStats,
} from '../dist/utils/llm-chat.js';

// Chunks are sized by ESTIMATED tokens so a CJK document (≈1 token/char)
// doesn't overflow the shared 8K context that English (≈3.6 chars/token)
// fits comfortably. Astra's review point: "10,000 characters is not a token budget."

test('English text estimates at roughly 3.6 chars per token', () => {
  const english = 'The quick brown fox jumps over the lazy dog. '.repeat(100); // 4500 chars
  const t = estimateTokens(english);
  assert.ok(t > 1000 && t < 1400, `got ${t}`);
});

test('CJK text estimates at about one token per character', () => {
  const zh = '人工智能正在改变世界，模型规模不断扩大。'.repeat(100); // 2000 chars
  const t = estimateTokens(zh);
  assert.ok(t >= 2000 && t <= 2100, `got ${t}`);
});

test('the same-length-output input budget leaves room for prompt + output inside LLM_NUM_CTX', () => {
  assert.ok(SAME_LENGTH_OUTPUT_INPUT_TOKENS * 2 + 1024 <= LLM_NUM_CTX);
});

test('charBudgetForTokens shrinks the chunk for dense scripts and leaves Latin text alone', () => {
  const english = 'word '.repeat(2000); // 10000 chars ≈ 2778 tokens → fits
  assert.equal(charBudgetForTokens(english, SAME_LENGTH_OUTPUT_INPUT_TOKENS), english.length);
  const zh = '中'.repeat(10000); // 10000 tokens → must shrink to ~3584 chars
  const budget = charBudgetForTokens(zh, SAME_LENGTH_OUTPUT_INPUT_TOKENS);
  assert.ok(budget <= SAME_LENGTH_OUTPUT_INPUT_TOKENS && budget >= 500, `got ${budget}`);
});

test('ollamaStats converts nanoseconds and carries done_reason', () => {
  const s = ollamaStats({ total_duration: 2_500_000_000, load_duration: 10_000_000, prompt_eval_count: 900, prompt_eval_duration: 400_000_000, eval_count: 120, eval_duration: 2_000_000_000, done_reason: 'length' });
  assert.equal(s.totalMs, 2500);
  assert.equal(s.loadMs, 10);
  assert.equal(s.promptTokens, 900);
  assert.equal(s.outputTokens, 120);
  assert.equal(s.doneReason, 'length');
});
