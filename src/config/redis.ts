/**
 * Redis connection configuration for BullMQ
 *
 * BullMQ best practices require different connection settings for Queue vs Worker:
 * - Workers need maxRetriesPerRequest: null to handle Redis disconnects gracefully
 * - Queues should fail fast (enableOfflineQueue: false) for API responsiveness
 *
 * @see https://docs.bullmq.io/guide/going-to-production
 */

import { Redis, RedisOptions } from 'ioredis';
import { env } from './env.js';

/**
 * Connection options shared by all Redis connections
 */
const baseOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
};

/**
 * Exponential backoff retry strategy
 * Returns delay in ms, capped at 20 seconds
 */
function retryStrategy(times: number): number {
  return Math.min(times * 1000, 20000);
}

/**
 * Redis connection for BullMQ Workers
 *
 * CRITICAL: maxRetriesPerRequest must be null to prevent worker from breaking
 * during Redis disconnections. Workers will retry indefinitely.
 *
 * @see https://docs.bullmq.io/guide/connections#reusing-ioredis-connections
 */
export const workerConnection = new Redis({
  ...baseOptions,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy,
});

/**
 * Redis connection for BullMQ Queues
 *
 * Queues use enableOfflineQueue: false to fail fast when Redis is unavailable.
 * This provides immediate feedback to API callers rather than queuing commands.
 */
export const queueConnection = new Redis({
  ...baseOptions,
  enableOfflineQueue: false,
  retryStrategy,
});

/**
 * Factory function to create additional Redis connections
 * Useful for QueueEvents or other specialized use cases
 */
export function createConnection(options?: Partial<RedisOptions>): Redis {
  return new Redis({
    ...baseOptions,
    retryStrategy,
    ...options,
  });
}

// Log successful configuration (not connection - that happens lazily)
console.log(`Redis configured for ${env.REDIS_HOST}:${env.REDIS_PORT}`);
