const PAGE_SIZE = 50;

let captures = [];
let totalCaptures = 0;
let currentQuery = '';
let searchTimer = null;
let listRequest = 0;

const listView = document.getElementById('list-view');
const threadView = document.getElementById('thread-view');
const articleView = document.getElementById('article-view');
const captureList = document.getElementById('capture-list');
const loadMoreButton = document.getElementById('load-more');
const searchInput = document.getElementById('twitter-search');
const statsLine = document.getElementById('twitter-stats');
const threadContent = document.getElementById('thread-content');
const articleContent = document.getElementById('article-content');

document.addEventListener('error', (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('avatar')) return;
  const fallback = image.nextElementSibling;
  if (fallback?.classList.contains('avatar-placeholder')) {
    image.remove();
    fallback.classList.remove('hidden');
  }
}, true);

document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadCaptures(true);
  loadMoreButton.addEventListener('click', () => loadCaptures(false));
  document.querySelectorAll('.back-to-list').forEach((button) => {
    button.addEventListener('click', showList);
  });
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentQuery = searchInput.value.trim();
      showList();
      loadCaptures(true);
    }, 250);
  });
  captureList.addEventListener('click', handleListClick);
  threadContent.addEventListener('click', handleThreadClick);
});

async function loadStats() {
  try {
    const response = await fetch('/api/twitter/stats');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stats = await response.json();
    statsLine.textContent = `${formatInteger(stats.tweets)} posts · ${formatInteger(stats.users)} users · ${formatInteger(stats.images)} images · ${formatMegabytes(stats.imagestoreBytes)} MB`;
  } catch (error) {
    statsLine.textContent = 'Database stats unavailable';
  }
}

