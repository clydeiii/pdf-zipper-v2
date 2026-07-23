/**
 * ChatGPT share-link capture (chatgpt.com/share/<id>).
 *
 * A shared conversation is a virtualized list: only the ~6 messages nearest
 * the viewport are hydrated; the rest are empty fixed-height placeholder divs
 * that un-hydrate as you scroll away. Any print/PDF of the live page therefore
 * contains one viewport's worth of conversation and dozens of blank pages
 * (observed: a 104-message Tao conversation captured as 3 content pages + 110
 * blank). No amount of print-CSS fixing helps — the content simply isn't in
 * the DOM at print time.
 *
 * Strategy: slow-scroll the thread so every message hydrates at least once,
 * harvest each message's markdown as it appears (KaTeX nodes are replaced by
 * their original LaTeX source from the embedded <annotation> element — the
 * most faithful representation for the KB), then render our own clean HTML
 * with KaTeX and print THAT to PDF. Math renders properly, pagination is
 * clean, and the text layer carries real LaTeX.
 */

import type { Browser, Page } from 'playwright';
import { initBrowser } from '../browsers/manager.js';

export function isChatGptShareUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)chatgpt\.com$/.test(u.hostname) && /^\/share\/[\w-]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

export interface ChatGptShareResult {
  success: boolean;
  pdfBuffer?: Buffer;
  extractedText?: string;
  pageTitle?: string;
  messageCount?: number;
  error?: string;
}

interface HarvestedMessage {
  role: string;
  md: string;
  /** Index of the message's direct-child container in the thread list — the
   * conversation's true order regardless of when hydration let us see it. */
  idx: number;
}

/** In-page helpers, serialized into the browser context. */
const PAGE_HELPERS = `
  window.__cgs = window.__cgs || { seen: {}, order: [] };
  window.__cgsToMd = (msgEl) => {
    const clone = msgEl.cloneNode(true);
    clone.querySelectorAll('.katex-display').forEach(el => {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]');
      el.replaceWith(document.createTextNode('\\n$$' + (tex ? tex.textContent : el.textContent) + '$$\\n'));
    });
    clone.querySelectorAll('.katex').forEach(el => {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]');
      el.replaceWith(document.createTextNode('$' + (tex ? tex.textContent : el.textContent) + '$'));
    });
    clone.querySelectorAll('pre').forEach(el => {
      const code = el.querySelector('code');
      el.replaceWith(document.createTextNode('\\n\`\`\`\\n' + (code ? code.textContent : el.textContent) + '\\n\`\`\`\\n'));
    });
    return (clone.innerText || clone.textContent || '')
      .split('\\n')
      .filter(line => !/^(Copy code|Copy|Edit|Share)$/.test(line.trim()))
      .join('\\n')
      .replace(/Show more\\s*Show less/g, '')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
  };
  window.__cgsRoot = () => [...document.querySelectorAll('div')]
    .find(d => d.children.length > 20 && d.getBoundingClientRect().height > 5000);
  window.__cgsHarvest = () => {
    const root = window.__cgsRoot();
    if (!root) return 0;
    const kids = [...root.children];
    document.querySelectorAll('[data-message-id]').forEach(msg => {
      const id = msg.getAttribute('data-message-id');
      if (window.__cgs.seen[id] || (msg.innerText || '').length === 0) return;
      let container = msg;
      while (container.parentElement && container.parentElement !== root) container = container.parentElement;
      window.__cgs.seen[id] = {
        role: msg.getAttribute('data-message-author-role') || 'unknown',
        md: window.__cgsToMd(msg),
        idx: kids.indexOf(container),
      };
      window.__cgs.order.push(id);
    });
    return window.__cgs.order.length;
  };
  /** Thread-list child indices that hold a still-unharvested placeholder. */
  window.__cgsMissing = () => {
    const root = window.__cgsRoot();
    if (!root) return [];
    const harvestedIdx = new Set(Object.values(window.__cgs.seen).map(m => m.idx));
    return [...root.children]
      .map((k, i) => ({ i, h: k.getBoundingClientRect().height }))
      .filter(({ i, h }) => h > 50 && !harvestedIdx.has(i))
      .map(({ i }) => i);
  };
  window.__cgsScrollChildIntoView = (i) => {
    const root = window.__cgsRoot();
    if (root && root.children[i]) root.children[i].scrollIntoView({ block: 'center' });
  };
  window.__cgsScroller = () => [...document.querySelectorAll('div')]
    .find(el => el.scrollHeight > el.clientHeight + 2000 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
`;

