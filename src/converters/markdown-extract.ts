import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Readability } from '@mozilla/readability';
import type { Page, CDPSession } from 'playwright';

export const DEFAULT_MARKDOWN_MAX_CHARS = 200_000;
export const MARKDOWN_MIN_CHARS = 500;
export type ReadabilityMetadata = Partial<Omit<NonNullable<ReturnType<Readability['parse']>>, 'content' | 'textContent'>>;
export interface MarkdownExtraction {
  markdown: string;
  fullLength: number;
  truncated: boolean;
  extractedBy: string;
  readability: ReadabilityMetadata;
}

export function isTwitterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').replace(/^(?:mobile|m)\./, '');
    return host === 'x.com' || host === 'twitter.com';
  } catch { return false; }
}

export function markdownSkipReason(url: string, targetUrl: string, nitterHost = 'http://localhost:8080'): string | undefined {
  for (const candidate of [url, targetUrl]) {
    if (isTwitterUrl(candidate)) return 'twitter';
    let parsed: URL;
    try { parsed = new URL(candidate); } catch { return 'invalid_url'; }
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'nitter' || host === new URL(nitterHost).hostname) return 'nitter';
    if (/^archive\.(is|today|ph|li|md|vn|fo)$/.test(host)) return 'archive_snapshot';
    if (host === 'hf.space' || host.endsWith('.hf.space') ||
        (host === 'huggingface.co' && /^\/spaces(?:\/|$)/.test(parsed.pathname))) return 'hf_space';
    if (host === 'datawrapper.dwcdn.net' ||
        (host === 'datawrapper.de' && /^\/_\//.test(parsed.pathname))) return 'datawrapper';
  }
  return undefined;
}

export function shouldExtractMarkdown(url: string, targetUrl: string, nitterHost?: string): boolean {
  return markdownSkipReason(url, targetUrl, nitterHost) === undefined;
}

export function markdownMaxChars(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MARKDOWN_MAX_CHARS;
}

export function capMarkdownAtParagraph(markdown: string, maxChars = DEFAULT_MARKDOWN_MAX_CHARS) {
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MARKDOWN_MAX_CHARS;
  if (markdown.length <= limit) return { markdown, fullLength: markdown.length, truncated: false };
  // Include the separator just beyond the limit so a paragraph that fits
  // exactly is retained. Blank lines inside fenced code aren't paragraphs.
  const prefix = markdown.slice(0, limit + 2);
  // Never split a paragraph. If even the first paragraph cannot fit, omit the
  // extraction rather than embedding an empty field or inventing a fragment.
  let boundary = 0;
  let fence = '';
  for (const match of prefix.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)$|\r?\n[\t ]*\r?\n/gm)) {
    if (match[1]) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = '';
    } else if (!fence && match.index <= limit) {
      boundary = match.index;
    }
  }
  return { markdown: prefix.slice(0, boundary), fullLength: markdown.length, truncated: true };
}

export function buildMarkdownExtractedBy(readabilityVersion: string, turndownVersion: string): string {
  return `readability+turndown@server r${readabilityVersion} t${turndownVersion}`;
}

export function markdownInfoDictFields(result?: MarkdownExtraction): Record<string, string> {
  if (!result?.markdown || result.fullLength < MARKDOWN_MIN_CHARS) return {};
  const fields: Record<string, string> = {
    Markdown: result.markdown,
    MarkdownLength: String(result.fullLength),
    MarkdownExtractedBy: result.extractedBy,
  };
  if (result.truncated) fields.MarkdownTruncated = 'true';
  // These names deliberately cannot overwrite the validated enrichment fields.
  for (const [key, value] of Object.entries({
    ReadabilityByline: result.readability.byline,
    ReadabilitySiteName: result.readability.siteName,
    ReadabilityPublishedTime: result.readability.publishedTime,
    ReadabilityExcerpt: result.readability.excerpt,
    ReadabilityLang: result.readability.lang,
  })) {
    if (value) fields[key] = value;
  }
  return fields;
}

interface MarkdownService {
  use(plugin: (service: MarkdownService) => void): void;
  addRule(name: string, rule: { filter(node: HTMLElement): boolean; replacement(): string }): void;
  turndown(html: string): string;
}
type MarkdownConstructor = new (options: Record<string, string>) => MarkdownService;

