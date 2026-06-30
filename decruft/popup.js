/**
 * DeCruft popup — global on/off, per-site on/off, and this-tab cleaned count.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const globalToggle = $('globalToggle');
  const siteToggle = $('siteToggle');
  const hostNameEl = $('hostName');
  const countEl = $('count');

  let host = '';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    try { host = new URL(tab.url).hostname.toLowerCase(); } catch (e) { host = ''; }
    hostNameEl.textContent = host || 'this site';

    chrome.action.getBadgeText({ tabId: tab.id }, (t) => {
      countEl.textContent = t && /^\d+$/.test(t) ? t : '0';
    });

    chrome.storage.local.get({ enabled: true, disabledHosts: [] }, (cfg) => {
      globalToggle.checked = cfg.enabled !== false;
      siteToggle.checked = !(cfg.disabledHosts || []).includes(host);
      siteToggle.disabled = !host;
    });
  });

  globalToggle.addEventListener('change', () => {
    chrome.storage.local.set({ enabled: globalToggle.checked });
  });

  siteToggle.addEventListener('change', () => {
    if (!host) return;
    chrome.storage.local.get({ disabledHosts: [] }, (cfg) => {
      const set = new Set(cfg.disabledHosts || []);
      if (siteToggle.checked) set.delete(host);
      else set.add(host);
      chrome.storage.local.set({ disabledHosts: [...set] });
    });
  });
})();
