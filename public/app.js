/**
 * PDF Zipper Frontend Application
 * Handles week browsing, file selection, and ZIP downloads
 */

// State management
let currentWeekId = null;
let selectedFiles = new Set();
let allItems = [];        // Store full dataset for filtering
let currentFilter = '';   // Current filter string
let filterDebounceTimer = null;
let apiToken = localStorage.getItem('pdfzipperApiToken') || '';

// Export tracking — remembers last ZIP download per week
function getLastExportTime(weekId) {
  const exports = JSON.parse(localStorage.getItem('pdfzipperExports') || '{}');
  return exports[weekId] || null;
}
function setLastExportTime(weekId, isoDate) {
  const exports = JSON.parse(localStorage.getItem('pdfzipperExports') || '{}');
  exports[weekId] = isoDate;
  localStorage.setItem('pdfzipperExports', JSON.stringify(exports));
}
function isNewSinceExport(item) {
  if (!currentWeekId) return false;
  const lastExport = getLastExportTime(currentWeekId);
  if (!lastExport) return true; // Never exported = everything is new
  return new Date(item.modified) > new Date(lastExport);
}

// Click telemetry — tracks user interactions for self-healing insights
// When the user clicks source links, PDFs, error badges, or archive links,
// it signals manual intervention (paywall bypass, quality review, etc.)
const TELEMETRY_KEY = 'pdfzipperTelemetry';
const TELEMETRY_MAX_ENTRIES = 500;

function recordClick(action, url, extra = {}) {
  const entry = {
    action,       // 'view_pdf' | 'view_source' | 'view_error' | 'view_archive'
    url,
    weekId: currentWeekId,
    timestamp: new Date().toISOString(),
    ...extra,
  };

  // Save locally
  const entries = JSON.parse(localStorage.getItem(TELEMETRY_KEY) || '[]');
  entries.push(entry);
  // Cap at max entries (keep most recent)
  if (entries.length > TELEMETRY_MAX_ENTRIES) {
    entries.splice(0, entries.length - TELEMETRY_MAX_ENTRIES);
  }
  localStorage.setItem(TELEMETRY_KEY, JSON.stringify(entries));

  // Fire-and-forget POST to server
  fetch('/api/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(entry),
  }).catch(() => {}); // Silent fail — telemetry is best-effort
}

// DOM elements
const weeksView = document.getElementById('weeks-view');
const filesView = document.getElementById('files-view');
const weeksList = document.getElementById('weeks-list');
const weekTitle = document.getElementById('week-title');
const filesTbody = document.getElementById('files-tbody');
const selectAllCheckbox = document.getElementById('select-all');
const downloadButton = document.getElementById('download-button');
const rerunButton = document.getElementById('rerun-button');
const rerunSelectedButton = document.getElementById('rerun-selected-button');
const deleteButton = document.getElementById('delete-button');
const fixButton = document.getElementById('fix-button');
const backButton = document.getElementById('back-button');
const statusMessage = document.getElementById('status-message');
const filterInput = document.getElementById('filter-input');
const filterClear = document.getElementById('filter-clear');
const filterStatus = document.getElementById('filter-status');
const fixCenterButton = document.getElementById('fix-center-btn');
const apiTokenButton = document.getElementById('api-token-btn');
const selectNewButton = document.getElementById('select-new-button');
const exportStatus = document.getElementById('export-status');

// Initialize app on page load
document.addEventListener('DOMContentLoaded', () => {
  loadWeeks();
  setupEventListeners();
});

/**
 * Set up global event listeners
 */
function setupEventListeners() {
  backButton.addEventListener('click', showWeeks);
  selectAllCheckbox.addEventListener('change', handleSelectAll);
  downloadButton.addEventListener('click', downloadSelected);
  rerunButton.addEventListener('click', rerunAll);
  rerunSelectedButton.addEventListener('click', rerunSelected);
  deleteButton.addEventListener('click', deleteSelected);
  fixButton.addEventListener('click', fixSelected);
  filterInput.addEventListener('input', handleFilterInput);
  filterClear.addEventListener('click', clearFilter);
  selectNewButton.addEventListener('click', selectNewSinceExport);

  // Click telemetry via event delegation on the file table
  filesTbody.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) return;

    const href = link.getAttribute('href') || '';
    const classes = link.className || '';

    if (classes.includes('file-link')) {
      recordClick('view_pdf', href);
    } else if (classes.includes('source-link')) {
      recordClick('view_source', href);
    } else if (classes.includes('archive-link')) {
      recordClick('view_archive', href);
    } else if (classes.includes('badge-failed-link')) {
      recordClick('view_error', href, { error: link.querySelector('.badge-failed')?.dataset?.tooltip });
    } else if (classes.includes('failed-url')) {
      recordClick('view_failed_url', href);
    }
  });

  if (fixCenterButton) {
    fixCenterButton.addEventListener('click', openFixCenterModal);
  }
  if (apiTokenButton) {
    apiTokenButton.addEventListener('click', promptForApiToken);
  }
}

