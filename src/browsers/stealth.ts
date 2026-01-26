import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser } from 'playwright';

// Apply stealth plugin to chromium
chromium.use(StealthPlugin());

/**
 * Create a stealth-enabled Chromium browser instance
 * Uses playwright-extra with stealth plugin to reduce bot detection signals
 */
export async function createStealthBrowser(): Promise<Browser> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--start-maximized',
      '--disable-dev-shm-usage',
    ]
  });

  return browser;
}
