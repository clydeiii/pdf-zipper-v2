/**
 * Helpers for reading user-behavior signals that inform self-healing diagnosis.
 *
 * The strongest signal is zip-export exclusions: URLs that passed automated
 * quality checks but the user removed from their zip exports. Those files are
 * problematic in ways the automated system missed.
 */

import { workerConnection } from '../config/redis.js';
import type { ExclusionSignal } from './prompt-builder.js';

const ZIP_EXPORTS_KEY = 'pdfzipper:zip-exports';
const MAX_EVENTS = 500;

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
 * Load aggregated exclusion signals ranked by frequency.
 * Returns URLs the user has repeatedly excluded from zip exports, sorted by
 * exclusion session count (repeated reviews + rejections = strongest signal).
 */
export async function loadExclusionSignals(): Promise<ExclusionSignal[]> {
  try {
    const raw = await workerConnection.lrange(ZIP_EXPORTS_KEY, 0, MAX_EVENTS - 1);
    const events = raw.map((s: string) => JSON.parse(s) as ZipExportEvent);

    const byUrl: Record<string, ExclusionSignal> = {};

    for (const event of events) {
      const seenInSession = new Set<string>();
      for (const file of event.excludedFiles) {
        const key = file.sourceUrl || file.path;
        if (!key) continue;

        if (!byUrl[key]) {
          byUrl[key] = {
            sourceUrl: file.sourceUrl || file.path,
            name: file.name,
            exclusionCount: 0,
            exclusionSessions: 0,
            lastExcludedAt: event.timestamp,
          };
        }
        const sig = byUrl[key];
        sig.exclusionCount++;
        if (!seenInSession.has(key)) {
          sig.exclusionSessions++;
          seenInSession.add(key);
        }
        if (event.timestamp > sig.lastExcludedAt) {
          sig.lastExcludedAt = event.timestamp;
        }
      }
    }

    return Object.values(byUrl).sort((a, b) => {
      if (b.exclusionSessions !== a.exclusionSessions) {
        return b.exclusionSessions - a.exclusionSessions;
      }
      return b.exclusionCount - a.exclusionCount;
    });
  } catch (error) {
    console.warn('Failed to load exclusion signals:', error instanceof Error ? error.message : error);
    return [];
  }
}
