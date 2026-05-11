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
  // Selection handling — when user has text selected, we capture only
  // that portion by hiding every DOM node outside the selection's
  // common-ancestor lineage. The selection HTML is also used directly
  // for Markdown extraction (no Readability — keep exactly what the
  // user highlighted).
  // ============================================================
  const selectionHiddenElements = [];

  function getSelectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.toString().trim().length < 3) return null; // ignore trivial/accidental selections
    return range;
  }

  /**
   * Walk up from the selection's common ancestor, hiding every sibling
   * at each level. Result: only the subtree containing the selection
   * stays visible for printToPDF.
   */
  function hideOutsideSelection(range) {
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) container = container.parentElement;
    if (!container || !container.parentElement) return false;

    selectionHiddenElements.length = 0;
    let node = container;
    while (node && node.parentElement && node !== document.documentElement) {
      const parent = node.parentElement;
      for (let i = 0; i < parent.children.length; i++) {
        const sibling = parent.children[i];
        if (sibling !== node && !sibling.classList.contains('pdfzipper-hide')) {
          sibling.classList.add('pdfzipper-hide');
          selectionHiddenElements.push(sibling);
        }
      }
      node = parent;
    }
    return true;
  }

  function restoreOutsideSelection() {
    for (const el of selectionHiddenElements) {
      el.classList.remove('pdfzipper-hide');
    }
    selectionHiddenElements.length = 0;
  }

  /** Turn a selection range into clean Markdown via Turndown (no Readability). */
  function selectionToMarkdown(range) {
    if (typeof TurndownService === 'undefined') return null;
    try {
      const fragment = range.cloneContents();
      const wrapper = document.createElement('div');
      wrapper.appendChild(fragment);
      const td = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '_',
        strongDelimiter: '**',
      });
      td.addRule('lineBreak', { filter: 'br', replacement: () => '  \n' });
      return td.turndown(wrapper.innerHTML);
    } catch (e) {
      console.warn('[pdfzipper] selectionToMarkdown failed:', e);
      return null;
    }
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

      let style;
      try { style = getComputedStyle(el); } catch (e) { continue; }

      // 1) Fixed/sticky elements (nav bars, cookie banners, etc.)
      if (style.position === 'fixed' || style.position === 'sticky') {
        const rect = el.getBoundingClientRect();
        // Skip full-page wrappers (some sites wrap everything in position:fixed for scroll effects)
        if (rect.width * rect.height > viewportArea * 0.75) continue;
        el.classList.add('pdfzipper-hide');
        markedElements.push(el);
        continue;
      }

      // 2) Large decorative blobs — elements with border-radius >= 50%, large
      //    area, and no meaningful text content. Sites like beehiiv, Substack,
      //    and many newsletters use enormous CSS circles/ellipses for visual
      //    flair that render fine on-screen (overflow:hidden) but explode in
      //    print/PDF, obscuring article content.
      const br = style.borderRadius;
      const isRound = br && (br.includes('50%') || br.includes('9999') || br === '100%');
      if (isRound) {
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        const textLen = (el.textContent || '').trim().length;
        // Large (>25% viewport), round, and no text → decorative blob
        if (area > viewportArea * 0.25 && textLen < 20) {
          el.classList.add('pdfzipper-hide');
          markedElements.push(el);
          continue;
        }
      }

      // 3) Absolutely-positioned oversized decorative elements (catches blobs
      //    without border-radius, e.g. rotated squares, gradient overlays).
      //    Must be: absolute/fixed, larger than viewport, mostly empty.
      if (style.position === 'absolute') {
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        const textLen = (el.textContent || '').trim().length;
        if (area > viewportArea * 1.5 && textLen < 20) {
          el.classList.add('pdfzipper-hide');
          markedElements.push(el);
          continue;
        }
      }
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
  // Readability extraction — used for both Markdown and reader-mode
  // DOM swap (clean PDF capture without decorative cruft)
  // ============================================================
  function parseReadability() {
    if (typeof Readability === 'undefined') return null;
    try {
      const docClone = document.cloneNode(true);
      const article = new Readability(docClone).parse();
      if (!article || !article.content) return null;
      return article;
    } catch (error) {
      console.warn('[pdfzipper] Readability parse failed:', error);
      return null;
    }
  }

  function articleToMarkdown(articleHtml) {
    if (typeof TurndownService === 'undefined') return null;
    try {
      const td = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '_',
        strongDelimiter: '**',
      });
      td.addRule('lineBreak', { filter: 'br', replacement: () => '  \n' });
      return td.turndown(articleHtml);
    } catch (error) {
      console.warn('[pdfzipper] Turndown failed:', error);
      return null;
    }
  }

  function readabilityMeta(article) {
    return {
      title: article.title || null,
      byline: article.byline || null,
      siteName: article.siteName || null,
      lang: article.lang || null,
      publishedTime: article.publishedTime || null,
      excerpt: article.excerpt || null,
      length: article.length || 0,
    };
  }

  // ============================================================
  // Reader-mode DOM swap — replace page body with clean article
  // so Page.printToPDF captures ONLY article text + images. No
  // decorative blobs, navs, ads, sidebars, cookie banners, etc.
  // ============================================================
  let savedBodyHTML = null;
  let savedBodyClass = null;

  function enterReaderMode(article) {
    savedBodyHTML = document.body.innerHTML;
    savedBodyClass = document.body.className;

    // Escape title for safe insertion
    const escTitle = (article.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escByline = (article.byline || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    document.body.className = '';
    document.body.innerHTML = [
      '<div style="max-width:720px; margin:0 auto; padding:40px 20px; font-family:Georgia,Times,serif; font-size:16px; line-height:1.7; color:#1a1a1a;">',
      `  <h1 style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:28px; line-height:1.3; margin:0 0 8px;">${escTitle}</h1>`,
      escByline ? `  <p style="color:#666; font-size:14px; margin:0 0 24px;">${escByline}</p>` : '',
      '  <article>',
      article.content,
      '  </article>',
      '</div>',
    ].join('\n');
    return true;
  }

  function exitReaderMode() {
    if (savedBodyHTML !== null) {
      document.body.innerHTML = savedBodyHTML;
      document.body.className = savedBodyClass || '';
      savedBodyHTML = null;
      savedBodyClass = null;
    }
  }

  // ============================================================
  // Capture lifecycle (controlled by background worker)
  // ============================================================
  function prepareCapture() {
    document.documentElement.classList.add('pdfzipper-capturing');

    // Selection path: user highlighted some text → capture ONLY that
    const selRange = getSelectionRange();
    if (selRange) {
      const hidOk = hideOutsideSelection(selRange);
      if (hidOk) {
        const selMarkdown = selectionToMarkdown(selRange);
        const selText = selRange.toString().trim();
        return {
          url: location.href,
          title: getBestTitle(),
          originalUrl: getOriginalUrl(),
          markdown: selMarkdown,
          readability: null,
          captureScope: 'selection',
          selectionChars: selText.length,
          selectionPreview: selText.slice(0, 120),
        };
      }
    }

    // Full-page capture (default): hide floating/decorative elements, extract
    // Markdown via Readability separately (the page DOM stays intact so images
    // and layout are preserved in the PDF).
    hideFloatingElements();
    const article = parseReadability();
    const markdown = article ? articleToMarkdown(article.content) : null;
    const readability = article ? readabilityMeta(article) : null;
    return {
      url: location.href,
      title: (article && article.title) || getBestTitle(),
      originalUrl: getOriginalUrl(),
      markdown,
      readability,
      captureScope: 'page',
    };
  }

  function finishCapture() {
    exitReaderMode();
    restoreOutsideSelection();
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
