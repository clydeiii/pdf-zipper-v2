import type { Browser } from 'playwright';
import { createStealthBrowser } from './stealth.js';

// Module-level singleton state
let browserInstance: Browser | null = null;

/**
 * Initialize browser instance (singleton pattern)
 * Safe to call multiple times - returns existing instance if already initialized
 */
export async function initBrowser(): Promise<Browser> {
  if (browserInstance) {
    return browserInstance;
  }

  browserInstance = await createStealthBrowser();
  console.log('Browser initialized with stealth plugin');

  return browserInstance;
}

/**
 * Get existing browser instance
 * Throws if browser hasn't been initialized yet (fail-fast for programming errors)
 */
export function getBrowser(): Browser {
  if (browserInstance === null) {
    throw new Error('Browser not initialized. Call initBrowser() first.');
  }

  return browserInstance;
}

/**
 * Close browser and reset singleton state
 * Safe to call multiple times - no-op if browser already closed
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance === null) {
    return;
  }

  await browserInstance.close();
  browserInstance = null;
  console.log('Browser closed');
}
