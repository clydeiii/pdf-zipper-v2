/**
 * Persistent retry-memory ledger for fix attempts and outcomes.
 *
 * Stores URL-level and domain-level history to avoid repeated dead-end retries.
 */

import { createHash } from 'node:crypto';
import { queueConnection } from '../config/redis.js';
import { normalizeBookmarkUrl } from '../urls/normalizer.js';
import type { FailureClass } from './failure.js';
import { getCooldownMsForFailureClass } from './trigger-policy.js';
import type { FixProvider, FixRequestSource } from '../jobs/fix-types.js';

const KEYS = {
  EVENTS: 'fix:events',
};

function getUrlHash(url: string): string {
  const canonical = normalizeBookmarkUrl(url);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

function getUrlKey(url: string): string {
  return `fix:ledger:url:${getUrlHash(url)}`;
}

function getDomainKey(domain: string, failureClass: FailureClass): string {
  return `fix:ledger:domain:${domain}:${failureClass}`;
}

function parseIntSafe(value: string | null | undefined, fallback = 0): number {
  if (!value) return fallback;
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

export interface FixLedgerEntry {
  url: string;
  canonicalUrl: string;
  domain: string;
  failureClass: FailureClass;
  lastAttemptAt?: string;
  attemptCount: number;
  lastOutcome?: string;
  lastProvider?: FixProvider;
  lastBatchId?: string;
  cooldownUntil?: string;
  requestedBy?: FixRequestSource;
  overrideUsed?: boolean;
}

interface LedgerEvent {
  event: string;
  url: string;
  domain: string;
  failureClass: FailureClass;
  timestamp: string;
  details?: Record<string, unknown>;
}

function buildBase(url: string): { canonicalUrl: string; domain: string } {
  const canonicalUrl = normalizeBookmarkUrl(url);
  let domain = 'unknown';
  try {
    const parsed = new URL(canonicalUrl);
    domain = parsed.hostname.toLowerCase();
  } catch {
    // Keep unknown domain
  }
  return { canonicalUrl, domain };
}

async function appendEvent(event: LedgerEvent): Promise<void> {
  await queueConnection.lpush(KEYS.EVENTS, JSON.stringify(event));
  await queueConnection.ltrim(KEYS.EVENTS, 0, 9999);
}

export async function getFixLedgerEntry(url: string): Promise<FixLedgerEntry | null> {
  const data = await queueConnection.hgetall(getUrlKey(url));
  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return {
    url: data.url || url,
    canonicalUrl: data.canonicalUrl || normalizeBookmarkUrl(url),
    domain: data.domain || 'unknown',
    failureClass: (data.failureClass as FailureClass) || 'unknown',
    lastAttemptAt: data.lastAttemptAt,
    attemptCount: parseIntSafe(data.attemptCount, 0),
    lastOutcome: data.lastOutcome,
    lastProvider: data.lastProvider as FixProvider | undefined,
    lastBatchId: data.lastBatchId,
    cooldownUntil: data.cooldownUntil,
    requestedBy: data.requestedBy as FixRequestSource | undefined,
    overrideUsed: data.overrideUsed === 'true',
  };
}

export async function isInCooldown(url: string): Promise<{ inCooldown: boolean; cooldownUntil?: string }> {
  const entry = await getFixLedgerEntry(url);
  if (!entry?.cooldownUntil) return { inCooldown: false };

  const until = Date.parse(entry.cooldownUntil);
  if (!Number.isFinite(until)) return { inCooldown: false };

  return {
    inCooldown: until > Date.now(),
    cooldownUntil: entry.cooldownUntil,
  };
}

export async function recordFixAttempt(params: {
  url: string;
  failureClass: FailureClass;
  requestedBy: FixRequestSource;
  overrideUsed: boolean;
  triggerReason?: string;
}): Promise<FixLedgerEntry> {
  const { canonicalUrl, domain } = buildBase(params.url);
  const key = getUrlKey(params.url);
  const now = new Date().toISOString();
  const cooldownMs = getCooldownMsForFailureClass(params.failureClass);
  const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();

  // Increment URL attempt count and domain-level class counter.
  const attemptCount = await queueConnection.hincrby(key, 'attemptCount', 1);
  await queueConnection.hincrby(getDomainKey(domain, params.failureClass), 'attemptCount', 1);

  await queueConnection.hset(
    key,
    'url', params.url,
    'canonicalUrl', canonicalUrl,
    'domain', domain,
    'failureClass', params.failureClass,
    'lastAttemptAt', now,
    'requestedBy', params.requestedBy,
    'overrideUsed', String(params.overrideUsed),
    'cooldownUntil', cooldownUntil,
  );
  await queueConnection.expire(key, 180 * 24 * 60 * 60); // 180 days
  await queueConnection.expire(getDomainKey(domain, params.failureClass), 180 * 24 * 60 * 60);

  await appendEvent({
    event: 'attempt_recorded',
    url: params.url,
    domain,
    failureClass: params.failureClass,
    timestamp: now,
    details: {
      requestedBy: params.requestedBy,
      overrideUsed: params.overrideUsed,
      triggerReason: params.triggerReason,
      cooldownUntil,
    },
  });

  return {
    url: params.url,
    canonicalUrl,
    domain,
    failureClass: params.failureClass,
    lastAttemptAt: now,
    attemptCount,
    cooldownUntil,
    requestedBy: params.requestedBy,
    overrideUsed: params.overrideUsed,
  };
}

export async function updateFixOutcome(params: {
  url: string;
  outcome: 'queued' | 'skipped' | 'diagnosed' | 'ready' | 'rejected' | 'applied' | 'failed';
  provider?: FixProvider;
  batchId?: string;
  failureClass?: FailureClass;
  details?: Record<string, unknown>;
}): Promise<void> {
  const entry = await getFixLedgerEntry(params.url);
  const { domain } = buildBase(params.url);
  const failureClass = params.failureClass || entry?.failureClass || 'unknown';
  const now = new Date().toISOString();
  const key = getUrlKey(params.url);

  const fields: Array<string> = ['lastOutcome', params.outcome];
  if (params.provider) {
    fields.push('lastProvider', params.provider);
  }
  if (params.batchId) {
    fields.push('lastBatchId', params.batchId);
  }
  fields.push('failureClass', failureClass);

  await queueConnection.hset(key, ...fields);
  await queueConnection.expire(key, 180 * 24 * 60 * 60);

  await appendEvent({
    event: 'outcome_updated',
    url: params.url,
    domain,
    failureClass,
    timestamp: now,
    details: {
      outcome: params.outcome,
      provider: params.provider,
      batchId: params.batchId,
      ...params.details,
    },
  });
}