// Self-contained so the exact same conversion runs in Chromium and Node tests.
export function htmlToMarkdown(html: string, baseUrl: string, Turndown: MarkdownConstructor, tables: (service: MarkdownService) => void): string {
  const service = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  service.use(tables);
  service.addRule('absolute-urls', {
    filter(node) {
      // Normalize attributes on Turndown's private DOM, then let its built-in
      // rules retain link titles, image alt text and normal Markdown escaping.
      for (const attribute of ['href', 'src']) {
        const value = node.getAttribute(attribute);
        if (value) {
          try { node.setAttribute(attribute, new URL(value, baseUrl).href); } catch { /* Keep malformed source URLs verbatim. */ }
        }
      }
      return false;
    },
    replacement: () => '',
  });
  return service.turndown(html);
}

const require = createRequire(import.meta.url);
// Production package files survive Docker's dev-dependency pruning. A broken
// package installation must disable this optional feature, not server startup.
const browserLibraries = (() => {
  try {
    const source = [
      '@mozilla/readability/Readability.js',
      '@mozilla/readability/Readability-readerable.js',
      'turndown/lib/turndown.browser.umd.js',
      'turndown-plugin-gfm/dist/turndown-plugin-gfm.js',
    ].map(file => readFileSync(require.resolve(file), 'utf8')).join('\n;\n');
    const extractedBy = buildMarkdownExtractedBy(
      require('@mozilla/readability/package.json').version,
      require('turndown/package.json').version,
    );
    // Scope vendor globals away from any libraries the publisher already uses.
    return { source: `(() => { const module = undefined, exports = undefined, define = undefined, globalThis = {};\n${source}\nwindow.__pdfZipperMarkdown = { Readability, isProbablyReaderable, TurndownService: globalThis.TurndownService, tables: turndownPluginGfm.tables, convert: ${htmlToMarkdown.toString()} }; })();`, extractedBy };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
})();

interface BrowserMarkdown {
  Readability: typeof Readability;
  isProbablyReaderable(document: Document): boolean;
  TurndownService: MarkdownConstructor;
  tables: (service: MarkdownService) => void;
  convert: typeof htmlToMarkdown;
}

export async function extractMarkdown(page: Page, url: string, nitterHost: string): Promise<MarkdownExtraction | undefined> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let session: CDPSession | undefined;
  let expired = false;
  const skip = (reason: string, error?: string) => {
    console.log(JSON.stringify({ event: 'markdown_skipped', url, reason, error, ms: Date.now() - started, timestamp: new Date().toISOString() }));
    return undefined;
  };
  try {
    const targetUrl = page.url();
    const reason = markdownSkipReason(url, targetUrl, nitterHost);
    if (reason) return skip(reason);
    if (!browserLibraries.source) return skip('library_load_error', browserLibraries.error);
    const result = await Promise.race([
      (async () => {
        session = await page.context().newCDPSession(page);
        if (expired) {
          void session.detach().catch(() => {});
          return undefined;
        }
        await page.addScriptTag({ content: browserLibraries.source! });
        if (expired) return undefined;
        return page.evaluate((baseUrl) => {
          const libs = (window as unknown as { __pdfZipperMarkdown: BrowserMarkdown }).__pdfZipperMarkdown;
          // Readability destroys its input; the live page must remain printable.
          const clone = document.cloneNode(true) as Document;
          if (!libs.isProbablyReaderable(clone)) return { reason: 'not_readerable' };
          clone.querySelectorAll('base').forEach(base => base.remove());
          const base = clone.createElement('base');
          base.href = baseUrl;
          clone.head.prepend(base);
          const article = new libs.Readability(clone).parse();
          if (!article?.content) return { reason: 'readability_empty' };
          const { content, textContent: _textContent, ...readability } = article;
          return { markdown: libs.convert(content, baseUrl, libs.TurndownService, libs.tables), readability };
        }, targetUrl);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          // A Node timer alone cannot stop synchronous JS blocking Chromium's
          // renderer. Interrupt it as well so subsequent print steps can run.
          void session?.send('Runtime.terminateExecution').catch(() => {});
          reject(new Error('extraction exceeded 8000ms'));
        }, 8000);
      }),
    ]);
    if (!result) return skip('timeout');
    if ('reason' in result) return skip(result.reason!);
    if (result.markdown.length < MARKDOWN_MIN_CHARS) return skip('too_short');
    const capped = capMarkdownAtParagraph(result.markdown, markdownMaxChars(process.env.MARKDOWN_MAX_CHARS));
    if (!capped.markdown) return skip('no_paragraph_within_cap');
    const extraction = { ...capped, readability: result.readability, extractedBy: browserLibraries.extractedBy! };
    console.log(JSON.stringify({ event: 'markdown_extracted', url, chars: extraction.fullLength, truncated: extraction.truncated, ms: Date.now() - started, timestamp: new Date().toISOString() }));
    return extraction;
  } catch (error) {
    return skip(expired ? 'timeout' : 'extraction_error', error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
    void session?.detach().catch(() => {});
  }
}