/** Scroll the whole thread, harvesting hydrated messages. */
async function harvestConversation(page: Page): Promise<{ messages: HarvestedMessage[]; title: string }> {
  await page.evaluate(PAGE_HELPERS);

  const STEP_PX = 600;
  const DWELL_MS = 650;
  const STALL_DWELL_MS = 1400;
  const MAX_TOTAL_MS = 6 * 60 * 1000;

  const started = Date.now();
  let stalledSteps = 0;

  // Two full passes: hydration occasionally skips a block on the way down;
  // the second pass (also from the top) picks up stragglers. Harvested ids
  // persist across passes, so pass 2 is fast when pass 1 got everything.
  for (let pass = 0; pass < 2; pass++) {
    let pos = 0;
    let maxPos = await page.evaluate(() => (window as any).__cgsScroller()?.scrollHeight ?? 0);
    while (pos <= maxPos && Date.now() - started < MAX_TOTAL_MS) {
      const before = await page.evaluate(() => (window as any).__cgs.order.length);
      await page.evaluate((p) => { const s = (window as any).__cgsScroller(); if (s) s.scrollTop = p; }, pos);
      await page.waitForTimeout(stalledSteps >= 3 ? STALL_DWELL_MS : DWELL_MS);
      const after = await page.evaluate(() => (window as any).__cgsHarvest());
      stalledSteps = after > before ? 0 : stalledSteps + 1;
      pos += STEP_PX;
      // scrollHeight grows as placeholders hydrate to their real size
      maxPos = await page.evaluate(() => (window as any).__cgsScroller()?.scrollHeight ?? 0);
    }
  }

  // Mop-up: placeholders hydration skipped during the linear passes (often
  // the very last message) — target each directly and give it time.
  for (let round = 0; round < 3; round++) {
    const missing: number[] = await page.evaluate(() => (window as any).__cgsMissing());
    if (missing.length === 0) break;
    console.log(`[chatgpt-share] mop-up round ${round + 1}: ${missing.length} unhydrated block(s)`);
    for (const idx of missing) {
      if (Date.now() - started > MAX_TOTAL_MS) break;
      await page.evaluate((i) => (window as any).__cgsScrollChildIntoView(i), idx);
      await page.waitForTimeout(STALL_DWELL_MS);
      await page.evaluate(() => (window as any).__cgsHarvest());
    }
  }

  const raw = await page.evaluate(() => {
    const s = (window as any).__cgs;
    return {
      title: document.title,
      messages: s.order.map((id: string) => s.seen[id]),
      stillMissing: (window as any).__cgsMissing().length,
    };
  });
  // DOM child index is the conversation's true order — first-seen order is
  // scroll-pass order, which misplaces pass-2 stragglers at the end.
  const messages = (raw.messages as HarvestedMessage[]).sort((a, b) => a.idx - b.idx);
  if (raw.stillMissing > 0) {
    console.warn(`[chatgpt-share] ${raw.stillMissing} block(s) never hydrated — capture may be missing messages`);
  }
  if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
    console.warn('[chatgpt-share] conversation ends on a user turn — final assistant reply may be missing');
  }
  return { messages, title: raw.title };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Minimal message renderer: escaped text with code fences as <pre>, math
 * left in $/$$ delimiters for KaTeX auto-render at print time.
 */
