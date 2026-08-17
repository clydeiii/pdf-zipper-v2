import type { Browser } from 'playwright';
import { initBrowser, closeBrowser } from '../browsers/manager.js';

/**
 * The browser manager is a module singleton that never checks liveness: after
 * a Chromium process crash (renderer OOM on a heavy page, xvfb hiccup) it
 * keeps handing out the dead instance, so every subsequent conversion —
 * including all BullMQ retries of the job that triggered the crash — fails
 * instantly with "Target crashed" until the whole app restarts.
 */

let relaunchInFlight: Promise<Browser> | null = null;

/**
 * Get the shared browser, relaunching it if the process has died. Concurrent
 * callers share one relaunch (concurrency 2 in compose) so a crash can't fork
 * two browser processes.
 */
export async function ensureLiveBrowser(): Promise<Browser> {
  const browser = await initBrowser();
  if (browser.isConnected()) {
    return browser;
  }
  if (!relaunchInFlight) {
    console.warn('[browser-health] shared browser is disconnected (earlier crash?) — relaunching');
    relaunchInFlight = (async () => {
      try {
        await closeBrowser();
      } catch {
        // Already-dead browser: close() failing must not block the relaunch.
      }
      return initBrowser();
    })().finally(() => {
      relaunchInFlight = null;
    });
  }
  return relaunchInFlight;
}
