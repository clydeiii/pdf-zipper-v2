/**
 * Dependency health monitor.
 *
 * pdf-zipper degrades gracefully when a dependency is down — quality scoring
 * passes, enrichment is skipped, transcription fails over — which is exactly
 * why a six-hour Ollama outage on 2026-09-02 went unnoticed until the bare
 * files were found two days later. Graceful degradation needs a loud signal.
 *
 * Every DEPENDENCY_CHECK_INTERVAL_MINUTES (default 5) each dependency gets a
 * cheap probe. After DEPENDENCY_ALERT_AFTER_FAILURES consecutive failures
 * (default 3 ≈ 15 min, so a single blip stays quiet) a Discord warning goes
 * out; a matching "recovered" note follows when it comes back, with the
 * outage duration. State is in-memory: a restart re-arms silently.
 *
 * Probes are read-only GETs with short timeouts and never throw.
 */

import { env } from '../config/env.js';
import { sendDiscordNotification } from '../notifications/discord.js';

const ONE_MINUTE_MS = 60 * 1000;
const ENABLED = process.env.DEPENDENCY_MONITOR_ENABLED !== 'false';
const INTERVAL_MINUTES = Number(process.env.DEPENDENCY_CHECK_INTERVAL_MINUTES) || 5;
const ALERT_AFTER_FAILURES = Number(process.env.DEPENDENCY_ALERT_AFTER_FAILURES) || 3;
const PROBE_TIMEOUT_MS = 8000;
const STARTUP_DELAY_MS = 2 * ONE_MINUTE_MS;

export interface DependencyProbe {
  name: string;
  /** Resolves to null when healthy, otherwise a short reason. */
  check: () => Promise<string | null>;
}

interface DependencyState {
  consecutiveFailures: number;
  downSince: number | null;
  alerted: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
}

const states = new Map<string, DependencyState>();
let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

async function probeGet(url: string, ok: (res: Response) => Promise<boolean> | boolean = (r) => r.ok): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json, text/html;q=0.5' } });
    return (await ok(res)) ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? (err.name === 'AbortError' ? 'timeout' : err.message) : String(err);
  } finally {
    clearTimeout(t);
  }
}

function strip(host: string): string {
  return host.replace(/\/+$/, '');
}

/** The probes, built from the same env the workers use. */
export function buildDefaultProbes(): DependencyProbe[] {
  const probes: DependencyProbe[] = [
    {
      // Model list is the same call checkOllamaHealth makes; it also proves
      // the configured model is still present (a `ollama rm` mid-flight
      // would otherwise fail every enrichment with a confusing 404).
      name: `Ollama (${env.OLLAMA_HOST})`,
      check: () => probeGet(`${strip(env.OLLAMA_HOST)}/api/tags`, async (res) => {
        if (!res.ok) return false;
        const json = (await res.json().catch(() => null)) as { models?: Array<{ name: string }> } | null;
        const names = json?.models?.map((m) => m.name) ?? [];
        return names.some((n) => n.toLowerCase().includes(env.OLLAMA_MODEL.toLowerCase()));
      }),
    },
    {
      name: `Parakeet primary (${env.WHISPER_HOST})`,
      check: () => probeGet(`${strip(env.WHISPER_HOST)}/health`),
    },
    {
      name: `Nitter (${env.NITTER_HOST})`,
      // Nitter's root is its search/about page; a 200 means the instance is
      // serving. Guest-token exhaustion shows up as job-level rate_limited,
      // not here — that's throttling, not an outage.
      check: () => probeGet(`${strip(env.NITTER_HOST)}/`),
    },
  ];
  if (env.WHISPER_HOST_FALLBACK) {
    probes.push({
      name: `Parakeet fallback (${env.WHISPER_HOST_FALLBACK})`,
      check: () => probeGet(`${strip(env.WHISPER_HOST_FALLBACK!)}/health`),
    });
  }
  const karakeepBase = process.env.KARAKEEP_API_BASE;
  if (karakeepBase) {
    probes.push({
      name: `Karakeep (${karakeepBase})`,
      // Unauthenticated health endpoint; falls back to accepting any HTTP
      // answer from the root (a 401/302 still proves the app is up).
      check: async () => {
        const health = await probeGet(`${strip(karakeepBase)}/api/health`);
        if (health === null) return null;
        return probeGet(`${strip(karakeepBase)}/`, (res) => res.status < 500);
      },
    });
  }
  return probes;
}

