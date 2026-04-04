/**
 * Fix queue for AI self-healing diagnosis jobs
 *
 * Uses BullMQ Job Scheduler to process pending fix requests every 12 hours.
 * Offset by 2.5 minutes from feed polling to avoid overlap.
 */

import { Queue } from 'bullmq';
import { queueConnection } from '../config/redis.js';
import { env } from '../config/env.js';
import type { FixJobData, FixHistoryEntry } from '../jobs/fix-types.js';

/**
 * Queue name constant - must match worker configuration
 */
export const FIX_QUEUE_NAME = 'fix-diagnosis';

/**
 * BullMQ queue for fix diagnosis jobs
 *
 * Configuration:
 * - Single job at a time (diagnosis is resource-intensive)
 * - No retries (Claude Code handles its own error recovery)
 * - Keep completed jobs for history viewing
 */
export const fixQueue = new Queue<FixJobData, FixHistoryEntry>(
  FIX_QUEUE_NAME,
  {
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 1,  // No retries - Claude handles recovery
      removeOnComplete: {
        count: 50,    // Keep last 50 completed diagnoses
        age: 604800,  // Or 7 days
      },
      removeOnFail: {
        count: 100,   // Keep failed for debugging
        age: 1209600, // 14 days
      },
    },
  }
);

/**
 * Initialize the fix diagnosis scheduler
 *
 * Runs every 12 hours. Fix diagnosis is expensive (spawns Claude/Codex CLI)
 * and user-initiated fix requests are rare — daily-cadence polling is plenty.
 * Only runs if FIX_ENABLED is true.
 */
export async function initializeFixScheduler(): Promise<void> {
  if (!env.FIX_ENABLED) {
    console.log('Fix feature disabled (FIX_ENABLED=false)');
    return;
  }

  // 12 hour interval
  const intervalMs = 12 * 60 * 60 * 1000;

  await fixQueue.upsertJobScheduler(
    'fix-processor',
    {
      every: intervalMs,
    },
    {
      name: 'process-pending-fixes',
      data: { trigger: 'scheduled' },
    }
  );

  console.log(`Fix diagnosis scheduler initialized: every 12 hours`);
}

console.log(`Fix queue '${FIX_QUEUE_NAME}' initialized`);
