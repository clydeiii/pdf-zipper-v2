/**
 * Renderer-crash failure detection (pure helpers, no Playwright imports so
 * tests can load this without dragging in the browser stack).
 *
 * A Chromium renderer crash ("page.emulateMedia: Target crashed") is neither a
 * site problem nor a quality miss — it's resource pressure (heavy chart pages
 * like epoch.ai benchmarks OOM the tab) or a dead browser process poisoning
 * the singleton. The queue's seconds-scale backoff burns all 3 attempts inside
 * the same pressure window, so crashes get a delayed second-life requeue in
 * the conversion worker, tracked via a jobId suffix (job data stays untouched).
 */

/** Matches Playwright's tab/browser crash errors ("Target crashed", "Page crashed"). */
export function isRendererCrashMessage(message?: string): boolean {
  const text = (message || '').toLowerCase();
  return text.includes('target crashed') || text.includes('page crashed');
}

/**
 * Count prior crash requeues from the jobId chain. Each requeue appends
 * `_crN`, so "abc_cr1_cr2" → 2. Counting from the id (not job data) keeps the
 * ConversionJobData contract unchanged.
 */
export function countCrashRequeues(jobId?: string): number {
  const match = (jobId || '').match(/_cr(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}