async function loadCaptures(reset) {
  const requestId = ++listRequest;
  if (reset) {
    captures = [];
    totalCaptures = 0;
    captureList.innerHTML = '<p class="loading">Loading captures…</p>';
  }
  loadMoreButton.disabled = true;
  loadMoreButton.textContent = 'Loading…';
  try {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(captures.length),
    });
    if (currentQuery) params.set('q', currentQuery);
    const response = await fetch(`/api/twitter/captures?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (requestId !== listRequest) return;
    captures.push(...result.items);
    totalCaptures = result.total;
    renderCaptureList();
  } catch (error) {
    if (requestId !== listRequest) return;
    captureList.innerHTML = `<p class="empty-state">Could not load captures: ${escapeHtml(error.message)}</p>`;
    loadMoreButton.classList.add('hidden');
  } finally {
    if (requestId === listRequest) {
      loadMoreButton.disabled = false;
      loadMoreButton.textContent = 'Load More';
    }
  }
}

function renderCaptureList() {
  if (!captures.length) {
    captureList.innerHTML = `<p class="empty-state">${currentQuery ? 'No matching captures.' : 'No Twitter/X captures yet.'}</p>`;
    loadMoreButton.classList.add('hidden');
    return;
  }
  captureList.innerHTML = captures.map((capture) => {
    const displayName = capture.fullname || capture.username || (capture.kind === 'article' ? 'X Article' : 'Unknown user');
    const date = capture.publishedAt || capture.bookmarkedAt || capture.capturedAt;
    const stats = capture.stats || {};
    return `
      <article class="week-item capture-row">
        ${avatarHtml(capture.avatarFile, displayName)}
        <div class="capture-main">
          <div class="capture-head">
            <span class="capture-name">${escapeHtml(displayName)}</span>
            ${capture.username ? `<span class="capture-username">@${escapeHtml(capture.username)}</span>` : ''}
            <span class="capture-date">${escapeHtml(formatDate(date))}</span>
          </div>
          ${capture.textPreview
            ? `<div class="capture-text">${escapeHtml(capture.textPreview)}</div>`
            : (!capture.articleTitle ? '<div class="capture-text">No text captured</div>' : '')}
          ${capture.articleTitle ? `
            <div class="capture-article-title">
              <span class="badge badge-article">Article</span>${escapeHtml(capture.articleTitle)}
            </div>
          ` : ''}
          <div class="capture-meta">
            ${capture.kind === 'article' && !capture.articleTitle ? '<span class="badge badge-article">Article</span>' : ''}
            ${capture.mediaCount ? `<span class="badge">${escapeHtml(String(capture.mediaCount))} media</span>` : ''}
            ${capture.repliesCaptured ? `<span class="badge">${escapeHtml(String(capture.repliesCaptured))} replies captured</span>` : ''}
            ${capture.kind === 'tweet' ? `
              <span class="capture-counts">
                <span title="Replies">💬 ${formatCount(stats.replies)}</span>
                <span title="Reposts">🔁 ${formatCount(stats.retweets)}</span>
                <span title="Likes">❤️ ${formatCount(stats.likes)}</span>
                <span title="Views">👁 ${formatCount(stats.views)}</span>
              </span>
            ` : ''}
            <span class="capture-actions">
              <button class="btn btn-primary open-detail" data-kind="${escapeHtml(capture.kind)}" data-id="${escapeHtml(capture.subjectId)}">${capture.kind === 'article' ? 'Article' : 'Thread'}</button>
              ${capture.pdfPath ? `<a class="btn btn-secondary" href="${escapeHtml(fileUrl(capture.pdfPath))}" target="_blank" rel="noopener">PDF</a>` : ''}
              <a class="btn btn-secondary" href="${escapeHtml(xUrl(capture.sourceUrl))}" target="_blank" rel="noopener">Source</a>
            </span>
          </div>
        </div>
      </article>
    `;
  }).join('');
  loadMoreButton.classList.toggle('hidden', captures.length >= totalCaptures);
}

function handleListClick(event) {
  const button = event.target.closest('.open-detail');
  if (!button) return;
  if (button.dataset.kind === 'article') loadArticle(button.dataset.id);
  else loadThread(button.dataset.id);
}

function handleThreadClick(event) {
  const button = event.target.closest('.open-article');
  if (button) loadArticle(button.dataset.id);
}

async function loadThread(id) {
  showView(threadView);
  threadContent.innerHTML = '<p class="loading">Loading thread…</p>';
  try {
    const response = await fetch(`/api/twitter/thread/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(response.status === 404 ? 'Thread not found' : `HTTP ${response.status}`);
    const data = await response.json();
    document.getElementById('detail-source').href = xUrl(data.subject.source_url);
    threadContent.innerHTML = `
      <div class="thread-stack">
        ${data.ancestors.map((tweet) => renderTweet(tweet, { className: 'ancestor' })).join('')}
        ${renderTweet(data.subject, {
          className: 'subject',
          quoted: data.quoted,
          captures: data.captures,
          showStats: true,
          article: data.article,
          articlePdfFallback: (data.captures || []).find((capture) => capture.pdf_path)?.pdf_path,
        })}
      </div>
      <h2 class="replies-heading">Replies</h2>
      <div class="thread-stack">
        ${data.replies.length
          ? data.replies.map((reply) => `
              <div class="reply-chain">
                ${renderTweet(reply)}
                ${(reply.replies || []).map((nested) => `<div class="reply-chain nested">${renderTweet(nested)}</div>`).join('')}
              </div>
            `).join('')
          : '<p class="empty-state">No replies were captured.</p>'}
      </div>
    `;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    threadContent.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  }
}

function renderTweet(tweet, options = {}) {
  const user = tweet.user || {};
  const displayName = user.fullname || tweet.username || 'Unknown user';
  const content = tweet.content_html || escapeHtml(tweet.content_text || '');
  return `
    <article class="tweet-card ${escapeHtml(options.className || '')}">
      <div class="tweet-layout">
        ${avatarHtml(user.avatar_file, displayName)}
        <div>
          <div class="tweet-head">
            <span class="tweet-name">${escapeHtml(displayName)}</span>
            ${user.verified ? `<span class="verified" title="${escapeHtml(user.verified)}">✓</span>` : ''}
            ${tweet.username ? `<span class="tweet-username">@${escapeHtml(tweet.username)}</span>` : ''}
          </div>
          <div class="tweet-content">${content}</div>
          ${renderLinks(tweet.links || [])}
          ${renderMedia(tweet.media || [])}
          ${renderLinkCard(tweet.card)}
          ${renderPoll(tweet.poll || [])}
          ${options.article ? renderTweetArticle(options.article, options.articlePdfFallback) : ''}
          ${options.quoted ? renderQuoted(options.quoted, 0) : ''}
          <div class="tweet-date">${escapeHtml(formatDate(tweet.published_at))}</div>
          ${options.showStats ? renderStats(tweet) : ''}
          ${options.captures ? renderProvenance(options.captures) : ''}
        </div>
      </div>
    </article>
  `;
}

