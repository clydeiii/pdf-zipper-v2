/**
 * Redis storage helpers for pending fix requests
 *
 * Uses a Redis list to store items waiting for AI diagnosis.
 * Items are added via API and consumed by the fix worker.
 */

import { queueConnection } from '../config/redis.js';
import type { FixJobContext, FixHistoryEntry } from '../jobs/fix-types.js';

/**
 * Redis keys for fix data
 */
const KEYS = {
  /** List of pending fix requests (FIFO) */
  PENDING: 'fix:pending',
  /** Hash of recent fix attempts by URL (for deduplication) */
  RECENT_ATTEMPTS: 'fix:recent-attempts',
  /** List of completed fix batches (for history) */
  HISTORY: 'fix:history',
};

/**
 * Add items to the pending fix queue
 * Deduplicates by URL - won't add if URL was recently attempted
 *
 * @returns Number of items actually added (after deduplication)
 */
export async function addPendingFixes(items: FixJobContext[]): Promise<number> {
  if (items.length === 0) return 0;

  let added = 0;

  for (const item of items) {
    // Check if URL was recently attempted (within last 24 hours)
    const recentAttempt = await queueConnection.hget(KEYS.RECENT_ATTEMPTS, item.url);
    if (recentAttempt) {
      console.log(`Skipping fix for ${item.url} - recently attempted at ${recentAttempt}`);
      continue;
    }

    // Add to pending list
    await queueConnection.rpush(KEYS.PENDING, JSON.stringify(item));

    // Mark as recently attempted (expires in 24 hours)
    await queueConnection.hset(KEYS.RECENT_ATTEMPTS, item.url, new Date().toISOString());
    added++;
  }

  // Set expiry on recent attempts hash (cleanup after 24 hours of no writes)
  await queueConnection.expire(KEYS.RECENT_ATTEMPTS, 86400);

  console.log(`Added ${added} items to fix queue (${items.length - added} skipped as duplicates)`);
  return added;
}

/**
 * Get all pending fix requests and clear the list
 * Atomic operation using LRANGE + DEL
 *
 * @returns Array of pending fix contexts
 */
export async function consumePendingFixes(): Promise<FixJobContext[]> {
  // Get all pending items
  const items = await queueConnection.lrange(KEYS.PENDING, 0, -1);

  if (items.length === 0) {
    return [];
  }

  // Clear the list
  await queueConnection.del(KEYS.PENDING);

  // Parse and return
  return items.map(item => JSON.parse(item) as FixJobContext);
}

/**
 * Get count of pending fix requests without consuming them
 */
export async function getPendingCount(): Promise<number> {
  return await queueConnection.llen(KEYS.PENDING);
}

/**
 * Save a completed fix batch to history
 */
export async function saveFixHistory(entry: FixHistoryEntry): Promise<void> {
  // Add to front of history list (newest first)
  await queueConnection.lpush(KEYS.HISTORY, JSON.stringify(entry));

  // Trim to last 100 entries
  await queueConnection.ltrim(KEYS.HISTORY, 0, 99);
}

/**
 * Get fix history (newest first)
 *
 * @param limit Maximum number of entries to return
 */
export async function getFixHistory(limit: number = 20): Promise<FixHistoryEntry[]> {
  const items = await queueConnection.lrange(KEYS.HISTORY, 0, limit - 1);
  return items.map(item => JSON.parse(item) as FixHistoryEntry);
}

/**
 * Clear recent attempts for a URL (allow re-diagnosis)
 */
export async function clearRecentAttempt(url: string): Promise<void> {
  await queueConnection.hdel(KEYS.RECENT_ATTEMPTS, url);
}

/**
 * Clear all pending fixes (for testing/reset)
 */
export async function clearAllPending(): Promise<number> {
  const count = await queueConnection.llen(KEYS.PENDING);
  await queueConnection.del(KEYS.PENDING);
  return count;
}
