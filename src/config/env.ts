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
  /** Ollama model for vision analysis (default: gemma4:e4b) */
  OLLAMA_MODEL: string;
  /** Quality score threshold 0-100 (default: 50) */
  QUALITY_THRESHOLD: number;
  /** Conversion worker concurrency (default: 1) */
  CONCURRENCY: number;
  /** Playwright navigation timeout in ms (default: 60000) */
  NAV_TIMEOUT_MS: number;
  /** Playwright PDF generation timeout in ms (default: 90000) */
  PDF_TIMEOUT_MS: number;
  /** Direct PDF download timeout in ms (default: 120000) */
  DIRECT_DOWNLOAD_TIMEOUT_MS: number;
  /** Maximum direct PDF download size in bytes (default: 100MB) */
  MAX_DIRECT_PDF_BYTES: number;
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
  /**
   * Optional separate cookies file for yt-dlp Google auth (age-gated /
   * member-only videos). Kept distinct from COOKIES_FILE because the shared
   * cookies (personal Google account) triggered YouTube bot-detection — using
   * a dedicated work-account file is cleaner. Only consulted as a fallback
   * after an anonymous metadata fetch fails.
   */
  YT_DLP_COOKIES_FILE?: string;
  /** Discord webhook URL for job notifications (optional) */
  DISCORD_WEBHOOK_URL?: string;
  /** Whisper ASR server URL for podcast transcription (default: http://10.0.0.81:9002) */
  WHISPER_HOST: string;
  /**
   * Optional fallback ASR endpoint. Pre-flight `/health` check picks whichever
   * is up. Same API shape required (whisper-asr-webservice compat).
   * Example: ubuntu-m1pro (ONNX Parakeet) backing up mac.mini (MLX Parakeet).
   */
  WHISPER_HOST_FALLBACK?: string;
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
  /** Path to Codex CLI (default: 'codex' in PATH) */
  CODEX_CLI_PATH: string;
  /** Optional explicit args for Codex CLI (space-delimited) */
  CODEX_CLI_ARGS?: string;
  /** Optional API token for mutating routes */
  API_AUTH_TOKEN?: string;
  /** Default JSON body parser limit for API routes */
  JSON_BODY_LIMIT: string;
  /** JSON body parser limit for cookie uploads */
  COOKIES_BODY_LIMIT: string;
  /** JSON body parser limit for manual PDF capture uploads */
  MANUAL_CAPTURE_BODY_LIMIT: string;
  /** Fix provider timeout in minutes (default: 30) */
  FIX_PROVIDER_TIMEOUT_MINUTES: number;
  /** Podcast audio download timeout in ms (default: 600000) */
  PODCAST_DOWNLOAD_TIMEOUT_MS: number;
  /** Generic media download timeout in ms (default: 300000) */
  MEDIA_DOWNLOAD_TIMEOUT_MS: number;
  /** Maximum podcast audio download size in bytes (default: 750MB) */
  MAX_PODCAST_AUDIO_BYTES: number;
  /** Maximum video size to transcribe in MB (default: 500) */
  MAX_VIDEO_TRANSCRIBE_MB: number;
  /** Optional llama.cpp OpenAI-compatible server for round-robin/failover on text-only LLM calls */
  LLAMACPP_HOST?: string;
  /** Bearer token for the llama.cpp server */
  LLAMACPP_API_KEY?: string;
  /** Model name to send to llama.cpp (default: gemma4) */
  LLAMACPP_MODEL: string;
}

const requiredEnvVars = ['REDIS_HOST', 'REDIS_PORT', 'PORT'] as const;