function getAuthHeaders(extra = {}) {
  const headers = { ...extra };
  if (apiToken) {
    headers['x-api-token'] = apiToken;
  }
  return headers;
}

function promptForApiToken() {
  const value = prompt('Enter API token (leave empty to clear):', apiToken);
  if (value === null) return;
  apiToken = value.trim();
  if (apiToken) {
    localStorage.setItem('pdfzipperApiToken', apiToken);
    showStatus('API token saved in browser storage', 'success');
  } else {
    localStorage.removeItem('pdfzipperApiToken');
    showStatus('API token cleared', 'info');
  }
}

/**
 * Load and display all weeks
 */
async function loadWeeks() {
  try {
    const response = await fetch('/api/files/weeks');

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const weeks = await response.json();

    if (weeks.length === 0) {
      weeksList.innerHTML = '<p class="loading">No weeks found. Start converting URLs to create weekly archives.</p>';
      return;
    }

    // Render week items
    weeksList.innerHTML = weeks.map(week => `
      <div class="week-item" onclick="loadWeek('${week.path}')">
        <h3>${week.path}</h3>
        <p>${week.fileCount} file${week.fileCount !== 1 ? 's' : ''}</p>
      </div>
    `).join('');

  } catch (error) {
    console.error('Failed to load weeks:', error);
    weeksList.innerHTML = '<p class="loading">Error loading weeks. Please refresh the page.</p>';
  }
}

/**
 * Load files for a specific week
 */
async function loadWeek(weekId) {
  currentWeekId = weekId;
  selectedFiles.clear();

  // Reset filter state
  currentFilter = '';
  filterInput.value = '';
  filterClear.classList.add('hidden');
  filterStatus.textContent = '';

  // Update UI
  weekTitle.textContent = `${weekId}`;
  filesTbody.innerHTML = '<tr><td colspan="5" class="loading">Loading files...</td></tr>';
  showFiles();

  try {
    // Fetch both files and failures in parallel
    const [filesResponse, failuresResponse] = await Promise.all([
      fetch(`/api/files/weeks/${weekId}`),
      fetch(`/api/files/weeks/${weekId}/failures`)
    ]);

    if (!filesResponse.ok) {
      throw new Error(`HTTP ${filesResponse.status}: ${filesResponse.statusText}`);
    }

    const filesData = await filesResponse.json();
    const files = filesData.files || [];

    // Failures endpoint might not exist in older versions
    let failures = [];
    if (failuresResponse.ok) {
      failures = await failuresResponse.json();
    }

    // Combine and sort all items by date descending
    allItems = [
      ...files.map(f => ({ ...f, isFailed: false })),
      ...failures.map(f => ({
        ...f,
        isFailed: true,
        modified: f.failedAt
      }))
    ];

    allItems.sort((a, b) => {
      return new Date(b.modified).getTime() - new Date(a.modified).getTime();
    });

    // Render items (respects current filter)
    renderFilteredItems();

  } catch (error) {
    console.error('Failed to load week:', error);
    filesTbody.innerHTML = '<tr><td colspan="5" class="loading">Error loading files. Please try again.</td></tr>';
  }
}

/**
 * Render a regular file row
 */
function renderFileRow(file, index) {
  const checkboxId = `file-${index}`;
  // Link to view the file directly
  const fileUrl = `/api/file/${encodeURIComponent(file.path).replace(/%2F/g, '/')}`;

  // Source URL link (if available, for PDFs)
  const sourceLink = file.sourceUrl
    ? ` (<a href="${escapeHtml(file.sourceUrl)}" target="_blank" class="source-link">source</a>)`
    : '';

  // Related files link (e.g., audio for podcast transcript)
  let relatedLink = '';
  if (file.relatedFiles && file.relatedFiles.length > 0) {
    const relatedPath = file.relatedFiles[0];
    const relatedUrl = `/api/file/${encodeURIComponent(relatedPath).replace(/%2F/g, '/')}`;
    const relatedName = relatedPath.split('/').pop();
    const isAudio = relatedName.match(/\.(mp3|m4a|wav|ogg)$/i);
    const linkText = isAudio ? '🎧 audio' : '📄 transcript';
    relatedLink = ` (<a href="${escapeHtml(relatedUrl)}" target="_blank" class="related-link" title="${escapeHtml(relatedName)}">${linkText}</a>)`;
  }

  // Type badge styling
  const typeBadge = file.type === 'audio'
    ? '<span class="badge-audio">🎧 audio</span>'
    : file.type;

  // Metadata line (if enriched metadata available)
  let metaLine = '';
  if (file.metadata) {
    const m = file.metadata;
    const parts = [];
    if (m.author) parts.push(escapeHtml(m.author));
    if (m.publication) parts.push(escapeHtml(m.publication));
    if (m.language && m.language !== 'en') parts.push(`🌐 ${escapeHtml(m.language)}${m.hasTranslation ? ' (translated)' : ''}`);
    if (m.tags && m.tags.length > 0) parts.push(m.tags.map(t => `<span class="meta-tag">${escapeHtml(t)}</span>`).join(' '));

    const metaParts = parts.length > 0 ? `<span class="meta-info">${parts.join(' · ')}</span>` : '';
    const summary = m.summary ? `<span class="meta-summary" title="${escapeHtml(m.summary)}">${escapeHtml(truncate(m.summary, 120))}</span>` : '';
    if (metaParts || summary) {
      metaLine = `<div class="meta-line">${metaParts}${metaParts && summary ? '<br>' : ''}${summary}</div>`;
    }
  }

  // "New since export" indicator
  const isNew = isNewSinceExport(file);
  const newBadge = isNew ? '<span class="badge-new" title="New since last export">new</span> ' : '';
  const rowClass = isNew ? ' class="new-since-export"' : '';

  return `
    <tr${rowClass}>
      <td class="col-checkbox">
        <input
          type="checkbox"
          id="${checkboxId}"
          data-path="${file.path}"
          onchange="handleFileCheckboxChange(this)"
        >
      </td>
      <td class="col-name">
        ${newBadge}<a href="${escapeHtml(fileUrl)}" target="_blank" class="file-link">${escapeHtml(file.name)}</a>${sourceLink}${relatedLink}${metaLine}
      </td>
      <td class="col-type">${typeBadge}</td>
      <td class="col-size">${formatFileSize(file.size)}</td>
      <td class="col-date">${formatDate(file.modified)}</td>
    </tr>
  `;
}

