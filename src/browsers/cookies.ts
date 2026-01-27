import { readFileSync, existsSync, statSync } from 'node:fs';
import type { Cookie } from 'playwright';
import { env } from '../config/env.js';

/**
 * Netscape cookies.txt parser
 *
 * Format (tab-separated):
 * domain  includeSubdomains  path  secure  expiration  name  value
 *
 * Lines starting with # are comments.
 */

// Track cookies state for hot-reloading
let cachedCookies: Cookie[] | null = null;
let lastMtimeMs: number = 0;

/**
 * Parse a Netscape cookies.txt file into Playwright Cookie objects
 */
function parseCookiesTxt(filePath: string): Cookie[] {
  const raw = readFileSync(filePath, 'utf-8');
  const cookies: Cookie[] = [];

  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;

    const parts = l.split('\t');
    if (parts.length < 7) continue;

    const [domain, _includeSubdomains, path, secure, expiration, name, value] = parts;

    // Keep leading dot for subdomain matching (e.g., .nytimes.com matches www.nytimes.com)
    // Playwright's addCookies() respects the leading dot convention
    const d = domain;

    const expires = Number(expiration);
    const expiresSeconds = Number.isFinite(expires) ? expires : -1;

    cookies.push({
      name,
      value,
      domain: d,
      path: path || '/',
      secure: secure.toLowerCase() === 'true',
      httpOnly: false,
      sameSite: 'Lax',
      expires: expiresSeconds > 0 ? expiresSeconds : -1,
    });
  }

  return cookies;
}

/**
 * Get cookies from the configured cookies file
 *
 * Uses hot-reloading: if the file has changed since last load, re-parses it.
 * Returns empty array if file doesn't exist.
 *
 * @returns Array of Playwright Cookie objects
 */
export function loadCookies(): Cookie[] {
  const cookiesPath = env.COOKIES_FILE;

  if (!existsSync(cookiesPath)) {
    return [];
  }

  try {
    const stat = statSync(cookiesPath);
    const mtimeMs = stat.mtimeMs;

    // Return cached cookies if file hasn't changed
    if (cachedCookies && mtimeMs === lastMtimeMs) {
      return cachedCookies;
    }

    // Parse and cache
    const cookies = parseCookiesTxt(cookiesPath);
    cachedCookies = cookies;
    lastMtimeMs = mtimeMs;

    if (cookies.length > 0) {
      console.log(`Loaded ${cookies.length} cookies from ${cookiesPath}`);
    }

    return cookies;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load cookies from ${cookiesPath}: ${message}`);
    return [];
  }
}

/**
 * Get cookies for a specific domain
 *
 * Filters cookies to only those matching the target domain.
 * Handles subdomain matching (e.g., cookies for "example.com" match "www.example.com")
 *
 * @param targetUrl - URL to get cookies for
 * @returns Filtered array of cookies for that domain
 */
export function getCookiesForUrl(targetUrl: string): Cookie[] {
  const allCookies = loadCookies();

  if (allCookies.length === 0) {
    return [];
  }

  try {
    const url = new URL(targetUrl);
    const hostname = url.hostname.toLowerCase();

    return allCookies.filter(cookie => {
      // Strip leading dot for comparison (cookie domain may be ".example.com" or "example.com")
      const cookieDomain = cookie.domain.toLowerCase().replace(/^\./, '');
      // Exact match or subdomain match
      return hostname === cookieDomain || hostname.endsWith('.' + cookieDomain);
    });
  } catch {
    return [];
  }
}