let probes: DependencyProbe[] = [];

function stateFor(name: string): DependencyState {
  let s = states.get(name);
  if (!s) {
    s = { consecutiveFailures: 0, downSince: null, alerted: false, lastError: null, lastCheckedAt: null };
    states.set(name, s);
  }
  return s;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / ONE_MINUTE_MS);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Run every probe once and update state. Exported for the API/status view;
 * `customProbes` lets tests drive the state machine without network.
 */
export async function runDependencyChecks(
  customProbes?: DependencyProbe[]
): Promise<Array<{ name: string; healthy: boolean; error: string | null; downSince: string | null }>> {
  const active = customProbes ?? (probes.length > 0 ? probes : (probes = buildDefaultProbes()));
  const results = await Promise.all(active.map(async (probe) => {
    const s = stateFor(probe.name);
    let error: string | null;
    try {
      error = await probe.check();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    s.lastCheckedAt = new Date().toISOString();
    if (error === null) {
      if (s.alerted && s.downSince !== null) {
        const downFor = formatDuration(Date.now() - s.downSince);
        console.log(JSON.stringify({ event: 'dependency_recovered', dependency: probe.name, downFor, timestamp: s.lastCheckedAt }));
        await sendDiscordNotification({
          type: 'success',
          title: `✅ ${probe.name} recovered`,
          description: `Back after ${downFor}. Captures made meanwhile may have skipped enrichment/quality scoring — the enrichment repair sweep picks those up.`,
        }).catch(() => { /* non-fatal */ });
      }
      s.consecutiveFailures = 0;
      s.downSince = null;
      s.alerted = false;
      s.lastError = null;
    } else {
      s.consecutiveFailures++;
      s.lastError = error;
      if (s.downSince === null) s.downSince = Date.now();
      if (!s.alerted && s.consecutiveFailures >= ALERT_AFTER_FAILURES) {
        s.alerted = true;
        console.warn(JSON.stringify({ event: 'dependency_down', dependency: probe.name, error, consecutiveFailures: s.consecutiveFailures, timestamp: s.lastCheckedAt }));
        await sendDiscordNotification({
          type: 'warning',
          title: `🚨 ${probe.name} is down`,
          description: `${s.consecutiveFailures} consecutive failed probes over ~${formatDuration(Date.now() - s.downSince)}: ${error}`,
        }).catch(() => { /* non-fatal */ });
      }
    }
    return {
      name: probe.name,
      healthy: error === null,
      error,
      downSince: s.downSince ? new Date(s.downSince).toISOString() : null,
    };
  }));
  return results;
}

export function startDependencyMonitor(customProbes?: DependencyProbe[]): void {
  if (!ENABLED) {
    console.log('Dependency monitor disabled (DEPENDENCY_MONITOR_ENABLED=false)');
    return;
  }
  probes = customProbes ?? buildDefaultProbes();
  startupTimer = setTimeout(() => {
    void runDependencyChecks();
    timer = setInterval(() => { void runDependencyChecks(); }, INTERVAL_MINUTES * ONE_MINUTE_MS);
  }, STARTUP_DELAY_MS);
  console.log(`Dependency monitor scheduled: ${probes.length} probe(s) every ${INTERVAL_MINUTES} min, alert after ${ALERT_AFTER_FAILURES} failures`);
}

export function stopDependencyMonitor(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

/** Test hook: forget all outage state. */
export function resetDependencyStateForTest(): void {
  states.clear();
}

/** Alert threshold (consecutive failed probes) — exported for tests. */
export const DEPENDENCY_ALERT_AFTER_FAILURES = ALERT_AFTER_FAILURES;
