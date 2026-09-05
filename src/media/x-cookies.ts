/**
 * X-scoped cookie jar for yt-dlp.
 *
 * The personal cookies.txt holds sessions for every paywalled site the user
 * reads. Handing the whole jar to yt-dlp for an x.com download would present
 * all of them to whatever an extractor redirect lands on, and — the reason
 * this file exists — would present the personal Google session to YouTube,
 * which is exactly what triggered YouTube's bot detection before the
 * work-account YT_DLP_COOKIES_FILE split. So: one derived file with only the
 * x.com / twitter.com lines, regenerated whenever the source jar changes.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { env } from '../config/env.js';

const X_DOMAIN = /(^|\.)(x\.com|twitter\.com)$/i;

/** Pure: keep the Netscape header and only the X/Twitter cookie lines. */
export function filterCookiesToX(netscapeText: string): string {
  const out: string[] = ['# Netscape HTTP Cookie File', '# x.com / twitter.com subset derived by pdf-zipper-v2 (see src/media/x-cookies.ts)'];
  for (const line of netscapeText.split('\n')) {
    const trimmed = line.trim();
    // `#HttpOnly_` is a real cookie line (curl/Chrome export convention), not a comment.
    if (!trimmed || (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_'))) continue;
    const domain = trimmed.split('\t')[0]?.replace(/^#HttpOnly_/, '') ?? '';
    if (X_DOMAIN.test(domain)) out.push(line.replace(/\r$/, ''));
  }
  return out.join('\n') + '\n';
}

let cached: { sourceMtimeMs: number; file: string | undefined } | null = null;

/**
 * Path to the derived X-only jar, or undefined when the personal jar is
 * absent or holds no X cookies. Cheap to call: re-derives only on mtime change.
 */
export function getXScopedCookiesFile(): string | undefined {
  const source = env.COOKIES_FILE;
  if (!source || !existsSync(source)) return undefined;
  let mtimeMs: number;
  try { mtimeMs = statSync(source).mtimeMs; } catch { return undefined; }
  if (cached && cached.sourceMtimeMs === mtimeMs) return cached.file;
  try {
    const filtered = filterCookiesToX(readFileSync(source, 'utf8'));
    const hasCookies = filtered.split('\n').some((l) => l && !l.startsWith('#'));
    const target = path.join(path.dirname(source), '.cookies-x.txt');
    if (hasCookies) writeFileSync(target, filtered, { mode: 0o600 });
    cached = { sourceMtimeMs: mtimeMs, file: hasCookies ? target : undefined };
  } catch {
    cached = { sourceMtimeMs: mtimeMs, file: undefined };
  }
  return cached.file;
}
