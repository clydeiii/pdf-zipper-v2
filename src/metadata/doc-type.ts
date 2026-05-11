/**
 * DocType classification for captured artifacts.
 *
 * Every PDF / MP3 / MP4 written by pdf-zipper-v2 embeds a DocType field
 * (PDF Info Dict, ID3 TXXX, MP4 ffmpeg metadata) so downstream Claude on the
 * KB side can sort/filter without re-deriving from filename or hostname.
 *
 * Format types are mutually exclusive: each artifact gets exactly one.
 *
 * - `podcast`    — audio podcast episode (MP3 from Apple Podcasts / RSS feed)
 * - `video`      — video file (MP4 from YouTube / Vimeo / X)
 * - `transcript` — derived transcript PDF (sibling of an MP3 or MP4)
 * - `research`   — academic paper / preprint (arxiv, biorxiv, openreview, ...)
 * - `news`       — major news outlet article
 * - `blog`       — everything else with prose (default for articles)
 */

export type DocType =
  | 'podcast'
  | 'video'
  | 'transcript'
  | 'research'
  | 'news'
  | 'blog';

/**
 * Hosts whose articles are research papers / preprints.
 * Add more as we encounter them.
 */
const RESEARCH_HOSTS = new Set([
  'arxiv.org',
  'biorxiv.org',
  'medrxiv.org',
  'openreview.net',
  'ssrn.com',
  'papers.ssrn.com',
  'osf.io',
  'pubmed.ncbi.nlm.nih.gov',
  'aclanthology.org',
  'jmlr.org',
  'distill.pub',
  'nature.com',
  'science.org',
  'proceedings.neurips.cc',
  'proceedings.mlr.press',
]);

/**
 * Hosts that are major news outlets. Captures of these get `news`.
 * Defaults to `blog` for everything else (Substack/beehiiv/personal sites/etc.).
 */
const NEWS_HOSTS = new Set([
  // US newspapers / wires
  'nytimes.com', 'wsj.com', 'washingtonpost.com', 'bloomberg.com',
  'reuters.com', 'apnews.com', 'usatoday.com', 'latimes.com',
  // International
  'ft.com', 'theguardian.com', 'bbc.com', 'bbc.co.uk', 'economist.com',
  // Magazines / explainers / weeklies
  'theatlantic.com', 'newyorker.com', 'time.com', 'forbes.com',
  'wired.com', 'vox.com', 'fortune.com',
  // Cable / broadcast
  'cnn.com', 'cnbc.com', 'foxnews.com', 'nbcnews.com', 'abcnews.go.com',
  'cbsnews.com', 'pbs.org', 'npr.org',
  // Tech / business news
  'theverge.com', 'businessinsider.com', 'techcrunch.com', 'arstechnica.com',
  'venturebeat.com', 'theinformation.com', 'semafor.com', 'axios.com',
  'protocol.com', 'restofworld.org', 'theregister.com', 'engadget.com',
  // Politics
  'politico.com', 'thehill.com', 'foreignpolicy.com', 'foreignaffairs.com',
  // Other
  'scmp.com', 'aljazeera.com', 'dw.com', 'lemonde.fr',
]);

/**
 * Hostnames whose subdomain pattern indicates blog-platform content.
 * Anything under these is `blog` regardless of further matching.
 */
const BLOG_PLATFORM_SUFFIXES = [
  '.substack.com',
  '.beehiiv.com',
  '.medium.com',
  '.ghost.io',
  '.wordpress.com',
  '.tumblr.com',
];

/**
 * Classify an article URL into research / news / blog.
 * Default for unknown hosts is `blog` (the catch-all for prose).
 */
export function classifyArticle(url: string): 'research' | 'news' | 'blog' {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'blog';
  }

  if (RESEARCH_HOSTS.has(host)) return 'research';
  if (NEWS_HOSTS.has(host)) return 'news';

  for (const suffix of BLOG_PLATFORM_SUFFIXES) {
    if (host.endsWith(suffix)) return 'blog';
  }

  return 'blog';
}
