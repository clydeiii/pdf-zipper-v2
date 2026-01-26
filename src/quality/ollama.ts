/**
 * Ollama client wrapper for vision model analysis
 * Provides health check and image analysis functions
 */

import { Ollama } from 'ollama';
import { env } from '../config/env.js';
import type { OllamaHealthResult } from './types.js';

/**
 * Singleton Ollama client instance
 * Configured with OLLAMA_HOST from environment
 */
export const ollama = new Ollama({
  host: env.OLLAMA_HOST,
});

/**
 * Check Ollama server health and model availability
 * Used for fail-fast validation before starting worker
 * @returns Health check result with available models or error
 */
export async function checkOllamaHealth(): Promise<OllamaHealthResult> {
  try {
    const response = await ollama.list();
    const models = response.models.map((m) => m.name);

    // Check if configured model is available
    const modelAvailable = models.some((name) =>
      name.toLowerCase().includes(env.OLLAMA_MODEL.toLowerCase())
    );

    if (!modelAvailable) {
      return {
        healthy: false,
        models,
        error: `Model '${env.OLLAMA_MODEL}' not found. Available: ${models.join(', ') || 'none'}`,
      };
    }

    return {
      healthy: true,
      models,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      healthy: false,
      error: `Failed to connect to Ollama at ${env.OLLAMA_HOST}: ${message}`,
    };
  }
}

/**
 * Analyze an image using Ollama vision model
 * @param imageBase64 - Base64 encoded image data
 * @param prompt - Analysis prompt for the vision model
 * @returns Raw response content string (caller handles parsing)
 */
export async function analyzeImageWithOllama(
  imageBase64: string,
  prompt: string
): Promise<string> {
  const response = await ollama.chat({
    model: env.OLLAMA_MODEL,
    messages: [
      {
        role: 'user',
        content: prompt,
        images: [imageBase64],
      },
    ],
  });

  return response.message.content;
}
