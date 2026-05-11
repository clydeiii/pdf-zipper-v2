/**
 * Manual smoke test for the round-robin chatText helper.
 *
 * Run with:
 *   npx tsx --env-file=.env scripts/smoke-llm-chat.ts
 *
 * Calls chatText() three times in sequence so the round-robin counter rotates
 * across both providers. Each call should log either `provider: "ollama"` or
 * `provider: "llamacpp"` with a successful elapsedMs.
 */
import { chatText } from '../src/utils/llm-chat.js';
import { env } from '../src/config/env.js';

async function main(): Promise<void> {
  console.log('LLAMACPP_HOST=', env.LLAMACPP_HOST || '(unset)');
  console.log('OLLAMA_HOST=', env.OLLAMA_HOST);
  console.log('OLLAMA_MODEL=', env.OLLAMA_MODEL);

  for (let i = 0; i < 3; i++) {
    const result = await chatText({
      model: env.OLLAMA_MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly the single word: pong' }],
      temperature: 0,
      numPredict: 16,
    });
    console.log(`call ${i + 1} response:`, JSON.stringify(result.trim().slice(0, 80)));
  }
}

main().catch((err) => {
  console.error('smoke test failed:', err);
  process.exit(1);
});