/**
 * Render a failed conversion row
 */
function renderFailedRow(failure, index) {
  const checkboxId = `failed-${index}`;
  // Use originalUrl for rerun (preserves www), fallback to url
  const urlForRerun = failure.originalUrl || failure.url;

  // Format failure reason for tooltip - clean up technical prefixes
  let reasonText = failure.failureReason || 'Unknown error';
  // Strip common prefixes to get clean message
  const prefixes = ['bot_detected:', 'blank_page:', 'timeout:', 'paywall:', 'quality_failed:', 'truncated:', 'low_contrast:', 'missing_content:', 'unknown:'];
  for (const prefix of prefixes) {
    if (reasonText.startsWith(prefix)) {
      reasonText = reasonText.substring(prefix.length).trim();
      break;
    }
  }
  const tooltipText = escapeHtml(reasonText);

  // Determine failure type for badge
  const failureType = failure.isBotDetected ? 'bot blocked' : getFailureType(failure.failureReason);

  // Use originalUrl for archive.is (preserves www subdomain), fallback to url
  const archiveUrl = `https://archive.is/${failure.originalUrl || failure.url}`;

  // Debug screenshot link (opens in new tab to view what the page looked like)
  const debugUrl = `/api/debug/${failure.jobId}`;

  return `
    <tr class="failed">
      <td class="col-checkbox">
        <input
          type="checkbox"
          id="${checkboxId}"
          data-url="${escapeHtml(urlForRerun)}"
          data-failed="true"
          data-job-id="${escapeHtml(failure.jobId)}"
          onchange="handleFileCheckboxChange(this)"
        >
      </td>
      <td class="col-name">
        <a href="${escapeHtml(failure.url)}" target="_blank" class="failed-url">
          ${escapeHtml(failure.url)}
        </a>
        (<a href="${escapeHtml(archiveUrl)}" target="_blank" class="archive-link">archive.is</a>)
      </td>
      <td class="col-type">
        <a href="${escapeHtml(debugUrl)}" target="_blank" class="badge-failed-link" title="View debug PDF">
          <span class="badge-failed" data-tooltip="${tooltipText}">${failureType}</span>
        </a>
      </td>
      <td class="col-size">-</td>
      <td class="col-date">${formatDate(failure.failedAt)}</td>
    </tr>
  `;
}

/**
 * Get human-readable failure type from reason
 */
function getFailureType(reason) {
  if (!reason) return 'failed';
  if (reason.startsWith('blank_page:')) return 'blank page';
  if (reason.startsWith('bot_detected:')) return 'bot blocked';
  if (reason.startsWith('paywall:')) return 'paywall';
  if (reason.startsWith('timeout:')) return 'timeout';
  if (reason.startsWith('truncated:')) return 'truncated';
  if (reason.startsWith('low_contrast:')) return 'low contrast';
  if (reason.startsWith('missing_content:')) return 'missing content';
  return 'failed';
}

/**
 * Handle select-all checkbox toggle
 */
function handleSelectAll() {
  const checkboxes = filesTbody.querySelectorAll('input[type="checkbox"]:not(:disabled)');
  const isChecked = selectAllCheckbox.checked;

  checkboxes.forEach(cb => {
    cb.checked = isChecked;
    // Update persistent selection state
    const key = getItemKey(cb);
    if (isChecked) {
      selectedFiles.add(key);
    } else {
      selectedFiles.delete(key);
    }
  });

  updateDownloadButtonState();
}

/**
 * Handle individual file checkbox change
 */
