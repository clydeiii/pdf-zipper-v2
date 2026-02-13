/**
 * Type definitions for the AI self-healing fix system
 *
 * The fix system allows users to flag items as incorrectly classified:
 * - false_positive: Item succeeded but shouldn't have (bad PDF saved)
 * - false_negative: Item failed but shouldn't have (good content rejected)
 *
 * Claude Code diagnoses the issue and can autonomously apply fixes.
 */

import type { QualityIssue } from '../quality/types.js';

/**
 * Type of fix request - inferred from item status
 * - false_positive: Success that should have failed (user flagged a saved PDF)
 * - false_negative: Failure that should have succeeded (user flagged a failed URL)
 */
export type FixRequestType = 'false_positive' | 'false_negative';

/**
 * Context for a single item pending diagnosis
 * Collected when user submits items for fixing
 */
export interface FixJobContext {
  /** Original conversion job ID */
  originalJobId: string;
  /** URL that was converted */
  url: string;
  /** Type of fix request */
  requestType: FixRequestType;
  /** Original job status */
  status: 'complete' | 'failed';
  /** Path to PDF (for successful jobs) */
  pdfPath?: string;
  /** Path to debug PDF (for failed jobs in data/debug/{id}.pdf) */
  debugPdfPath?: string;
  /** Failure reason (for failed jobs) */
  failureReason?: string;
  /** Quality score (for successful jobs) */
  qualityScore?: number;
  /** Quality reasoning from LLM (for successful jobs) */
  qualityReasoning?: string;
  /** Week ID for organization (e.g., "2026-W04") */
  weekId: string;
  /** Timestamp when fix was requested */
  requestedAt: string;
}

/**
 * Job data for the fix processing queue
 * Scheduled job that processes all pending fix requests
 */
export interface FixJobData {
  /** Placeholder - actual items come from Redis pending list */
  trigger: 'scheduled' | 'manual';
}

/**
 * Result of Claude Code diagnosis for a single item
 */
export interface FixDiagnosis {
  /** Original fix context */
  context: FixJobContext;
  /** Root cause identified by Claude Code */
  rootCause: string;
  /** Suggested fix (may be code change or configuration) */
  suggestedFix?: string;
  /** Files modified by Claude Code (if any) */
  filesModified: string[];
  /** Whether a code fix was applied */
  fixApplied: boolean;
  /** Verification result after re-running URL */
  verification?: {
    /** Whether the re-run produced expected result */
    success: boolean;
    /** New job ID from re-run */
    newJobId?: string;
    /** Error if verification failed */
    error?: string;
  };
  /** Timestamp of diagnosis */
  diagnosedAt: string;
}

/**
 * History entry for completed fix batches
 * Stored in Redis for viewing past diagnoses
 */
export interface FixHistoryEntry {
  /** Unique ID for this fix batch */
  batchId: string;
  /** Number of items in the batch */
  itemCount: number;
  /** Diagnoses for each item */
  diagnoses: FixDiagnosis[];
  /** Total files modified across all diagnoses */
  totalFilesModified: number;
  /** Number of successful verifications */
  successfulVerifications: number;
  /** Start timestamp */
  startedAt: string;
  /** End timestamp */
  completedAt: string;
}

/**
 * Request body for POST /api/fix/submit
 */
export interface FixSubmitRequest {
  items: Array<{
    /** File path (for successful items) */
    path?: string;
    /** URL (for failed items or direct submission) */
    url?: string;
    /** Original job ID (if known) */
    jobId?: string;
    /** Request type (inferred if not provided) */
    requestType?: FixRequestType;
  }>;
}

/**
 * Response for POST /api/fix/submit
 */
export interface FixSubmitResponse {
  /** Number of items queued for diagnosis */
  queued: number;
  /** Message */
  message: string;
}

/**
 * Response for GET /api/fix/history
 */
export interface FixHistoryResponse {
  /** Recent fix batches (newest first) */
  batches: FixHistoryEntry[];
}
