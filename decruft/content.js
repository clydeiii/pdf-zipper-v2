/**
 * DeCruft content script.
 *
 * Goal: when you click a link (left click, middle-click / Ctrl-click "open in new
 * tab", or context-menu "open in new tab"), the destination is the canonical URL
 * with tracking cruft stripped.
 *
 * Strategy:
 *   1. Rewrite every <a href> in the DOM to its cleaned form on load, and again
 *      whenever the DOM mutates (covers SPA-rendered links). The browser's own
 *      open-in-new-tab uses the live href, so this is what does the real work.
 *   2. A capture-phase pointerdown/auxclick/contextmenu safety net re-cleans the
 *      specific anchor just before activation, in case its href was set moments
 *      earlier by a framework.
 *
 * Honors an enable flag (global + per-host) from chrome.storage.local.
 */
(() => {
  'use strict';
  if (window.__deCruftLoaded) return;
  window.__deCruftLoaded = true;

  const clean = (raw) => self.DeCruft.cleanUrl(raw, location.href);
  const host = location.hostname.toLowerCase();

  let enabled = true;
  let cleanedCount = 0;

  function reportCount() {
    try {
      chrome.runtime.sendMessage({ type: 'decruft:count', count: cleanedCount });
    } catch (e) { /* service worker asleep / context gone */ }
  }

  // Rewrite a single anchor in place. Returns true if it changed.
  function fixAnchor(a) {
    const raw = a.getAttribute('href');
    if (!raw || raw[0] === '#') return false; // skip empty / pure fragments
    const abs = a.href; // browser-resolved absolute form
    if (!abs || (!abs.startsWith('http://') && !abs.startsWith('https://'))) return false;
    const cleaned = clean(abs);
    if (cleaned === abs) return false;
    a.href = cleaned;
    a.dataset.decruft = '1';
    cleanedCount++;
    return true;
  }

  function sweep(root) {
    if (!enabled) return;
    let changed = 0;
    for (const a of (root || document).querySelectorAll('a[href]')) {
      if (fixAnchor(a)) changed++;
    }
    if (changed) reportCount();
  }

  // ---- Safety net: clean the clicked anchor just-in-time ----
  function nearestAnchor(node) {
    while (node && node !== document) {
      if (node.tagName === 'A' && node.hasAttribute('href')) return node;
      node = node.parentNode;
    }
    return null;
  }
  function justInTime(e) {
    if (!enabled) return;
    const a = nearestAnchor(e.target);
    if (a) fixAnchor(a);
  }

  // ---- MutationObserver for dynamically added/changed links ----
  let pending = false;
  const observer = new MutationObserver((mutations) => {
    if (!enabled || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      let changed = 0;
      for (const m of mutations) {
        if (m.type === 'attributes' && m.target.tagName === 'A') {
          if (fixAnchor(m.target)) changed++;
        } else if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'A' && n.hasAttribute('href')) {
              if (fixAnchor(n)) changed++;
            } else if (n.querySelectorAll) {
              for (const a of n.querySelectorAll('a[href]')) if (fixAnchor(a)) changed++;
            }
          }
        }
      }
      if (changed) reportCount();
    });
  });

  // ---- Address-bar cleaning ----
  // Covers the case where you LAND on a crufted URL (e.g. an email "open" link
  // that server-redirects to https://site/post?utm_*&publication_id=...). The
  // cruft is then in the address bar, not in a page <a href>, so link rewriting
  // can't reach it. We strip it with history.replaceState — same-origin, no
  // reload, and only known trackers are removed, so SPA routing is unaffected.
  let lastSeen = '';
  function cleanAddressBar() {
    if (!enabled || window.top !== window) return; // top frame only
    if (location.href === lastSeen) return;        // already handled this URL
    const cleaned = clean(location.href);
    if (cleaned !== location.href) {
      try {
        history.replaceState(history.state, '', cleaned);
      } catch (e) { /* opaque origin / blocked — leave it */ }
    }
    lastSeen = location.href;
  }

  function start() {
    cleanAddressBar();
    sweep(document);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['href'],
    });
    // pointerdown fires before navigation for all click types incl. middle-click.
    document.addEventListener('pointerdown', justInTime, true);
    document.addEventListener('auxclick', justInTime, true);
    document.addEventListener('contextmenu', justInTime, true);
    // SPA client-side navigations can add cruft after load.
    window.addEventListener('popstate', cleanAddressBar);
    window.addEventListener('load', cleanAddressBar);
  }

  const STORAGE_DEFAULTS = { enabled: true, disabledHosts: [] };
  function computeEnabled(cfg) {
    return cfg.enabled !== false && !(cfg.disabledHosts || []).includes(host);
  }

  // Resolve enabled state, then go.
  chrome.storage.local.get(STORAGE_DEFAULTS, (cfg) => {
    enabled = computeEnabled(cfg);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  });

  // React to popup toggles without a page reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    chrome.storage.local.get(STORAGE_DEFAULTS, (cfg) => {
      const now = computeEnabled(cfg);
      const wasOff = !enabled;
      enabled = now;
      if (now && wasOff) sweep(document); // re-sweep when freshly re-enabled
    });
  });
})();