function parseIntegerEnv(
  name: string,
  fallback?: number,
  options: { min?: number; max?: number } = {}
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required env var: ${name}`);
    }
    return fallback;
  }

  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid env var ${name}: expected integer, got "${raw}"`);
  }

  const value = parseInt(raw, 10);
  if (options.min !== undefined && value < options.min) {
    throw new Error(`Invalid env var ${name}: expected >= ${options.min}, got ${value}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`Invalid env var ${name}: expected <= ${options.max}, got ${value}`);
  }
  return value;
}

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
  REDIS_PORT: parseIntegerEnv('REDIS_PORT', undefined, { min: 1, max: 65535 }),
  PORT: parseIntegerEnv('PORT', undefined, { min: 1, max: 65535 }),
  NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
  // Ollama settings (optional with sensible defaults)
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'gemma4:e4b',
  QUALITY_THRESHOLD: parseIntegerEnv('QUALITY_THRESHOLD', 50, { min: 0, max: 100 }),
  CONCURRENCY: parseIntegerEnv('CONCURRENCY', 1, { min: 1, max: 8 }),
  NAV_TIMEOUT_MS: parseIntegerEnv('NAV_TIMEOUT_MS', 60000, { min: 1000 }),
  PDF_TIMEOUT_MS: parseIntegerEnv('PDF_TIMEOUT_MS', 90000, { min: 1000 }),
  DIRECT_DOWNLOAD_TIMEOUT_MS: parseIntegerEnv('DIRECT_DOWNLOAD_TIMEOUT_MS', 120000, { min: 1000 }),
  MAX_DIRECT_PDF_BYTES: parseIntegerEnv('MAX_DIRECT_PDF_MB', 100, { min: 1 }) * 1024 * 1024,
  // Feed settings (optional)
  MATTER_FEED_URL: process.env.MATTER_FEED_URL,
  KARAKEEP_FEED_URL: process.env.KARAKEEP_FEED_URL,
  FEED_POLL_INTERVAL_MINUTES: parseIntegerEnv('FEED_POLL_INTERVAL_MINUTES', 15, { min: 1 }),
  // Media storage settings (optional)
  DATA_DIR: process.env.DATA_DIR || './data',
  // Cookies file for authentication (defaults to DATA_DIR/cookies.txt)
  COOKIES_FILE: process.env.COOKIES_FILE || `${process.env.DATA_DIR || './data'}/cookies.txt`,
  YT_DLP_COOKIES_FILE: process.env.YT_DLP_COOKIES_FILE,
  // Discord webhook for job notifications (optional)
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  // Whisper ASR server for podcast transcription
  WHISPER_HOST: process.env.WHISPER_HOST || 'http://10.0.0.81:9002',
  WHISPER_HOST_FALLBACK: process.env.WHISPER_HOST_FALLBACK,
  // Nitter server for Twitter/X conversion
  NITTER_HOST: process.env.NITTER_HOST || 'http://localhost:8080',
  // Ollama model for transcript formatting (larger = better quality, slower)
  TRANSCRIPT_FORMAT_MODEL: process.env.TRANSCRIPT_FORMAT_MODEL || process.env.OLLAMA_MODEL || 'gemma4:latest',
  // Privacy filter terms (comma-separated list of names/handles to hide from captures)
  PRIVACY_FILTER_TERMS: process.env.PRIVACY_FILTER_TERMS,
  // AI self-healing fix feature
  FIX_ENABLED: process.env.FIX_ENABLED === 'true',
  CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH || 'claude',
  CODEX_CLI_PATH: process.env.CODEX_CLI_PATH || 'codex',
  CODEX_CLI_ARGS: process.env.CODEX_CLI_ARGS,
  API_AUTH_TOKEN: process.env.API_AUTH_TOKEN,
  JSON_BODY_LIMIT: process.env.JSON_BODY_LIMIT || '1mb',
  COOKIES_BODY_LIMIT: process.env.COOKIES_BODY_LIMIT || '5mb',
  MANUAL_CAPTURE_BODY_LIMIT: process.env.MANUAL_CAPTURE_BODY_LIMIT || '50mb',
  FIX_PROVIDER_TIMEOUT_MINUTES: parseIntegerEnv('FIX_PROVIDER_TIMEOUT_MINUTES', 30, { min: 1 }),
  PODCAST_DOWNLOAD_TIMEOUT_MS: parseIntegerEnv('PODCAST_DOWNLOAD_TIMEOUT_MS', 600000, { min: 1000 }),
  MEDIA_DOWNLOAD_TIMEOUT_MS: parseIntegerEnv('MEDIA_DOWNLOAD_TIMEOUT_MS', 300000, { min: 1000 }),
  MAX_PODCAST_AUDIO_BYTES: parseIntegerEnv('MAX_PODCAST_AUDIO_MB', 750, { min: 1 }) * 1024 * 1024,
  MAX_VIDEO_TRANSCRIBE_MB: parseIntegerEnv('MAX_VIDEO_TRANSCRIBE_MB', 500, { min: 1 }),
  // Optional llama.cpp failover/round-robin endpoint for text-only LLM calls
  LLAMACPP_HOST: process.env.LLAMACPP_HOST,
  LLAMACPP_API_KEY: process.env.LLAMACPP_API_KEY,
  LLAMACPP_MODEL: process.env.LLAMACPP_MODEL || 'gemma4',
};
