/**
 * Redis-backed weekly index for conversion job IDs.
 *
 * Avoids expensive full queue scans when listing failures and rerunning by week.
 */

import { queueConnection } from '../config/redis.js';

type ConversionIndexKind = 'completed' | 'failed';

const PREFIX = {
  completed: 'idx:conversion:week:completed:',
  failed: 'idx:conversion:week:failed:',
} as const;

function getIndexKey(weekId: string, kind: ConversionIndexKind): string {
  return `${PREFIX[kind]}${weekId}`;
}

export async function addJobToWeekIndex(params: {
  weekId: string;
  kind: ConversionIndexKind;
  jobId: string;
  scoreTimestampMs: number;
}): Promise<void> {
  const key = getIndexKey(params.weekId, params.kind);
  await queueConnection.zadd(key, params.scoreTimestampMs, params.jobId);
  await queueConnection.expire(key, 180 * 24 * 60 * 60); // 180 days
}

export async function getWeekIndexedJobIds(
  weekId: string,
  kind: ConversionIndexKind,
  limit = 5000
): Promise<string[]> {
  const key = getIndexKey(weekId, kind);
  return await queueConnection.zrevrange(key, 0, Math.max(0, limit - 1));
}

