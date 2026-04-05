/**
 * Service worker for PDF Zipper Capture.
 *
 * Flow when user clicks the toolbar icon:
 *   1. Inject content script if not already present
 *   2. Ask content script to prepare the page (hide floating junk) and
 *      return { url, title, originalUrl }
 *   3. Attach chrome.debugger to the tab, call Page.printToPDF to get
 *      clean PDF bytes, detach debugger
 *   4. Tell content script to restore the page
 *   5. POST base64 PDF + metadata to the pdf-zipper-v2 manual-capture
 *      endpoint. The CF_Authorization cookie (Cloudflare Access) is
 *      sent automatically thanks to host_permissions + credentials:include
 *   6. Show a Chrome notification with the result
 *
 * If Cloudflare Access returns an HTML login redirect (because the user
 * isn't authed in Chrome yet), we detect it by content-type and prompt
 * the user to visit the site to re-auth.
 */

const SERVER_ENDPOINT = 'https://pdf.clydeplex.com/api/manual-capture';

// ============================================================
// Context menu registration
// ============================================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pdfzipper-capture-page',
      title: 'Capture page to PDF Zipper',
      contexts: ['page', 'frame'],
    });
    chrome.contextMenus.create({
      id: 'pdfzipper-capture-selection',
      title: 'Capture selection to PDF Zipper',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === 'pdfzipper-capture-page' || info.menuItemId === 'pdfzipper-capture-selection') {
    captureTab(tab);
  }
});

// ============================================================
// Toolbar click handler + keyboard shortcut
// ============================================================
chrome.action.onClicked.addListener((tab) => captureTab(tab));

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await captureTab(tab);
});

async function captureTab(tab) {
  if (!tab.id) return;
  const tabUrl = tab.url || '';
  console.log('[pdfzipper v3.2.1] captureTab called. tab.url =', JSON.stringify(tabUrl), 'tab.id =', tab.id);

  // Clear any stale badge from the previous capture before we start.
  // (MV3 service worker termination can strand setTimeout-based clears,
  // so we don't rely on scheduled clears — clear at next click instead.)
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
  chrome.action.setTitle({ title: 'Capture to PDF Zipper (Alt+Shift+Z)' }).catch(() => {});

  // Only http/https pages can be captured. chrome://, chrome-extension://, about:,
  // view-source:, file:, devtools:, etc. all fail when injecting content scripts.
  const isCapturable =
    tabUrl.startsWith('http://') || tabUrl.startsWith('https://');
  if (!isCapturable) {
    const shortUrl = tabUrl.slice(0, 60) || '(no URL)';
    console.warn('[pdfzipper] Not capturable:', shortUrl);
    await notify(
      'Cannot capture this page',
      `Only http/https pages work. Current: ${shortUrl}`,
      'error'
    );
    return;
  }

  let debuggerAttached = false;
  let step = 'init';
  try {
    step = '1: ensureContentScript';
    console.log(`[pdfzipper] step ${step}`);
    await ensureContentScript(tab.id);

    step = '2: sendToContentScript(prepare-capture)';
    console.log(`[pdfzipper] step ${step}`);
    const pageInfo = await sendToContentScript(tab.id, { action: 'prepare-capture' });
    if (!pageInfo || !pageInfo.url) {
      throw new Error('Could not extract page metadata');
    }

    step = '3: chrome.debugger.attach';
    console.log(`[pdfzipper] step ${step}`);
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    debuggerAttached = true;

    step = '3b: sleep + printToPDF';
    console.log(`[pdfzipper] step ${step}`);
    // Give the browser a moment to apply the floating-element CSS
    await sleep(200);

    // Page.printToPDF params — match pdf-zipper-v2's server-side settings:
    //   A4 paper (8.27" × 11.69"), ~20px margins (0.21"), scale 0.7, backgrounds on
    const pdfResult = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Page.printToPDF',
      {
        printBackground: true,
        preferCSSPageSize: false,
        paperWidth: 8.27,
        paperHeight: 11.69,
        marginTop: 0.21,
        marginBottom: 0.21,
        marginLeft: 0.21,
        marginRight: 0.21,
        scale: 0.7,
        transferMode: 'ReturnAsBase64',
      }
    );

    await chrome.debugger.detach({ tabId: tab.id });
    debuggerAttached = false;

    // 4. Restore page (best-effort)
    try {
      await sendToContentScript(tab.id, { action: 'finish-capture' });
    } catch (e) {
      // Tab may have navigated away — not fatal
    }

    if (!pdfResult || !pdfResult.data) {
      throw new Error('Page.printToPDF returned no data');
    }

    // 5. POST to server
    await notify('Capturing…', `Uploading ${pageInfo.title || 'page'} to pdf-zipper-v2`, 'progress');

    const uploadResult = await uploadCapture({
      url: pageInfo.url,
      title: pageInfo.title,
      originalUrl: pageInfo.originalUrl || undefined,
      pdfBase64: pdfResult.data,
      markdown: pageInfo.markdown || undefined,
      readability: pageInfo.readability || undefined,
      captureScope: pageInfo.captureScope || 'page',
      selectionChars: pageInfo.selectionChars,
      selectionPreview: pageInfo.selectionPreview,
      extensionVersion: chrome.runtime.getManifest().version,
    });

    // 6. Notify success
    if (uploadResult.success) {
      const removed = uploadResult.removedFailedJobs
        ? ` · cleared ${uploadResult.removedFailedJobs} failed job(s)`
        : '';
      const lang = uploadResult.metadata?.language && uploadResult.metadata.language !== 'en'
        ? ` [${uploadResult.metadata.language}]`
        : '';
      const scope = pageInfo.captureScope === 'selection'
        ? ` · selection (${pageInfo.selectionChars} chars)`
        : '';
      await notify(
        'PDF Zipper: saved ✓',
        `${uploadResult.filename}${lang}${scope}${removed}`,
        'success'
      );
    } else {
      throw new Error(uploadResult.error || 'Upload failed');
    }
  } catch (error) {
    console.error(`[pdfzipper] Capture failed at step "${step}":`, error);

    // Always detach debugger on error
    if (debuggerAttached) {
      try { await chrome.debugger.detach({ tabId: tab.id }); } catch (e) { /* ignore */ }
    }
    // Try to restore the page
    try { await sendToContentScript(tab.id, { action: 'finish-capture' }); } catch (e) { /* ignore */ }

    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('AUTH_REQUIRED')) {
      await notify(
        'PDF Zipper: auth required',
        'Visit https://pdf.clydeplex.com in a tab to re-authenticate, then try again.',
        'error'
      );
    } else {
      await notify('PDF Zipper: failed', message, 'error');
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureContentScript(tabId) {
  try {
    // Probe: if the content script is loaded, it'll respond
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch (e) {
    const probeMsg = e.message || String(e);
    console.log('[pdfzipper] ping failed, will inject:', probeMsg);
    if (probeMsg.includes('different extension') || probeMsg.includes('chrome-extension://')) {
      throw new Error(
        'Cannot capture — this tab is rendered by another extension (Chrome\'s PDF viewer, a reader extension, etc.). Try an HTML page.'
      );
    }
    // Inject it
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['print.css'],
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['vendor/Readability.js', 'vendor/turndown.js', 'content.js'],
      });
      await sleep(100);
    } catch (injectError) {
      const msg = injectError.message || String(injectError);
      // Chrome's built-in PDF viewer (and some other extensions) own the tab's
      // rendering context, so content scripts can't be injected there.
      if (msg.includes('different extension') || msg.includes('chrome-extension://')) {
        throw new Error(
          'Cannot capture — this tab is rendered by another extension (likely Chrome\'s PDF viewer). Try capturing an HTML page instead.'
        );
      }
      throw new Error(`Cannot inject content script: ${msg}`);
    }
  }
}

