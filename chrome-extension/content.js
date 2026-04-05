/**
 * Content script for PDF Zipper Capture.
 *
 * Runs on every page. Responds to messages from the background service
 * worker to (a) extract page metadata before capture, (b) mark floating
 * elements for hiding via CSS classes, and (c) restore the page after.
 *
 * This script does NOT print. The background worker drives
 * chrome.debugger Page.printToPDF.
 */
(() => {
  'use strict';

  if (window.__pdfZipperCaptureLoaded) return;
  window.__pdfZipperCaptureLoaded = true;

  // ============================================================
  // Archive.is original-URL extraction
  // ============================================================
  function isArchiveSite() {
    return /^archive\.(is|today|ph|li|vn|fo|md)$/.test(location.hostname);
  }

  function getOriginalUrl() {
    if (!isArchiveSite()) return null;

    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) {
      const m = canonical.href.match(/archive\.[^/]+\/[\d.]+-\d+\/(https?:\/\/.+)/);
      if (m) return m[1];
    }
    const bookmark = document.querySelector('link[rel="bookmark"]');
    if (bookmark) {
      const m = bookmark.href.match(/archive\.[^/]+\/\d+\/(https?:\/\/.+)/);
      if (m) return m[1];
    }
    const input = document.querySelector('#HEADER input[name="q"]');
    if (input && input.value) return input.value;
    return null;
  }

  // ============================================================
  // Title extraction — prefer article h1 over document.title
  // ============================================================
  function getBestTitle() {
    // Prefer <h1> in article content
    const h1s = document.querySelectorAll('h1');
    for (const h1 of h1s) {
      if (h1.closest('#HEADER, #DIVSHARE, nav, [role="banner"], [role="navigation"]')) continue;
      const text = h1.textContent.trim();
      if (text.length > 10 && text.length < 300) return text;
    }

    // og:title
    const og = document.querySelector('meta[property="og:title"]');
    if (og) {
      const content = og.getAttribute('content')?.trim();
      if (content && content.length > 10) {
        return content.replace(/\s*[|\u2013\u2014]\s*[^|\u2013\u2014]*$/, '').trim();
      }
    }

    // Fallback: document.title with publication suffix stripped
    return document.title.replace(/\s*[|\u2013\u2014-]\s*[^|\u2013\u2014-]*$/, '').trim() || document.title;
  }

  // ============================================================
  // Floating element cleanup (marks for CSS to hide)
  // ============================================================
  const markedElements = [];

  function hideFloatingElements() {
    markedElements.length = 0;
    const viewportArea = window.innerWidth * window.innerHeight;
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el === document.documentElement || el === document.body) continue;
      let pos;
      try { pos = getComputedStyle(el).position; } catch (e) { continue; }
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width * rect.height > viewportArea * 0.75) continue;
      el.classList.add('pdfzipper-hide');
      markedElements.push(el);
    }

    if (isArchiveSite()) {
      document.querySelectorAll('#HEADER, #DIVSHARE').forEach(el => {
        if (!el.classList.contains('pdfzipper-hide')) {
          el.classList.add('pdfzipper-hide');
          markedElements.push(el);
        }
      });
    }
  }

  function restoreFloatingElements() {
    for (const el of markedElements) {
      el.classList.remove('pdfzipper-hide');
    }
    markedElements.length = 0;
  }

  // ============================================================
  // Readability + Turndown → Markdown extraction
  // (Obsidian Web Clipper pattern: reader-mode HTML → clean Markdown)
  // ============================================================
  function extractMarkdown() {
    if (typeof Readability === 'undefined' || typeof TurndownService === 'undefined') {
      return { markdown: null, readability: null };
    }
    try {
      // Readability mutates the document it parses, so clone first
      const docClone = document.cloneNode(true);
      const article = new Readability(docClone).parse();
      if (!article || !article.content) {
        return { markdown: null, readability: null };
      }

      const td = new TurndownService({
        headingStyle: 'atx',       // # H1, ## H2 (not underline style)
        codeBlockStyle: 'fenced',  // ```lang vs indent
        bulletListMarker: '-',
        emDelimiter: '_',
        strongDelimiter: '**',
      });

      // Keep line breaks inside paragraphs rather than collapsing
      td.addRule('lineBreak', {
        filter: 'br',
        replacement: () => '  \n',
      });

      const markdown = td.turndown(article.content);
      return {
        markdown,
        readability: {
          title: article.title || null,
          byline: article.byline || null,
          siteName: article.siteName || null,
          lang: article.lang || null,
          publishedTime: article.publishedTime || null,
          excerpt: article.excerpt || null,
          length: article.length || 0,
        },
      };
    } catch (error) {
      console.warn('[pdfzipper] Readability/Turndown failed:', error);
      return { markdown: null, readability: null };
    }
  }

  // ============================================================
  // Capture lifecycle (controlled by background worker)
  // ============================================================
  function prepareCapture() {
    document.documentElement.classList.add('pdfzipper-capturing');
    hideFloatingElements();
    const { markdown, readability } = extractMarkdown();
    return {
      url: location.href,
      title: getBestTitle(),
      originalUrl: getOriginalUrl(),
      markdown,
      readability,
    };
  }

  function finishCapture() {
    restoreFloatingElements();
    document.documentElement.classList.remove('pdfzipper-capturing');
  }

  // ============================================================
  // Message handler
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'ping') {
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === 'prepare-capture') {
      sendResponse(prepareCapture());
      return true;
    }
    if (msg.action === 'finish-capture') {
      finishCapture();
      sendResponse({ ok: true });
      return true;
    }
  });
})();
