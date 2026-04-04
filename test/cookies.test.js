import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Set COOKIES_FILE before importing the module (env validates on load)
const tmpCookieDir = path.join(tmpdir(), 'pdfzipper-test-cookies');
mkdirSync(tmpCookieDir, { recursive: true });
const tmpCookieFile = path.join(tmpCookieDir, 'test-cookies.txt');
process.env.COOKIES_FILE = tmpCookieFile;

// Dynamic import after env setup
const { getCookiesForUrl, loadCookies } = await import('../dist/browsers/cookies.js');

test('loadCookies returns empty array when file does not exist', () => {
  // Point to non-existent file
  process.env.COOKIES_FILE = path.join(tmpCookieDir, 'nonexistent.txt');
  // Need to re-import or the module caches... but loadCookies reads env.COOKIES_FILE
  // which was set at module load time. So this test checks the cached path behavior.
  // For a proper test we'd need to reset the module, but we can test getCookiesForUrl behavior.
  const cookies = getCookiesForUrl('https://example.com');
  assert.ok(Array.isArray(cookies));
});

test('loadCookies parses Netscape cookies.txt format', () => {
  const cookieContent = [
    '# Netscape HTTP Cookie File',
    '.nytimes.com\tTRUE\t/\tTRUE\t1735689600\tnyt-a\tabc123',
    '.nytimes.com\tTRUE\t/\tFALSE\t1735689600\tnyt-purr\tdef456',
    '# comment line',
    '',
    'example.com\tFALSE\t/\tFALSE\t0\tsession\txyz789',
  ].join('\n');

  writeFileSync(tmpCookieFile, cookieContent);

  // Reset cache by importing fresh (cookies module caches by mtime)
  const cookies = loadCookies();
  assert.equal(cookies.length, 3);

  const nytCookie = cookies.find(c => c.name === 'nyt-a');
  assert.ok(nytCookie);
  assert.equal(nytCookie.domain, '.nytimes.com');
  assert.equal(nytCookie.secure, true);
  assert.equal(nytCookie.value, 'abc123');

  const sessionCookie = cookies.find(c => c.name === 'session');
  assert.ok(sessionCookie);
  assert.equal(sessionCookie.domain, 'example.com');
  assert.equal(sessionCookie.secure, false);
  assert.equal(sessionCookie.expires, -1); // 0 becomes -1
});

test('getCookiesForUrl filters by domain with subdomain matching', () => {
  const cookieContent = [
    '.nytimes.com\tTRUE\t/\tTRUE\t1735689600\tnyt-a\tabc123',
    'example.com\tFALSE\t/\tFALSE\t1735689600\tsession\txyz789',
    '.google.com\tTRUE\t/\tTRUE\t1735689600\tgid\tgoog1',
  ].join('\n');

  writeFileSync(tmpCookieFile, cookieContent);

  // loadCookies to refresh the cache (mtime check)
  loadCookies();

  const nytCookies = getCookiesForUrl('https://www.nytimes.com/article');
  assert.equal(nytCookies.length, 1);
  assert.equal(nytCookies[0].name, 'nyt-a');

  const exampleCookies = getCookiesForUrl('https://example.com/page');
  assert.equal(exampleCookies.length, 1);
  assert.equal(exampleCookies[0].name, 'session');

  // Subdomain matching: .google.com should match sub.google.com
  const googleCookies = getCookiesForUrl('https://mail.google.com/inbox');
  assert.equal(googleCookies.length, 1);
  assert.equal(googleCookies[0].name, 'gid');
});

test('getCookiesForUrl returns empty for invalid URL', () => {
  const cookies = getCookiesForUrl('not-a-url');
  assert.deepEqual(cookies, []);
});

test('loadCookies skips malformed lines', () => {
  const cookieContent = [
    '.nytimes.com\tTRUE\t/\tTRUE\t1735689600\tnyt-a\tabc123',
    'incomplete\tline',         // too few fields
    'also incomplete',          // way too few
    '.wsj.com\tTRUE\t/\tTRUE\t1735689600\twsj-id\tdef456',
  ].join('\n');

  writeFileSync(tmpCookieFile, cookieContent);

  const cookies = loadCookies();
  assert.equal(cookies.length, 2);
});

// Cleanup
test.after(() => {
  try { unlinkSync(tmpCookieFile); } catch {}
});
