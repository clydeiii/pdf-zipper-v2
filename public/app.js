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
const backButton = document.getElementById('back-button');
const statusMessage = document.getElementById('status-message');
const filterInput = document.getElementById('filter-input');
const filterClear = document.getElementById('filter-clear');
const filterStatus = document.getElementById('filter-status');

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
  filterInput.addEventListener('input', handleFilterInput);
  filterClear.addEventListener('click', clearFilter);
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

  return `
    <tr>
      <td class="col-checkbox">
        <input
          type="checkbox"
          id="${checkboxId}"
          data-path="${file.path}"
          onchange="handleFileCheckboxChange(this)"
        >
      </td>
      <td class="col-name">
        <a href="${escapeHtml(fileUrl)}" target="_blank" class="file-link">${escapeHtml(file.name)}</a>${sourceLink}${relatedLink}
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
 */
function getFilteredItems() {
  if (!currentFilter) {
    return allItems;
  }
  return allItems.filter(item => {
    if (item.isFailed) {
      // Match on URL for failed items
      return item.url.toLowerCase().includes(currentFilter);
    } else {
      // Match on filename for files
      return item.name.toLowerCase().includes(currentFilter);
    }
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

  // Update checkbox states
  updateSelectAllState();
  updateDownloadButtonState();
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
}

/**
 * Download selected files as ZIP
 *
 * Uses a hidden form POST to trigger download. This approach works
 * better with Chrome's security policies for file downloads.
 */
function downloadSelected() {
  const checkboxes = filesTbody.querySelectorAll('input[type="checkbox"]:checked');
  const filePaths = Array.from(checkboxes).map(cb => cb.dataset.path);

  if (filePaths.length === 0) {
    showStatus('Please select files to download', 'error');
    return;
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
      headers: {
        'Content-Type': 'application/json',
      },
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
      headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
