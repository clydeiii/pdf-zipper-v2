/**
 * Trigger policy for autonomous fix scheduling.
 *
 * The policy is intentionally conservative:
 * - auto-trigger only for retryable/ambiguous failures
 * - skip known hard blockers unless manually overridden
 */

import type { FailureClass } from './failure.js';

export interface TriggerDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Cooldown durations by failure class (ms).
 */
const COOLDOWN_MS: Record<FailureClass, number> = {
  bot_detected: 6 * 60 * 60 * 1000, // 6h
  paywall: 7 * 24 * 60 * 60 * 1000, // 7d
  captcha: 7 * 24 * 60 * 60 * 1000, // 7d
  auth_required: 3 * 24 * 60 * 60 * 1000, // 3d
  timeout: 2 * 60 * 60 * 1000, // 2h
  navigation_error: 2 * 60 * 60 * 1000, // 2h
  quality_false_negative_suspected: 60 * 60 * 1000, // 1h
  quality_false_positive_suspected: 60 * 60 * 1000, // 1h
  unknown: 3 * 60 * 60 * 1000, // 3h
};

/**
 * Should a final conversion failure be auto-submitted to the fix queue.
 */
export function shouldAutoTriggerFix(failureClass: FailureClass): TriggerDecision {
  switch (failureClass) {
    case 'paywall':
    case 'captcha':
    case 'auth_required':
      return {
        allowed: false,
        reason: `skipped_auto_hard_blocker:${failureClass}`,
      };
    default:
      return {
        allowed: true,
        reason: `allowed_auto:${failureClass}`,
      };
  }
}

/**
 * Manual submissions are allowed for all classes, but can still be rate-limited by cooldown
 * unless explicitly overridden.
 */
export function shouldAllowManualSubmission(failureClass: FailureClass): TriggerDecision {
  return {
    allowed: true,
    reason: `allowed_manual:${failureClass}`,
  };
}

export function getCooldownMsForFailureClass(failureClass: FailureClass): number {
  return COOLDOWN_MS[failureClass];
}

