/**
 * Redis storage helpers for pending fix requests
 *
 * Uses a Redis list to store items waiting for AI diagnosis.
 * Items are added via API and consumed by the fix worker.
 */

import { queueConnection } from '../config/redis.js';
import { isInCooldown, recordFixAttempt, updateFixOutcome } from './ledger.js';
import { classifyFailureMessage } from './failure.js';
import { shouldAllowManualSubmission, shouldAutoTriggerFix } from './trigger-policy.js';
import type { FixJobContext, FixHistoryEntry } from '../jobs/fix-types.js';

/**
 * Redis keys for fix data
 */
const KEYS = {
  /** List of pending fix requests (FIFO) */
  PENDING: 'fix:pending',
  /** Set of pending URLs to dedupe queued requests */
  PENDING_URLS: 'fix:pending:urls',
  /** List of completed fix batches (for history) */
  HISTORY: 'fix:history',
  /** Prefix for batch detail payloads */
  BATCH_PREFIX: 'fix:batch:',
};

/**
 * Add items to the pending fix queue
 * Deduplicates by URL and enforces cooldown policy unless overridden.
 *
 * @returns Number of items actually added (after deduplication)
 */
export async function addPendingFixes(items: FixJobContext[]): Promise<number> {
  if (items.length === 0) return 0;

  let added = 0;
  let skipped = 0;

  for (const item of items) {
    const failureClass = item.failureClass || classifyFailureMessage(item.failureReason);
    item.failureClass = failureClass;

    const triggerDecision = item.requestedBy === 'manual'
      ? shouldAllowManualSubmission(failureClass)
      : shouldAutoTriggerFix(failureClass);

    if (!triggerDecision.allowed) {
      item.triggerReason = triggerDecision.reason;
      await updateFixOutcome({
        url: item.url,
        outcome: 'skipped',
        failureClass,
        details: { reason: triggerDecision.reason },
      });
      skipped++;
      continue;
    }

    item.triggerReason = triggerDecision.reason;

    // Cooldown check unless explicitly overridden.
    const inCooldown = await isInCooldown(item.url);
    const override = item.overrideCooldown === true;
    if (inCooldown.inCooldown && !override) {
      await updateFixOutcome({
        url: item.url,
        outcome: 'skipped',
        failureClass,
        details: {
          reason: 'in_cooldown',
          cooldownUntil: inCooldown.cooldownUntil,
        },
      });
      skipped++;
      continue;
    }

    // Avoid duplicate queue entries for the same URL.
    const addedToSet = await queueConnection.sadd(KEYS.PENDING_URLS, item.url);
    if (addedToSet !== 1) {
      skipped++;
      continue;
    }

    // Add to pending list.
    await queueConnection.rpush(KEYS.PENDING, JSON.stringify(item));
    await recordFixAttempt({
      url: item.url,
      failureClass,
      requestedBy: item.requestedBy,
      overrideUsed: override,
      triggerReason: triggerDecision.reason,
    });
    await updateFixOutcome({
      url: item.url,
      outcome: 'queued',
      failureClass,
      details: {
        requestedBy: item.requestedBy,
        overrideUsed: override,
      },
    });

    added++;
  }

  console.log(`Added ${added} items to fix queue (${skipped} skipped)`);
  return added;
}

/**
 * Get all pending fix requests and clear the list
 * Atomic operation using LRANGE + DEL
 *
 * @returns Array of pending fix contexts
 */
export async function consumePendingFixes(): Promise<FixJobContext[]> {
  // Atomically read and clear pending queue + dedupe set.
  const multiResult = await queueConnection
    .multi()
    .lrange(KEYS.PENDING, 0, -1)
    .del(KEYS.PENDING)
    .del(KEYS.PENDING_URLS)
    .exec();

  if (!multiResult || multiResult.length === 0) {
    return [];
  }

  const listResult = multiResult[0];
  if (!listResult || listResult[0]) {
    console.error('Failed to consume pending fixes atomically', listResult?.[0]);
    return [];
  }

  const rawItems = (listResult[1] as string[]) || [];
  if (rawItems.length === 0) return [];

  return rawItems.map((item) => JSON.parse(item) as FixJobContext);
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
  const batchKey = `${KEYS.BATCH_PREFIX}${entry.batchId}`;
  const tx = queueConnection.multi();
  tx.set(batchKey, JSON.stringify(entry), 'EX', 30 * 24 * 60 * 60); // 30 days
  tx.lpush(KEYS.HISTORY, entry.batchId);
  tx.ltrim(KEYS.HISTORY, 0, 99);
  await tx.exec();
}

/**
 * Get fix history (newest first)
 *
 * @param limit Maximum number of entries to return
 */
export async function getFixHistory(limit: number = 20): Promise<FixHistoryEntry[]> {
  const ids = await queueConnection.lrange(KEYS.HISTORY, 0, Math.max(0, limit - 1));
  if (ids.length === 0) return [];

  const keys = ids.map((id) => `${KEYS.BATCH_PREFIX}${id}`);
  const payloads = await queueConnection.mget(...keys);

  return payloads
    .filter((payload): payload is string => !!payload)
    .map((payload) => JSON.parse(payload) as FixHistoryEntry);
}

/**
 * Get one batch by ID.
 */
export async function getFixBatch(batchId: string): Promise<FixHistoryEntry | null> {
  const payload = await queueConnection.get(`${KEYS.BATCH_PREFIX}${batchId}`);
  if (!payload) return null;
  return JSON.parse(payload) as FixHistoryEntry;
}

/**
 * Update one batch in history storage.
 */
export async function updateFixBatch(entry: FixHistoryEntry): Promise<void> {
  await queueConnection.set(
    `${KEYS.BATCH_PREFIX}${entry.batchId}`,
    JSON.stringify(entry),
    'EX',
    30 * 24 * 60 * 60
  );
}

/**
 * Clear all pending fixes (for testing/reset)
 */
export async function clearAllPending(): Promise<number> {
  const count = await queueConnection.llen(KEYS.PENDING);
  await queueConnection.del(KEYS.PENDING, KEYS.PENDING_URLS);
  return count;
}