function messageBodyHtml(md: string): string {
  // Tighten vertical rhythm: blank lines hugging a display-math block double
  // up with .katex-display margins and read as huge gaps in print.
  // Replacer FUNCTIONS are load-bearing: in a replacement *string*, "$$" is
  // the escape for one literal "$" — the string form silently rewrote every
  // display delimiter to a single "$", breaking KaTeX ($-inline math can't
  // hold \tag) and leaking raw LaTeX into the PDF.
  const tightened = md.replace(/\n+\$\$/g, () => '\n$$').replace(/\$\$\n+/g, () => '$$\n');
  const parts = tightened.split(/```/);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? `<pre class="code">${escapeHtml(part.trim())}</pre>`
        : `<div class="prose">${escapeHtml(part)}</div>`
    )
    .join('');
}

function buildHtml(title: string, url: string, messages: HarvestedMessage[]): string {
  // ChatGPT's own visual language: user turns as right-aligned gray bubbles
  // (no label needed — the bubble is the signal), assistant turns as plain
  // full-width text.
  const body = messages
    .map((m) =>
      m.role === 'user'
        ? `<section class="msg user"><div class="bubble">${messageBodyHtml(m.md)}</div></section>`
        : `<section class="msg assistant">${messageBodyHtml(m.md)}</section>`
    )
    .join('\n');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 11px; line-height: 1.6; color: #0d0d0d; max-width: 700px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 2px; }
  .meta { color: #8f8f8f; font-size: 9.5px; margin-bottom: 26px; word-break: break-all; }
  .msg { margin-bottom: 22px; }
  .msg.user { display: flex; justify-content: flex-end; break-inside: avoid-page; }
  .msg.user .bubble { background: #f3f3f3; border-radius: 18px; padding: 9px 16px; max-width: 82%; }
  .prose { white-space: pre-wrap; }
  .code { background: #f9f9f9; border: 1px solid #ececec; border-radius: 12px; padding: 10px 12px; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 9px; white-space: pre-wrap; word-break: break-word; }
  .katex-display { overflow-x: hidden; margin: 0.4em 0; }
  .katex { font-size: 1.02em; }
</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">Shared ChatGPT conversation · ${escapeHtml(url)} · ${messages.length} messages</div>
${body}
<script>
  window.__renderDone = false;
  document.addEventListener("DOMContentLoaded", () => {
    try {
      renderMathInElement(document.body, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    } catch (e) { /* KaTeX unavailable — LaTeX source remains visible */ }
    window.__renderDone = true;
  });
</script>
</body></html>`;
}

/**
 * Capture a ChatGPT share conversation to PDF.
 * Returns success:false (never throws) when the page can't be loaded or no
 * messages hydrate — callers fall back to the regular conversion path.
 */
export async function captureChatGptShare(url: string): Promise<ChatGptShareResult> {
  const browser: Browser = await initBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const hasMessages = await page.evaluate(() => document.querySelectorAll('[data-message-id]').length);
    if (hasMessages === 0) {
      return { success: false, error: 'no conversation messages found on share page (wall or layout change?)' };
    }

    const { messages, title } = await harvestConversation(page);
    if (messages.length === 0) {
      return { success: false, error: 'harvest found no hydrated messages' };
    }
    console.log(`[chatgpt-share] harvested ${messages.length} messages (${messages.reduce((a, m) => a + m.md.length, 0)} chars) from ${url}`);

    // Render our own clean document and print it
    const renderPage = await ctx.newPage();
    await renderPage.setContent(buildHtml(title, url, messages), { waitUntil: 'networkidle' });
    await renderPage.waitForFunction('window.__renderDone === true', { timeout: 20000 }).catch(() => {
      console.warn('[chatgpt-share] KaTeX render timeout — printing with raw LaTeX');
    });
    await renderPage.waitForTimeout(500);
    const pdfBuffer = await renderPage.pdf({
      format: 'A4',
      margin: { top: '14mm', bottom: '14mm', left: '13mm', right: '13mm' },
      printBackground: true,
    });

    const extractedText = messages.map((m) => `[${m.role}]\n${m.md}`).join('\n\n');
    return {
      success: true,
      pdfBuffer: Buffer.from(pdfBuffer),
      extractedText,
      pageTitle: title.replace(/\s*\|\s*ChatGPT.*$/i, '').trim() || title,
      messageCount: messages.length,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await ctx.close().catch(() => {});
  }
}
