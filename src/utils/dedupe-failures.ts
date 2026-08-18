/**
 * Collapse a failure list to one row per URL — the newest error replaces the
 * old, per the review workflow: retries, double bookmarks, and fix-system
 * verification replays all produce separate failed jobs for the same URL, and
 * a row per job buries the actual distinct failures. The count of collapsed
 * occurrences is kept so repeat offenders are still visible at a glance.
 *
 * Pure and import-side-effect-free so tests can load it without touching
 * Redis (files.ts itself opens queue connections on import).
 */

export interface FailureLike {
  url: string;
  /** ISO date string */
  failedAt: string;
}

/**
 * One row per URL, newest failure wins, annotated with how many failures it
 * collapsed. Output is sorted newest-first.
 */
export function dedupeFailuresByUrl<T extends FailureLike>(
  failures: T[]
): Array<T & { failureCount: number }> {
  const byUrl = new Map<string, T & { failureCount: number }>();

  for (const failure of failures) {
    const existing = byUrl.get(failure.url);
    if (!existing) {
      byUrl.set(failure.url, { ...failure, failureCount: 1 });
      continue;
    }
    existing.failureCount++;
    if (new Date(failure.failedAt).getTime() > new Date(existing.failedAt).getTime()) {
      const count = existing.failureCount;
      byUrl.set(failure.url, { ...failure, failureCount: count });
    }
  }

  return [...byUrl.values()].sort(
    (a, b) => new Date(b.failedAt).getTime() - new Date(a.failedAt).getTime()
  );
}
