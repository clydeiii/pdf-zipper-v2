/**
 * Quality verification types for PDF assessment
 * Uses discriminated union pattern for type-safe result handling
 */

/**
 * Types of quality issues detected in PDF conversion
 */
export type QualityIssue =
  | 'blank_page'
  | 'paywall'
  | 'truncated'
  | 'low_contrast'
  | 'missing_content'
  | 'bot_detected'
  | 'unknown';

/**
 * Quality score from vision model analysis
 */
export interface QualityScore {
  /** Quality score from 0-100 */
  score: number;
  /** Detected issue type (if any) */
  issue?: QualityIssue;
  /** Model's reasoning for the score */
  reasoning: string;
}

/**
 * Successful quality check result (passed threshold)
 */
export interface QualityPassResult {
  passed: true;
  score: QualityScore;
}

/**
 * Failed quality check result (below threshold or issue detected)
 */
export interface QualityFailResult {
  passed: false;
  score: QualityScore;
  issue: QualityIssue;
}

/**
 * Quality check result (discriminated union)
 * Use `result.passed` to narrow type
 */
export type QualityResult = QualityPassResult | QualityFailResult;

/**
 * Health check result for Ollama connection
 */
export interface OllamaHealthResult {
  healthy: boolean;
  models?: string[];
  error?: string;
}