function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function uploadCapture(payload) {
  let response;
  try {
    response = await fetch(SERVER_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(`Network error: ${error.message}`);
  }

  const contentType = response.headers.get('content-type') || '';

  // Cloudflare Access returns HTML (Google OAuth redirect) if unauthed
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    if (/cloudflare|access|authenticate|sign in/i.test(text)) {
      throw new Error('AUTH_REQUIRED');
    }
    throw new Error(`Unexpected response (${response.status}): ${text.slice(0, 200)}`);
  }

  const json = await response.json();

  if (!response.ok) {
    throw new Error(json.error || `Server returned ${response.status}`);
  }

  return json;
}

// ============================================================
// User feedback: badge (always visible) + notifications (if permitted)
// ============================================================
async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) { /* ignore */ }
}

async function setBadgeTitle(title) {
  try { await chrome.action.setTitle({ title }); } catch (e) { /* ignore */ }
}

async function notify(title, message, kind = 'info') {
  // Log loudly — user can always check service worker console
  const prefix = kind === 'error' ? '[pdfzipper ERROR]' : kind === 'success' ? '[pdfzipper OK]' : '[pdfzipper]';
  console.log(`${prefix} ${title}: ${message}`);

  // Badge indicator. Persists until next capture starts (clears on next click).
  // MV3 service worker termination makes setTimeout-based clears unreliable,
  // so we don't schedule fades — each new capture wipes the previous badge.
  if (kind === 'success') {
    await setBadge('✓', '#22c55e');
    await setBadgeTitle(`${title} — ${message}`);
  } else if (kind === 'error') {
    await setBadge('!', '#ef4444');
    await setBadgeTitle(`${title} — ${message}`);
  } else if (kind === 'progress') {
    await setBadge('…', '#3b82f6');
    await setBadgeTitle(`${title} — ${message}`);
  }

  // Try macOS/OS notification (may silently fail if permission not granted)
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: kind === 'error' ? 2 : 0,
    });
  } catch (e) { /* ignore */ }
}

// Respond to ping messages from ensureContentScript (so the probe succeeds
// if we re-injected content.js). Note: content.js doesn't handle 'ping',
// but if it's loaded, sendMessage will succeed with undefined response
// which is enough to satisfy the probe.
// (Actually content.js's listener returns nothing for unknown actions,
// so sendMessage resolves and no injection happens — correct behavior.)
