/**
 * DeCruft background service worker.
 *
 * - Seeds default settings on install.
 * - Receives per-tab "cleaned link" counts from content scripts and shows the
 *   running total as a toolbar badge so you can see DeCruft working.
 */
importScripts('cleaner.js');

const BADGE_BG = '#2176C7';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ enabled: true, disabledHosts: [] }, (cfg) => {
    chrome.storage.local.set(cfg); // no-op if already present, seeds if not
  });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'decruft:count' && sender.tab) {
    const text = msg.count > 0 ? String(msg.count) : '';
    chrome.action.setBadgeText({ tabId: sender.tab.id, text });
  }
});

// Clear the badge when a tab navigates to a fresh page.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
