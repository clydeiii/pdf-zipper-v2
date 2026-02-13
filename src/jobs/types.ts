/**
 * Job type definitions for the URL conversion queue
 *
 * These types define the contract between:
 * - API endpoints that enqueue jobs
 * - Workers that process jobs
 * - Status endpoints that report job state
 */

import type { QualityIssue } from '../quality/types.js';

/**
 * Job input data (what gets queued)
 * Passed when calling conversionQueue.add()
 */
export interface ConversionJobData {
  /** URL to convert to PDF (canonical/normalized for deduplication) */
  url: string;
  /** Original URL as provided (preserves www, for archive.is links) */
  originalUrl?: string;
  /** Optional user identifier for tracking */
  userId?: string;
  /** Optional priority (lower = higher priority in BullMQ) */
  priority?: number;
  /** Title for filename generation */
  title?: string;
  /** ISO timestamp when bookmarked (for weekly bin organization) */
  bookmarkedAt?: string;
  /** Absolute path to old PDF (set by rerun endpoints). Worker deletes if new filename differs. */
  oldFilePath?: string;
}

/**
 * Job result (returned on completion)
 * Available via job.returnvalue after job completes
 */
export interface ConversionJobResult {
  /** Path to generated PDF file (if saved to disk) */
  pdfPath?: string;
  /** Size of PDF in bytes */
  pdfSize?: number;
  /** ISO timestamp of completion */
  completedAt: string;
  /** Original URL */
  url: string;
  /** If failed, the reason */
  failureReason?: 'timeout' | 'navigation_error' | 'bot_detected' | 'quality_failed' | 'unknown';
  /** If failed, the error message */
  failureError?: string;
  /** Quality score from Ollama/Gemma 3 (0-100) */
  qualityScore?: number;
  /** Quality assessment reasoning from LLM */
  qualityReasoning?: string;
  /** If quality check failed, the issue type */
  qualityIssue?: QualityIssue;
}

/**
 * Mapped status for API responses
 * Maps BullMQ internal states to user-friendly status values
 */
export type JobStatus = 'queued' | 'processing' | 'complete' | 'failed';