function renderLinks(links) {
  if (!links.length) return '';
  return `
    <div class="tweet-links">
      ${links.map((link) => {
        const externalUrl = safeHttpUrl(link.url);
        if (!externalUrl) return '';
        const captured = Boolean(link.pdfPath);
        const href = captured ? fileUrl(link.pdfPath) : externalUrl;
        return `<a class="link-chip${captured ? ' captured' : ''}" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${escapeHtml(link.url)}">${captured ? 'Captured · ' : ''}${escapeHtml(linkLabel(link.url))}</a>`;
      }).join('')}
    </div>
  `;
}

function renderTweetArticle(article, capturePdfPath) {
  if (!article) return '';
  const pdfPath = article.pdf_path || capturePdfPath;
  return `
    <div class="tweet-article-box">
      <div class="tweet-article-copy">
        <span class="badge badge-article">Article</span>
        <div class="tweet-article-title">${escapeHtml(article.title || 'Untitled X Article')}</div>
        ${article.preview_text ? `<p class="tweet-article-preview">${escapeHtml(article.preview_text)}</p>` : ''}
        <div class="tweet-article-actions">
          <button class="btn btn-primary open-article" data-id="${escapeHtml(article.id)}">Read article</button>
          ${pdfPath ? `<a class="btn btn-secondary" href="${escapeHtml(fileUrl(pdfPath))}" target="_blank" rel="noopener">PDF</a>` : ''}
        </div>
      </div>
      ${article.cover_image_file ? `<img class="tweet-article-cover" src="${escapeHtml(fileUrl(article.cover_image_file))}" alt="" loading="lazy">` : ''}
    </div>
  `;
}

function renderQuoted(tweet, depth) {
  if (!tweet || depth > 1) return '';
  return `
    <div class="quoted-box">
      ${renderTweet(tweet, {
        quoted: depth < 1 ? tweet.quoted : null,
      })}
    </div>
  `;
}

function renderMedia(media) {
  if (!media.length) return '';
  return `
    <div class="media-gallery ${media.length === 1 ? 'single' : ''}">
      ${media.map((item) => {
        const imagePath = item.file || item.poster_file;
        if (item.kind === 'photo' || item.kind === 'card-image') {
          return imagePath
            ? `<a href="${escapeHtml(fileUrl(imagePath))}" target="_blank" rel="noopener"><img src="${escapeHtml(fileUrl(imagePath))}" alt="Tweet media" loading="lazy"></a>`
            : '';
        }
        if (item.localVideoPath) {
          return `<video controls preload="metadata" ${item.poster_file ? `poster="${escapeHtml(fileUrl(item.poster_file))}"` : ''}><source src="${escapeHtml(fileUrl(item.localVideoPath))}"></video>`;
        }
        const videoUrl = safeHttpUrl(item.video_url);
        return `
          <div class="video-fallback">
            ${imagePath ? `<img src="${escapeHtml(fileUrl(imagePath))}" alt="Video poster" loading="lazy">` : ''}
            ${videoUrl ? `<a href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener">▶ Open ${item.kind === 'gif' ? 'GIF' : 'video'}</a>` : '<a>Video unavailable</a>'}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderLinkCard(card) {
  if (!card) return '';
  const url = safeHttpUrl(card.url);
  const content = `
    <span class="link-card-copy">
      ${card.title ? `<span class="link-card-title">${escapeHtml(card.title)}</span>` : ''}
      ${card.description ? `<span class="link-card-description">${escapeHtml(card.description)}</span>` : ''}
    </span>
    ${card.image_file ? `<img src="${escapeHtml(fileUrl(card.image_file))}" alt="" loading="lazy">` : ''}
  `;
  return url
    ? `<a class="link-card" href="${escapeHtml(url)}" target="_blank" rel="noopener">${content}</a>`
    : `<div class="link-card">${content}</div>`;
}

function renderPoll(options) {
  if (!options.length) return '';
  return `
    <div class="poll">
      ${options.map((option) => {
        const percent = Number.isFinite(option.value_percent)
          ? Math.max(0, Math.min(100, option.value_percent))
          : 0;
        return `
          <div class="poll-option">
            <span class="poll-fill" style="width:${percent}%"></span>
            <span class="poll-label"><span>${escapeHtml(option.label || '')}</span><span>${option.value_percent == null ? '' : `${escapeHtml(String(option.value_percent))}%`}</span></span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderStats(tweet) {
  return `
    <div class="tweet-stats">
      <span>💬 ${formatCount(tweet.replies_count)} replies</span>
      <span>🔁 ${formatCount(tweet.retweets_count)} reposts</span>
      <span>❤️ ${formatCount(tweet.likes_count)} likes</span>
      <span>👁 ${formatCount(tweet.views_count)} views</span>
    </div>
  `;
}

function renderProvenance(captures) {
  if (!captures.length) return '';
  return `
    <div class="capture-provenance">
      ${captures.map((capture) => `
        <div>
          Captured ${escapeHtml(formatDate(capture.captured_at))} · ${escapeHtml(capture.origin || 'unknown')}
          ${capture.pdf_path ? ` · <a href="${escapeHtml(fileUrl(capture.pdf_path))}" target="_blank" rel="noopener">PDF</a>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

async function loadArticle(id) {
  showView(articleView);
  articleContent.innerHTML = '<p class="loading">Loading article…</p>';
  try {
    const response = await fetch(`/api/twitter/article/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(response.status === 404 ? 'Article not found' : `HTTP ${response.status}`);
    const data = await response.json();
    const article = data.article;
    const author = data.author || {};
    const displayName = author.fullname || article.author_username || 'Unknown author';
    document.getElementById('article-source').href = xUrl(article.url);
    articleContent.innerHTML = `
      <article class="article-card">
        <h2>${escapeHtml(article.title || 'Untitled X Article')}</h2>
        <div class="tweet-head">
          <span class="tweet-name">${escapeHtml(displayName)}</span>
          ${article.author_username ? `<span class="tweet-username">@${escapeHtml(article.author_username)}</span>` : ''}
          <span class="tweet-date">${escapeHtml(formatDate(article.published_at))}</span>
        </div>
        ${article.cover_image_file ? `<a href="${escapeHtml(fileUrl(article.cover_image_file))}" target="_blank" rel="noopener"><img class="article-cover" src="${escapeHtml(fileUrl(article.cover_image_file))}" alt="" loading="lazy"></a>` : ''}
        <div class="article-body">${article.body_html || escapeHtml(article.body_text || article.preview_text || '')}</div>
        ${renderLinks(data.links || [])}
        ${renderArticleMedia(data.media || [])}
        ${renderProvenance(data.captures || [])}
      </article>
    `;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    articleContent.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  }
}

function renderArticleMedia(media) {
  const stored = media.filter((item) => item.file);
  if (!stored.length) return '';
  return `
    <div class="media-gallery ${stored.length === 1 ? 'single' : ''}">
      ${stored.map((item) => `<a href="${escapeHtml(fileUrl(item.file))}" target="_blank" rel="noopener"><img src="${escapeHtml(fileUrl(item.file))}" alt="Article media" loading="lazy"></a>`).join('')}
    </div>
  `;
}

function showList() {
  showView(listView);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showView(view) {
  [listView, threadView, articleView].forEach((candidate) => {
    candidate.classList.toggle('hidden', candidate !== view);
  });
}

function avatarHtml(file, label) {
  const initial = String(label || '?').trim().charAt(0).toUpperCase() || '?';
  if (file) {
    return `
      <span class="avatar-slot">
        <img class="avatar" src="${escapeHtml(fileUrl(file))}" alt="${escapeHtml(label)}" loading="lazy">
        <span class="avatar avatar-placeholder hidden" aria-hidden="true">${escapeHtml(initial)}</span>
      </span>
    `;
  }
  return `<span class="avatar avatar-placeholder" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

function fileUrl(relativePath) {
  return `/api/file/${String(relativePath).split('/').map(encodeURIComponent).join('/')}`;
}

function xUrl(value) {
  const safe = safeHttpUrl(value);
  if (!safe) return 'https://x.com/';
  try {
    const url = new URL(safe);
    if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) {
      url.protocol = 'https:';
      url.hostname = 'x.com';
      url.port = '';
    }
    return url.toString();
  } catch {
    return 'https://x.com/';
  }
}

function safeHttpUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function linkLabel(value) {
  try {
    const url = new URL(value);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

function formatDate(isoString) {
  if (!isoString) return 'Date unknown';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Date unknown';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCount(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: Number(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(Number(value));
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

function formatMegabytes(bytes) {
  return ((Number(bytes) || 0) / (1024 * 1024)).toFixed(1);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}
