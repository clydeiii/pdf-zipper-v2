/**
 * Environment configuration with validation
 * Fail-fast pattern: validates all required env vars at module load time
 */

interface EnvConfig {
  REDIS_HOST: string;
  REDIS_PORT: number;
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  /** Ollama server URL (default: http://127.0.0.1:11434) */
  OLLAMA_HOST: string;
  /** Ollama model for vision analysis (default: gemma3) */
  OLLAMA_MODEL: string;
  /** Quality score threshold 0-100 (default: 50) */
  QUALITY_THRESHOLD: number;
  /** Matter RSS feed URL (optional) */
  MATTER_FEED_URL?: string;
  /** Karakeep RSS feed URL (optional) */
  KARAKEEP_FEED_URL?: string;
  /** Feed poll interval in minutes (default: 15) */
  FEED_POLL_INTERVAL_MINUTES: number;
  /** Data directory for media storage (default: ./data) */
  DATA_DIR: string;
  /** Path to Netscape cookies.txt file for authentication (default: DATA_DIR/cookies.txt) */
  COOKIES_FILE: string;
  /** Discord webhook URL for job notifications (optional) */
  DISCORD_WEBHOOK_URL?: string;
  /** Whisper ASR server URL for podcast transcription (default: http://10.0.0.81:9002) */
  WHISPER_HOST: string;
  /** Nitter server URL for Twitter/X conversion (default: http://localhost:8080) */
  NITTER_HOST: string;
  /** Ollama model for transcript formatting - use larger model for better results (default: same as OLLAMA_MODEL) */
  TRANSCRIPT_FORMAT_MODEL: string;
  /** Comma-separated list of terms to filter from PDF captures for privacy (optional) */
  PRIVACY_FILTER_TERMS?: string;
  /** Enable AI self-healing fix feature (requires Claude CLI) */
  FIX_ENABLED: boolean;
  /** Path to Claude CLI (default: 'claude' in PATH) */
  CLAUDE_CLI_PATH: string;
}

const requiredEnvVars = ['REDIS_HOST', 'REDIS_PORT', 'PORT'] as const;

/**
 * Validates that all required environment variables are set
 * Throws immediately on missing vars to fail fast
 */
export function validateEnv(): void {
  const missing: string[] = [];

  for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env var${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  }
}

// Validate on module load (fail-fast pattern)
validateEnv();

/**
 * Typed environment configuration
 * Safe to access after validateEnv() has run
 */
export const env: EnvConfig = {
  REDIS_HOST: process.env.REDIS_HOST!,
  REDIS_PORT: parseInt(process.env.REDIS_PORT!, 10),
  PORT: parseInt(process.env.PORT!, 10),
  NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
  // Ollama settings (optional with sensible defaults)
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'gemma3',
  QUALITY_THRESHOLD: parseInt(process.env.QUALITY_THRESHOLD || '50', 10),
  // Feed settings (optional)
  MATTER_FEED_URL: process.env.MATTER_FEED_URL,
  KARAKEEP_FEED_URL: process.env.KARAKEEP_FEED_URL,
  FEED_POLL_INTERVAL_MINUTES: parseInt(process.env.FEED_POLL_INTERVAL_MINUTES || '15', 10),
  // Media storage settings (optional)
  DATA_DIR: process.env.DATA_DIR || './data',
  // Cookies file for authentication (defaults to DATA_DIR/cookies.txt)
  COOKIES_FILE: process.env.COOKIES_FILE || `${process.env.DATA_DIR || './data'}/cookies.txt`,
  // Discord webhook for job notifications (optional)
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  // Whisper ASR server for podcast transcription
  WHISPER_HOST: process.env.WHISPER_HOST || 'http://10.0.0.81:9002',
  // Nitter server for Twitter/X conversion
  NITTER_HOST: process.env.NITTER_HOST || 'http://localhost:8080',
  // Ollama model for transcript formatting (larger = better quality, slower)
  TRANSCRIPT_FORMAT_MODEL: process.env.TRANSCRIPT_FORMAT_MODEL || process.env.OLLAMA_MODEL || 'gemma3',
  // Privacy filter terms (comma-separated list of names/handles to hide from captures)
  PRIVACY_FILTER_TERMS: process.env.PRIVACY_FILTER_TERMS,
  // AI self-healing fix feature
  FIX_ENABLED: process.env.FIX_ENABLED === 'true',
  CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH || 'claude',
};
