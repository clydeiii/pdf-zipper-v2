/**
 * Type definitions for the AI self-healing fix system
 *
 * The fix system allows users to flag items as incorrectly classified:
 * - false_positive: Item succeeded but shouldn't have (bad PDF saved)
 * - false_negative: Item failed but shouldn't have (good content rejected)
 *
 * Claude Code diagnoses the issue and can autonomously apply fixes.
 */

import type { FailureClass } from '../fix/failure.js';

/**
 * Type of fix request - inferred from item status
 * - false_positive: Success that should have failed (user flagged a saved PDF)
 * - false_negative: Failure that should have succeeded (user flagged a failed URL)
 */
export type FixRequestType = 'false_positive' | 'false_negative';

/**
 * How a fix request was queued.
 */
export type FixRequestSource = 'manual' | 'automatic';

/**
 * Provider used for diagnosis/patching.
 */
export type FixProvider = 'claude' | 'codex';

/**
 * Verification/apply lifecycle state for a fix batch.
 */
export type FixGateStatus =
  | 'diagnosed'
  | 'patched'
  | 'verifying'
  | 'ready'
  | 'rejected'
  | 'applied'
  | 'failed';

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
  /** Manual user submission or automatic trigger from final failures */
  requestedBy: FixRequestSource;
  /** Classified failure type for trigger/cooldown policy */
  failureClass?: FailureClass;
  /** Manual one-time cooldown bypass */
  overrideCooldown?: boolean;
  /** Optional operator note when overriding cooldown */
  overrideReason?: string;
  /** Optional explicit provider override */
  forceProvider?: FixProvider;
  /** Why this item was accepted/rejected by trigger policy */
  triggerReason?: string;
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
  /** Provider that produced this diagnosis */
  provider: FixProvider;
  /** Verification result after re-running URL */
  verification?: {
    /** Whether the re-run produced expected result */
    success: boolean;
    /** New job IDs from replay checks */
    newJobIds?: string[];
    /** Build gate result */
    buildPassed?: boolean;
    /** Replay gate result */
    replayPassed?: boolean;
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
  /** Human-readable provider summary */
  summary?: string;
  /** Primary provider used for this batch */
  provider?: FixProvider;
  /** Whether fallback provider was used */
  providerFallbackUsed?: boolean;
  /** Total files modified across all diagnoses */
  totalFilesModified: number;
  /** Number of successful verifications */
  successfulVerifications: number;
  /** Gate/apply lifecycle state */
  gateStatus: FixGateStatus;
  /** Gate rejection/failure reason (if any) */
  gateReason?: string;
  /** Prepared branch containing changes */
  branchName?: string;
  /** Commit SHA for prepared patch */
  commitSha?: string;
  /** Suggested command to review/apply changes */
  applyCommand?: string;
  /** Replay verification jobs */
  verificationJobs?: string[];
  /** When batch was marked applied */
  appliedAt?: string;
  /** Operator identifier for apply action */
  appliedBy?: string;
  /** Start timestamp */
  startedAt: string;
  /** End timestamp */
  completedAt: string;
}

/**
 * Request body for POST /api/fix/submit
 */
export interface FixSubmitRequest {
  /** Optional top-level override for all submitted items */
  overrideCooldown?: boolean;
  /** Optional reason for cooldown override */
  overrideReason?: string;
  /** Optional provider override for this submission */
  forceProvider?: FixProvider;
  items: Array<{
    /** File path (for successful items) */
    path?: string;
    /** URL (for failed items or direct submission) */
    url?: string;
    /** Original job ID (if known) */
    jobId?: string;
    /** Request type (inferred if not provided) */
    requestType?: FixRequestType;
    /** One-off cooldown override for this item */
    overrideCooldown?: boolean;
    /** Optional note for item-level override */
    overrideReason?: string;
    /** Optional explicit provider override for this item */
    forceProvider?: FixProvider;
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