function handleFileCheckboxChange(checkbox) {
  // Update persistent selection state
  if (checkbox) {
    const key = getItemKey(checkbox);
    if (checkbox.checked) {
      selectedFiles.add(key);
    } else {
      selectedFiles.delete(key);
    }
  }
  updateSelectAllState();
  updateDownloadButtonState();
}

/**
 * Get unique key for an item (used for persistent selection)
 */
function getItemKey(checkbox) {
  if (checkbox.dataset.failed === 'true') {
    return `failed:${checkbox.dataset.url}`;
  }
  return `file:${checkbox.dataset.path}`;
}

/**
 * Handle filter input with debounce
 */
function handleFilterInput() {
  clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(() => {
    currentFilter = filterInput.value.toLowerCase();
    filterClear.classList.toggle('hidden', !currentFilter);
    renderFilteredItems();
  }, 150);
}

/**
 * Clear the filter
 */
function clearFilter() {
  filterInput.value = '';
  currentFilter = '';
  filterClear.classList.add('hidden');
  renderFilteredItems();
  filterInput.focus();
}

/**
 * Get items matching the current filter
 *
 * Supports special prefixes:
 *   status:success / status:ok   — only successful files
 *   status:fail / status:failed  — only failed items
 * Remaining text after prefix is matched against filename/URL.
 * Example: "status:success nyt" → successful files matching "nyt"
 */
function getFilteredItems() {
  if (!currentFilter) {
    return allItems;
  }

  let statusFilter = null; // null = no status filter, true = success only, false = failed only
  let textFilter = currentFilter;

  // Parse status: prefix
  const statusMatch = currentFilter.match(/^status:(\S+)\s*(.*)/);
  if (statusMatch) {
    const statusValue = statusMatch[1];
    textFilter = statusMatch[2] || '';
    if (statusValue === 'success' || statusValue === 'ok') {
      statusFilter = true;
    } else if (statusValue === 'fail' || statusValue === 'failed') {
      statusFilter = false;
    }
  }

  return allItems.filter(item => {
    // Apply status filter
    if (statusFilter === true && item.isFailed) return false;
    if (statusFilter === false && !item.isFailed) return false;

    // Apply text filter
    if (textFilter) {
      if (item.isFailed) {
        return item.url.toLowerCase().includes(textFilter);
      } else {
        return item.name.toLowerCase().includes(textFilter);
      }
    }

    return true;
  });
}

/**
 * Render filtered items and update status
 */
function renderFilteredItems() {
  const filtered = getFilteredItems();

  if (allItems.length === 0) {
    filesTbody.innerHTML = '<tr><td colspan="5" class="loading">No files in this week.</td></tr>';
    filterStatus.textContent = '';
    return;
  }

  if (filtered.length === 0) {
    filesTbody.innerHTML = '<tr><td colspan="5" class="loading">No items match the filter.</td></tr>';
    filterStatus.textContent = `0 of ${allItems.length} items`;
    return;
  }

  // Render table rows
  filesTbody.innerHTML = filtered.map((item, index) => {
    if (item.isFailed) {
      return renderFailedRow(item, index);
    } else {
      return renderFileRow(item, index);
    }
  }).join('');

  // Restore selection state
  restoreSelectionState();

  // Update filter status
  if (currentFilter) {
    filterStatus.textContent = `Showing ${filtered.length} of ${allItems.length} items`;
  } else {
    filterStatus.textContent = '';
  }

  // Update checkbox states and export info
  updateSelectAllState();
  updateDownloadButtonState();
  updateExportStatus();
}

/**
 * Restore checkbox selection state after re-render
 */
function restoreSelectionState() {
  const checkboxes = filesTbody.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(cb => {
    const key = getItemKey(cb);
    cb.checked = selectedFiles.has(key);
  });
}

/**
 * Update select-all checkbox state based on individual checkboxes
 */
function updateSelectAllState() {
  const checkboxes = Array.from(filesTbody.querySelectorAll('input[type="checkbox"]:not(:disabled)'));
  const checkedCount = checkboxes.filter(cb => cb.checked).length;

  selectAllCheckbox.checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
  selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
}

/**
 * Update action buttons enabled/disabled state based on selection
 */
function updateDownloadButtonState() {
  const checkboxes = filesTbody.querySelectorAll('input[type="checkbox"]:checked');
  const hasSelection = checkboxes.length > 0;

  downloadButton.disabled = !hasSelection;
  deleteButton.disabled = !hasSelection;
  rerunSelectedButton.disabled = !hasSelection;
  fixButton.disabled = !hasSelection;
}

/**
 * Select all files that are new since the last ZIP export for this week
 */
