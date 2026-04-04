/**
 * Telemetry routes for tracking user interactions
 *
 * POST /telemetry - Record a click event
 * GET /telemetry - Get recent telemetry (for fix system)
 * GET /telemetry/signals - Get aggregated signals per URL (for fix system)
 *
 * Stored in Redis as a capped list. The fix system reads this to understand
 * which URLs the user is manually intervening on (clicking source, viewing errors).
 */

import { Router, Request, Response } from 'express';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';

export const telemetryRouter = Router();

const TELEMETRY_KEY = 'pdfzipper:telemetry';
const ZIP_EXPORTS_KEY = 'pdfzipper:zip-exports';
const MAX_ENTRIES = 1000;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    redis.connect().catch(() => {});
  }
  return redis;
}

interface TelemetryEntry {
  action: string;
  url: string;
  weekId?: string;
  timestamp: string;
  error?: string;
}

interface ExcludedFile {
  path: string;
  sourceUrl: string | null;
  name: string;
}

interface ZipExportEvent {
  weekId: string;
  timestamp: string;
  includedCount: number;
  excludedFiles: ExcludedFile[];
}

/**
 * POST /telemetry - Record a click event from the UI
 */
telemetryRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const entry = req.body as TelemetryEntry;

  if (!entry.action || !entry.url) {
    res.status(400).json({ error: 'action and url required' });
    return;
  }

  try {
    const r = getRedis();
    await r.lpush(TELEMETRY_KEY, JSON.stringify(entry));
    await r.ltrim(TELEMETRY_KEY, 0, MAX_ENTRIES - 1);
    res.json({ ok: true });
  } catch (error) {
    // Non-critical — don't fail if Redis is down
    console.warn('Telemetry write failed:', error instanceof Error ? error.message : error);
    res.json({ ok: true, warning: 'storage unavailable' });
  }
});

/**
 * GET /telemetry - Get recent telemetry entries
 * Query params: limit (default 100), action (filter by action type)
 */
telemetryRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, MAX_ENTRIES);
  const actionFilter = req.query.action as string;

  try {
    const r = getRedis();
    const raw = await r.lrange(TELEMETRY_KEY, 0, limit - 1);
    let entries = raw.map((s: string) => JSON.parse(s) as TelemetryEntry);

    if (actionFilter) {
      entries = entries.filter((e: TelemetryEntry) => e.action === actionFilter);
    }

    res.json(entries);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read telemetry' });
  }
});

/**
 * GET /telemetry/signals - Aggregated signals per URL for the fix system
 *
 * Returns URLs ranked by manual intervention frequency.
 * High click counts on source/error links suggest the user is manually
 * handling content that the automated system is failing on.
 */
telemetryRouter.get('/signals', async (req: Request, res: Response): Promise<void> => {
  try {
    const r = getRedis();
    const raw = await r.lrange(TELEMETRY_KEY, 0, MAX_ENTRIES - 1);
    const entries = raw.map((s: string) => JSON.parse(s) as TelemetryEntry);

    // Aggregate by URL
    const urlSignals: Record<string, {
      url: string;
      clicks: number;
      actions: Record<string, number>;
      lastSeen: string;
      errors: string[];
    }> = {};

    for (const entry of entries) {
      const url = entry.url;
      if (!urlSignals[url]) {
        urlSignals[url] = { url, clicks: 0, actions: {}, lastSeen: entry.timestamp, errors: [] };
      }
      const sig = urlSignals[url];
      sig.clicks++;
      sig.actions[entry.action] = (sig.actions[entry.action] || 0) + 1;
      if (entry.timestamp > sig.lastSeen) sig.lastSeen = entry.timestamp;
      if (entry.error && !sig.errors.includes(entry.error)) sig.errors.push(entry.error);
    }

    // Sort by click count descending
    const signals = Object.values(urlSignals).sort((a, b) => b.clicks - a.clicks);

    res.json(signals);
  } catch (error) {
    res.status(500).json({ error: 'Failed to aggregate signals' });
  }
});

/**
 * POST /telemetry/zip-export - Record a zip export event with excluded files
 *
 * This is the STRONGEST self-healing signal. When the user exports a zip but
 * excludes specific files, those files are problematic — the user reviewed
 * them and rejected them. Multiple exclusions of the same URL (from reruns)
 * strongly suggest the automated capture is failing in a way worth fixing.
 */
telemetryRouter.post('/zip-export', async (req: Request, res: Response): Promise<void> => {
  const event = req.body as ZipExportEvent;

  if (!event.weekId || !Array.isArray(event.excludedFiles)) {
    res.status(400).json({ error: 'weekId and excludedFiles required' });
    return;
  }

  try {
    const r = getRedis();
    await r.lpush(ZIP_EXPORTS_KEY, JSON.stringify(event));
    await r.ltrim(ZIP_EXPORTS_KEY, 0, MAX_ENTRIES - 1);
    res.json({ ok: true, excludedCount: event.excludedFiles.length });
  } catch (error) {
    console.warn('Zip export telemetry write failed:', error instanceof Error ? error.message : error);
    res.json({ ok: true, warning: 'storage unavailable' });
  }
});

/**
 * GET /telemetry/problematic - URLs flagged as problematic via exclusion signal
 *
 * Aggregates zip-export exclusions per source URL. URLs excluded multiple times
 * across different export sessions are highest priority for self-healing.
 * This is the primary input the fix system should use.
 */
telemetryRouter.get('/problematic', async (req: Request, res: Response): Promise<void> => {
  try {
    const r = getRedis();
    const raw = await r.lrange(ZIP_EXPORTS_KEY, 0, MAX_ENTRIES - 1);
    const events = raw.map((s: string) => JSON.parse(s) as ZipExportEvent);

    // Aggregate exclusions by source URL
    const problematic: Record<string, {
      sourceUrl: string;
      name: string;
      exclusionCount: number;
      exclusionSessions: number;
      lastExcludedAt: string;
      weekIds: string[];
    }> = {};

    for (const event of events) {
      const seenInSession = new Set<string>();
      for (const file of event.excludedFiles) {
        const key = file.sourceUrl || file.path;
        if (!key) continue;

        if (!problematic[key]) {
          problematic[key] = {
            sourceUrl: file.sourceUrl || file.path,
            name: file.name,
            exclusionCount: 0,
            exclusionSessions: 0,
            lastExcludedAt: event.timestamp,
            weekIds: [],
          };
        }
        const entry = problematic[key];
        entry.exclusionCount++;
        if (!seenInSession.has(key)) {
          entry.exclusionSessions++;
          seenInSession.add(key);
        }
        if (event.timestamp > entry.lastExcludedAt) {
          entry.lastExcludedAt = event.timestamp;
        }
        if (!entry.weekIds.includes(event.weekId)) {
          entry.weekIds.push(event.weekId);
        }
      }
    }

    // Sort by exclusion sessions (repeated exclusions = stronger signal than
    // single-session exclusions of many files)
    const ranked = Object.values(problematic).sort((a, b) => {
      if (b.exclusionSessions !== a.exclusionSessions) {
        return b.exclusionSessions - a.exclusionSessions;
      }
      return b.exclusionCount - a.exclusionCount;
    });

    res.json(ranked);
  } catch (error) {
    res.status(500).json({ error: 'Failed to aggregate problematic URLs' });
  }
});
