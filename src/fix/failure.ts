/**
 * Failure classification for conversion and self-healing decisions.
 *
 * Classifies final conversion errors into buckets used by:
 * - auto-trigger policy
 * - cooldown ledger
 * - UI/operator reporting
 */

export type FailureClass =
  | 'bot_detected'
  | 'paywall'
  | 'captcha'
  | 'auth_required'
  | 'timeout'
  | 'navigation_error'
  | 'quality_false_negative_suspected'
  | 'quality_false_positive_suspected'
  | 'unknown';

/**
 * Normalize common "reason: details" error formats into classes.
 */
export function classifyFailureMessage(message?: string): FailureClass {
  const text = (message || '').toLowerCase();

  if (!text) return 'unknown';

  if (text.startsWith('paywall:') || text.includes('subscription') || text.includes('subscriber only')) {
    return 'paywall';
  }

  if (text.includes('captcha') || text.includes('verify you are human') || text.includes('cloudflare')) {
    return 'captcha';
  }

  if (text.includes('login required') || text.includes('sign in') || text.includes('authentication')) {
    return 'auth_required';
  }

  if (text.startsWith('bot_detected:') || text.startsWith('blank_page:') || text.includes('bot detection')) {
    return 'bot_detected';
  }

  if (text.startsWith('timeout:') || text.includes('timed out')) {
    return 'timeout';
  }

  if (text.startsWith('navigation_error:') || text.includes('navigation failed')) {
    return 'navigation_error';
  }

  // Conversion failed but may have been a quality false-negative (good content rejected)
  if (
    text.startsWith('truncated:') ||
    text.startsWith('quality_failed:') ||
    text.startsWith('low_contrast:') ||
    text.startsWith('missing_content:')
  ) {
    return 'quality_false_negative_suspected';
  }

  return 'unknown';
}