function selectNewSinceExport() {
  const lastExport = getLastExportTime(currentWeekId);
  const filtered = getFilteredItems();
  let count = 0;

  // Clear current selection first
  selectedFiles.clear();

  filtered.forEach((item, index) => {
    const isNew = !lastExport || new Date(item.modified) > new Date(lastExport);
    if (isNew && !item.isFailed) {
      const key = item.path || item.url;
      selectedFiles.add(key);
      count++;
    }
  });

  restoreSelectionState();
  updateSelectAllState();
  updateDownloadButtonState();

  if (count === 0) {
    showStatus('No new files since last export', 'info');
  } else {
    showStatus(`Selected ${count} new file${count !== 1 ? 's' : ''} since last export`, 'success');
  }
}

/**
 * Update the export status display showing when the last export was
 */
function updateExportStatus() {
  if (!exportStatus || !currentWeekId) return;
  const lastExport = getLastExportTime(currentWeekId);
  if (lastExport) {
    const date = new Date(lastExport);
    const relative = getRelativeTime(date);
    exportStatus.textContent = `Last export: ${relative}`;
    exportStatus.title = date.toLocaleString();
  } else {
    exportStatus.textContent = 'Never exported';
    exportStatus.title = '';
  }
}

/**
 * Get a human-readable relative time string
 */
function getRelativeTime(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Download selected files as ZIP
 *
 * Uses a hidden form POST to trigger download. This approach works
 * better with Chrome's security policies for file downloads.
 */
function downloadSelected() {
  const checkboxes = filesTbody.querySelectorAll('input[type="checkbox"]:checked');
  // Only include items with a file path (failed items have no file on disk)
  const filePaths = Array.from(checkboxes)
    .map(cb => cb.dataset.path)
    .filter(p => p);

  if (filePaths.length === 0) {
    showStatus('No downloadable files selected (failed items have no file)', 'error');
    return;
  }

  // Record export timestamp for this week
  if (currentWeekId) {
    setLastExportTime(currentWeekId, new Date().toISOString());
    updateExportStatus();
    // Re-render to update "new" indicators
    renderFilteredItems();
  }

  showStatus('Starting download...', 'info');

  // Create a hidden form for POST download
  // Form submissions for downloads work better with browser security
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/download/zip';
  form.style.display = 'none';

  // Add files as JSON in a hidden input
  const filesInput = document.createElement('input');
  filesInput.type = 'hidden';
  filesInput.name = 'files';
  filesInput.value = JSON.stringify(filePaths);
  form.appendChild(filesInput);

  // Add weekId
  if (currentWeekId) {
    const weekIdInput = document.createElement('input');
    weekIdInput.type = 'hidden';
    weekIdInput.name = 'weekId';
    weekIdInput.value = currentWeekId;
    form.appendChild(weekIdInput);
  }

  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);

  // Show success after a brief delay
  setTimeout(() => {
    showStatus(`Downloading ${filePaths.length} file${filePaths.length !== 1 ? 's' : ''}...`, 'success');
  }, 500);
}

/**
 * Rerun all URLs from current week
 * Re-captures all PDFs and retries all failed jobs
 */
async function rerunAll() {
  if (!currentWeekId) {
    showStatus('No week selected', 'error');
    return;
  }

  // Confirm with user
  if (!confirm(`This will re-capture ALL URLs from ${currentWeekId}.\n\nExisting PDFs will be overwritten with fresh captures.\n\nContinue?`)) {
    return;
  }

  rerunButton.disabled = true;
  rerunButton.textContent = 'Rerunning...';
  showStatus('Submitting URLs for reprocessing...', 'info');

  try {
    const response = await fetch(`/api/files/weeks/${currentWeekId}/rerun`, {
      method: 'POST',
      headers: getAuthHeaders({
        'Content-Type': 'application/json',
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const result = await response.json();
    showStatus(`Submitted ${result.submitted} URLs for reprocessing. Check Bull Board for progress.`, 'success');
  } catch (error) {
    console.error('Rerun failed:', error);
    showStatus(`Failed to rerun: ${error.message}`, 'error');
  } finally {
    rerunButton.disabled = false;
    rerunButton.textContent = 'Rerun All';
  }
}

/**
 * Rerun selected items
 * For PDFs: extracts URLs from PDF metadata
 * For failed items: uses the stored URL directly
 */
async function rerunSelected() {
  const checkboxes = filesTbody.querySelectorAll('input[type="checkbox"]:checked');

  if (checkboxes.length === 0) {
    showStatus('Please select items to rerun', 'error');
    return;
  }

  // Separate files (PDFs) and failed items (URLs)
  const pdfPaths = [];
  const failedUrls = [];

  checkboxes.forEach(cb => {
    if (cb.dataset.failed === 'true') {
      // Failed item - has URL directly
      failedUrls.push(cb.dataset.url);
    } else if (cb.dataset.path && cb.dataset.path.endsWith('.pdf')) {
      // PDF file - needs URL extraction
      pdfPaths.push(cb.dataset.path);
    }
  });

  const totalCount = pdfPaths.length + failedUrls.length;
  if (totalCount === 0) {
    showStatus('No PDF files or failed items selected to rerun', 'error');
    return;
  }

  if (!confirm(`Re-capture ${totalCount} selected item(s)?\n\nExisting files will be overwritten with fresh captures.`)) {
    return;
  }

  rerunSelectedButton.disabled = true;
  rerunSelectedButton.textContent = 'Rerunning...';
  showStatus('Submitting selected URLs for reprocessing...', 'info');

  try {
    const response = await fetch('/api/files/rerun-selected', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ files: pdfPaths, urls: failedUrls }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const result = await response.json();
    showStatus(`Submitted ${result.submitted} URLs for reprocessing.`, 'success');
  } catch (error) {
    console.error('Rerun selected failed:', error);
    showStatus(`Failed to rerun: ${error.message}`, 'error');
  } finally {
    rerunSelectedButton.disabled = false;
    rerunSelectedButton.textContent = 'Rerun Selected';
    updateDownloadButtonState();
  }
}

/**
 * Delete selected files and/or failed items
 * - Files: removed from disk
 * - Failed items: removed from BullMQ job history
 */
async function deleteSelected() {
  const checkboxes = filesTbody.querySelectorAll('input[type="checkbox"]:checked');

  // Separate files and failed items
  const filePaths = [];
  const failedJobIds = [];

  checkboxes.forEach(cb => {
    if (cb.dataset.failed === 'true' && cb.dataset.jobId) {
      failedJobIds.push(cb.dataset.jobId);
    } else if (cb.dataset.path) {
      filePaths.push(cb.dataset.path);
    }
  });

  const totalCount = filePaths.length + failedJobIds.length;
  if (totalCount === 0) {
    showStatus('Please select items to delete', 'error');
    return;
  }

  // Build confirmation message
  const parts = [];
  if (filePaths.length > 0) parts.push(`${filePaths.length} file(s)`);
  if (failedJobIds.length > 0) parts.push(`${failedJobIds.length} failed item(s)`);
  const confirmMsg = `Delete ${parts.join(' and ')}?\n\nThis cannot be undone.`;

  if (!confirm(confirmMsg)) {
    return;
  }

  deleteButton.disabled = true;
  deleteButton.textContent = 'Deleting...';
  showStatus('Deleting selected items...', 'info');

  try {
    let deletedFiles = 0;
    let deletedJobs = 0;

    // Delete files if any
    if (filePaths.length > 0) {
      const response = await fetch('/api/files/delete', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ files: filePaths }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      deletedFiles = result.deleted;
    }

    // Delete failed jobs if any
    if (failedJobIds.length > 0) {
      const response = await fetch('/api/files/delete-failures', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ jobIds: failedJobIds }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      deletedJobs = result.deleted;
    }

    // Build success message
    const successParts = [];
    if (deletedFiles > 0) successParts.push(`${deletedFiles} file(s)`);
    if (deletedJobs > 0) successParts.push(`${deletedJobs} failed item(s)`);
    showStatus(`Deleted ${successParts.join(' and ')}.`, 'success');

    // Reload the current week to reflect changes
    if (currentWeekId) {
      loadWeek(currentWeekId);
    }
  } catch (error) {
    console.error('Delete failed:', error);
    showStatus(`Failed to delete: ${error.message}`, 'error');
  } finally {
    deleteButton.disabled = false;
    deleteButton.textContent = 'Delete Selected';
  }
}

/**
 * Submit selected items for AI diagnosis
 * - Successful PDFs → false positive (should have failed)
 * - Failed items → false negative (should have succeeded)
 */
async function fixSelected() {
  const checkboxes = filesTbody.querySelectorAll('input[type="checkbox"]:checked');

  if (checkboxes.length === 0) {
    showStatus('Please select items to diagnose', 'error');
    return;
  }

  // Build items array for API
  const items = [];

  checkboxes.forEach(cb => {
    if (cb.dataset.failed === 'true') {
      // Failed item → false_negative
      items.push({
        url: cb.dataset.url,
        jobId: cb.dataset.jobId,
        requestType: 'false_negative',
      });
    } else if (cb.dataset.path && cb.dataset.path.endsWith('.pdf')) {
      // PDF file → false_positive
      items.push({
        path: cb.dataset.path,
        requestType: 'false_positive',
      });
    }
  });

  if (items.length === 0) {
    showStatus('No PDF files or failed items selected to diagnose', 'error');
    return;
  }

  if (!confirm(`Submit ${items.length} item(s) for AI diagnosis?\n\nThe system will analyze why these items were incorrectly classified and may apply code fixes.`)) {
    return;
  }

  fixButton.disabled = true;
  fixButton.textContent = 'Submitting...';
  showStatus('Submitting items for AI diagnosis...', 'info');

  try {
    const response = await fetch('/api/fix/submit', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ items }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    showStatus(data.message, 'success');
  } catch (error) {
    console.error('Fix submit failed:', error);
    showStatus(`Failed to submit: ${error.message}`, 'error');
  } finally {
    fixButton.disabled = false;
    fixButton.textContent = 'Fix Selected';
    updateDownloadButtonState();
  }
}

/**
 * Show weeks view
 */
function showWeeks() {
  weeksView.classList.remove('hidden');
  filesView.classList.add('hidden');
  currentWeekId = null;
  selectedFiles.clear();
  hideStatus();
}

/**
 * Show files view
 */
function showFiles() {
  weeksView.classList.add('hidden');
  filesView.classList.remove('hidden');
}

/**
 * Show status message
 */
function showStatus(message, type) {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${type}`;
  statusMessage.classList.remove('hidden');
}

/**
 * Hide status message
 */
function hideStatus() {
  statusMessage.classList.add('hidden');
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Format ISO date for display
 */
function formatDate(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Truncate text with ellipsis
 */
function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + '...';
}

// ============================================
// Fix Center
// ============================================

async function openFixCenterModal() {
  const modal = document.getElementById('fix-center-modal');
  modal.classList.remove('hidden');
  await loadFixCenter();
}

function closeFixCenterModal() {
  const modal = document.getElementById('fix-center-modal');
  modal.classList.add('hidden');
}

function renderGatePill(gateStatus) {
  const safe = escapeHtml(gateStatus || 'unknown');
  return `<span class="gate-pill ${safe}">${safe}</span>`;
}

function renderFixCenterRow(batch) {
  const readyToApply = batch.gateStatus === 'ready';
  const canReverify = batch.gateStatus === 'rejected' || batch.gateStatus === 'failed';
  const provider = batch.provider || '-';
  const commit = batch.commitSha ? `<span class="mono">${escapeHtml(batch.commitSha.substring(0, 12))}</span>` : '-';
  const branch = batch.branchName ? `<span class="mono">${escapeHtml(batch.branchName)}</span>` : '-';
  const reason = batch.gateReason ? `<div class="mono">${escapeHtml(batch.gateReason)}</div>` : '';

  const actions = [];
  if (readyToApply) {
    actions.push(`<button class="btn btn-primary btn-small" onclick="applyFixBatch('${escapeHtml(batch.batchId)}')">Apply</button>`);
  }
  if (canReverify) {
    actions.push(`<button class="btn btn-secondary btn-small" onclick="reverifyFixBatch('${escapeHtml(batch.batchId)}')">Reverify</button>`);
  }
  if (batch.applyCommand) {
    actions.push(`<button class="btn btn-secondary btn-small" onclick="copyApplyCommand('${escapeHtml(batch.batchId)}')">Copy Cmd</button>`);
  }

  return `
    <tr>
      <td><span class="mono">${escapeHtml(batch.batchId.substring(0, 8))}</span></td>
      <td>${renderGatePill(batch.gateStatus)}</td>
      <td>${escapeHtml(provider)}</td>
      <td>${escapeHtml(String(batch.itemCount || 0))}</td>
      <td>${escapeHtml(String(batch.totalFilesModified || 0))}</td>
      <td>${escapeHtml(String(batch.successfulVerifications || 0))}</td>
      <td>${branch}</td>
      <td>${commit}</td>
      <td>
        ${actions.join(' ')}
        ${reason}
      </td>
    </tr>
  `;
}

async function loadFixCenter() {
  const listEl = document.getElementById('fix-center-list');
  const statusEl = document.getElementById('fix-center-status');
  listEl.innerHTML = '<p class="loading">Loading batches...</p>';

  try {
    const [statusResp, historyResp] = await Promise.all([
      fetch('/api/fix/status'),
      fetch('/api/fix/history?limit=20'),
    ]);

    const status = statusResp.ok ? await statusResp.json() : null;
    const history = historyResp.ok ? await historyResp.json() : { batches: [] };
    const batches = Array.isArray(history.batches) ? history.batches : [];

    if (!status || !status.enabled) {
      statusEl.className = 'cookies-status warning';
      statusEl.innerHTML = '<div class="status-info"><strong>Fix system disabled</strong></div>';
    } else {
      statusEl.className = 'cookies-status success';
      statusEl.innerHTML = `
        <div class="status-info">
          <strong>Fix system enabled</strong><br>
          Pending queue: ${escapeHtml(String(status.pending || 0))}<br>
          Claude: ${escapeHtml(status.claudeCliPath || '-')}<br>
          Codex: ${escapeHtml(status.codexCliPath || '-')}
        </div>
      `;
    }

    if (batches.length === 0) {
      listEl.innerHTML = '<p class="loading">No fix batches found.</p>';
      return;
    }

    const rows = batches.map(renderFixCenterRow).join('');
    listEl.innerHTML = `
      <table class="fix-center-table">
        <thead>
          <tr>
            <th>Batch</th>
            <th>Gate</th>
            <th>Provider</th>
            <th>Items</th>
            <th>Files</th>
            <th>Verified</th>
            <th>Branch</th>
            <th>Commit</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (error) {
    listEl.innerHTML = `<p class="loading">Failed to load fix center: ${escapeHtml(error.message)}</p>`;
  }
}

async function applyFixBatch(batchId) {
  if (!confirm(`Mark batch ${batchId} as applied?`)) return;

  try {
    const response = await fetch(`/api/fix/batches/${encodeURIComponent(batchId)}/apply`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    showStatus(`Batch ${batchId} marked as applied`, 'success');
    await loadFixCenter();
  } catch (error) {
    showStatus(`Failed to apply batch: ${error.message}`, 'error');
  }
}

async function reverifyFixBatch(batchId) {
  try {
    const response = await fetch(`/api/fix/batches/${encodeURIComponent(batchId)}/reverify`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    showStatus(`Queued ${data.queued} replay job(s) for batch ${batchId}`, 'info');
    await loadFixCenter();
  } catch (error) {
    showStatus(`Failed to reverify batch: ${error.message}`, 'error');
  }
}

async function copyApplyCommand(batchId) {
  try {
    const response = await fetch(`/api/fix/batches/${encodeURIComponent(batchId)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    const command = data.applyCommand || '';
    if (!command) {
      showStatus('No apply command available for this batch', 'info');
      return;
    }
    await navigator.clipboard.writeText(command);
    showStatus(`Copied command: ${command}`, 'success');
  } catch (error) {
    showStatus(`Failed to copy command: ${error.message}`, 'error');
  }
}

// ============================================
// Cookies Management
// ============================================

let selectedCookiesFile = null;

/**
 * Initialize cookies button
 */
document.addEventListener('DOMContentLoaded', () => {
  const cookiesBtn = document.getElementById('cookies-btn');
  if (cookiesBtn) {
    cookiesBtn.addEventListener('click', openCookiesModal);
  }

  const cookiesFileInput = document.getElementById('cookies-file');
  if (cookiesFileInput) {
    cookiesFileInput.addEventListener('change', handleCookiesFileSelect);
  }
});

/**
 * Open cookies modal and load status
 */
async function openCookiesModal() {
  const modal = document.getElementById('cookies-modal');
  modal.classList.remove('hidden');

  // Load current cookies status
  await loadCookiesStatus();
}

/**
 * Close cookies modal
 */
function closeCookiesModal() {
  const modal = document.getElementById('cookies-modal');
  modal.classList.add('hidden');

  // Reset state
  selectedCookiesFile = null;
  document.getElementById('cookies-file').value = '';
  document.getElementById('upload-btn').disabled = true;
  document.getElementById('upload-result').classList.add('hidden');
}

/**
 * Load and display current cookies status
 */
async function loadCookiesStatus() {
  const statusEl = document.getElementById('cookies-status');

  try {
    const response = await fetch('/api/cookies/status');
    const data = await response.json();

    if (data.exists) {
      const modified = new Date(data.modified);
      statusEl.innerHTML = `
        <div class="status-info">
          <strong>Current cookies file:</strong><br>
          Size: ${formatFileSize(data.size)}<br>
          Last modified: ${modified.toLocaleString()}
        </div>
      `;
      statusEl.className = 'cookies-status success';
    } else {
      statusEl.innerHTML = `
        <div class="status-info">
          <strong>No cookies file configured</strong><br>
          Upload a cookies.txt file to enable paywall bypass.
        </div>
      `;
      statusEl.className = 'cookies-status warning';
    }
  } catch (error) {
    statusEl.innerHTML = `<div class="status-info error">Failed to load cookies status</div>`;
    statusEl.className = 'cookies-status error';
  }
}

/**
 * Handle file selection
 */
function handleCookiesFileSelect(event) {
  const file = event.target.files[0];
  if (file) {
    selectedCookiesFile = file;
    document.getElementById('upload-btn').disabled = false;

    // Show selected file name
    const resultEl = document.getElementById('upload-result');
    resultEl.innerHTML = `Selected: <strong>${escapeHtml(file.name)}</strong> (${formatFileSize(file.size)})`;
    resultEl.className = 'upload-result info';
    resultEl.classList.remove('hidden');
  }
}

/**
 * Upload the selected cookies file
 */
async function uploadCookies() {
  if (!selectedCookiesFile) return;

  const uploadBtn = document.getElementById('upload-btn');
  const resultEl = document.getElementById('upload-result');

  uploadBtn.disabled = true;
  resultEl.innerHTML = 'Uploading...';
  resultEl.className = 'upload-result info';
  resultEl.classList.remove('hidden');

  try {
    // Read file content
    const content = await selectedCookiesFile.text();

    // Upload to server
    const response = await fetch('/api/cookies/upload', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content }),
    });

    const data = await response.json();

    if (response.ok) {
      resultEl.innerHTML = `✓ ${data.message}`;
      resultEl.className = 'upload-result success';

      // Refresh status
      await loadCookiesStatus();

      // Reset file input
      selectedCookiesFile = null;
      document.getElementById('cookies-file').value = '';
    } else {
      resultEl.innerHTML = `✗ ${data.error}`;
      resultEl.className = 'upload-result error';
      uploadBtn.disabled = false;
    }
  } catch (error) {
    resultEl.innerHTML = `✗ Upload failed: ${error.message}`;
    resultEl.className = 'upload-result error';
    uploadBtn.disabled = false;
  }
}
