/**
 * REST API routes for file browsing
 *
 * GET /weeks - List all week directories
 * GET /weeks/:weekId - List files in a specific week
 * POST /weeks/:weekId/rerun - Rerun all URLs from a week
 */

import { Router, Request, Response } from 'express';
import { readdir, stat, readFile } from 'node:fs/promises';
import { Stats } from 'node:fs';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { readInfoDictField } from '../../utils/pdf-info-dict.js';
import { readAudioMetadata, readVideoMetadata } from '../../metadata/media-tags-reader.js';
import { env } from '../../config/env.js';
import { conversionQueue } from '../../queues/conversion.queue.js';
import { podcastQueue } from '../../podcasts/podcast.queue.js';
import { isApplePodcastsUrl } from '../../podcasts/apple.js';
import { getISOWeekNumber } from '../../media/organization.js';
import { notifyWeekRerun } from '../../notifications/discord.js';
import { requireApiToken } from '../auth.js';
import { resolveWithinRoot } from '../../utils/paths.js';
import { getWeekIndexedJobIds } from '../../jobs/week-index.js';
import type { PodcastJobData } from '../../podcasts/types.js';
import { mediaCollectionQueue } from '../../feeds/monitor.js';
import type { MediaItem } from '../../media/types.js';

export const filesRouter = Router();

/**
 * Week directory information
 */
interface WeekInfo {
  year: number;
  week: number;
  path: string;
  fileCount: number;
}

/**
 * File information within a week
 */
interface FileInfo {
  name: string;
  path: string; // relative to DATA_DIR
  size: number;
  modified: string; // ISO date string
  type: 'video' | 'transcript' | 'pdf' | 'audio';
  sourceUrl?: string; // Original URL (for PDFs, extracted from metadata)
  relatedFiles?: string[]; // Paths to related files (e.g., audio file for podcast transcript)
  metadata?: {
    title?: string;
    author?: string;
    publication?: string;
    summary?: string;
    language?: string;
    tags?: string[];
    hasTranslation?: boolean;
  };
}

/**
 * Failed conversion information
 */
interface FailureInfo {
  url: string;
  originalUrl?: string;  // Preserved original URL for archive.is links
  failureReason: string;
  failedAt: string; // ISO date string
  isBotDetected: boolean;
  jobId: string;  // For debug screenshot link
}

/**
 * Validate week ID matches pattern YYYY-WWW (e.g., 2026-W04)
 */
function isValidWeekId(weekId: string): boolean {
  return /^\d{4}-W\d{2}$/.test(weekId);
}

/**
 * Parse week ID into year and week number
 */
function parseWeekId(weekId: string): { year: number; week: number } | null {
  const match = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return null;
  return {
    year: parseInt(match[1], 10),
    week: parseInt(match[2], 10),
  };
}

/**
 * Count files in a week directory recursively
 */
async function countFilesInWeek(weekPath: string): Promise<number> {
  let count = 0;

  try {
    const subdirs = ['videos', 'transcripts', 'pdfs', 'podcasts'];

    for (const subdir of subdirs) {
      const subdirPath = path.join(weekPath, subdir);
      try {
        const entries = await readdir(subdirPath);
        // Count only files (exclude directories)
        for (const entry of entries) {
          const entryPath = path.join(subdirPath, entry);
          const stats = await stat(entryPath);
          if (stats.isFile()) {
            count++;
          }
        }
      } catch (error) {
        // Subdir doesn't exist, skip
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  } catch (error) {
    // Week directory doesn't exist or can't be read
    console.error('Error counting files in week:', {
      weekPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return count;
}

/**
 * GET /weeks - List all week directories
 *
 * Returns array sorted newest-first: [{ year, week, path, fileCount }]
 * Returns empty array if media directory doesn't exist
 */
filesRouter.get('/weeks', async (_req: Request, res: Response): Promise<void> => {
  try {
    const mediaDir = path.join(env.DATA_DIR, 'media');

    let entries: string[];
    try {
      entries = await readdir(mediaDir);
    } catch (error) {
      // Media directory doesn't exist yet - return empty array
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.json([]);
        return;
      }
      throw error;
    }

    const weeks: WeekInfo[] = [];

    // Filter and parse week directories
    for (const entry of entries) {
      if (!isValidWeekId(entry)) continue;

      const weekPath = path.join(mediaDir, entry);
      const stats = await stat(weekPath);

      if (!stats.isDirectory()) continue;

      const parsed = parseWeekId(entry);
      if (!parsed) continue;

      const fileCount = await countFilesInWeek(weekPath);

      weeks.push({
        year: parsed.year,
        week: parsed.week,
        path: entry,
        fileCount,
      });
    }

    // Sort newest-first (descending by year, then week)
    weeks.sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.week - a.week;
    });

    res.json(weeks);
  } catch (error) {
    console.error('Failed to list weeks:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to list week directories',
    });
  }
});

/**
 * Bounded-concurrency map. Runs `fn` over `items` with at most `limit` in
 * flight at a time; preserves input order in the output array.
 */
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * In-memory cache for parsed PDF info. Key = `${path}:${mtimeMs}` so any file
 * modification (rerun, regen) naturally invalidates the entry. Capped to 10k
 * entries; oldest 25% are evicted when the cap is hit. Cleared on container
 * restart, so no need for time-based TTL.
 */
type PdfFileInfo = { sourceUrl?: string; metadata?: FileInfo['metadata'] };
const pdfInfoCache = new Map<string, PdfFileInfo>();
const PDF_INFO_CACHE_MAX = 10_000;

function cachePdfInfo(key: string, info: PdfFileInfo): void {
  if (pdfInfoCache.size >= PDF_INFO_CACHE_MAX) {
    const evictCount = Math.floor(PDF_INFO_CACHE_MAX / 4);
    let evicted = 0;
    for (const k of pdfInfoCache.keys()) {
      if (evicted++ >= evictCount) break;
      pdfInfoCache.delete(k);
    }
  }
  pdfInfoCache.set(key, info);
}

/**
 * Read a PDF once and return both source URL and enriched metadata.
 *
 * Replaces the previous extractUrlFromPdf + extractEnrichedMetadata pair,
 * which loaded each PDF twice. Cached by path+mtime so warm requests skip
 * the parse entirely. Returns empty fields on any read/parse error.
 */
async function loadPdfFileInfo(
  pdfPath: string,
  mtimeMs: number
): Promise<PdfFileInfo> {
  const cacheKey = `${pdfPath}:${mtimeMs}`;
  const cached = pdfInfoCache.get(cacheKey);
  if (cached) return cached;

  let info: PdfFileInfo = {};
  try {
    const pdfBytes = await readFile(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    const subject = pdfDoc.getSubject();
    const sourceUrl =
      subject && (subject.startsWith('http://') || subject.startsWith('https://'))
        ? subject
        : undefined;

    const summary = readInfoDictField(pdfDoc, 'Summary');
    const language = readInfoDictField(pdfDoc, 'Language');

    let metadata: FileInfo['metadata'] | undefined;
    if (summary || language) {
      const tagsStr = readInfoDictField(pdfDoc, 'Tags');
      const translation = readInfoDictField(pdfDoc, 'Translation');
      metadata = {
        title: pdfDoc.getTitle() || undefined,
        author: pdfDoc.getAuthor() || undefined,
        publication: readInfoDictField(pdfDoc, 'Publication'),
        summary: summary || undefined,
        language: language || undefined,
        tags: tagsStr ? tagsStr.split(', ').filter(Boolean) : undefined,
        hasTranslation: !!translation,
      };
    }

    info = { sourceUrl, metadata };
  } catch {
    info = {};
  }

  cachePdfInfo(cacheKey, info);
  return info;
}

/**
 * GET /weeks/:weekId - List files in a specific week
 *
 * Returns: { weekId, files: [...] }
 * Files sorted by modified date descending (newest first)
 *
 * Status codes:
 * - 200 OK with file list
 * - 400 Bad Request if weekId invalid format
 * - 404 Not Found if week directory doesn't exist
 * - 500 Internal Server Error on failure
 */
filesRouter.get('/weeks/:weekId', async (req: Request, res: Response): Promise<void> => {
  const weekId = req.params.weekId as string;

  // Validate weekId format
  if (!isValidWeekId(weekId)) {
    res.status(400).json({
      error: 'Invalid week ID format. Expected YYYY-WWW (e.g., 2026-W04)',
    });
    return;
  }

  try {
    const weekPath = path.join(env.DATA_DIR, 'media', weekId);

    // Check if week directory exists
    try {
      const stats = await stat(weekPath);
      if (!stats.isDirectory()) {
        res.status(404).json({
          error: 'Week directory not found',
        });
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({
          error: 'Week directory not found',
        });
        return;
      }
      throw error;
    }

    // Scan subdirectories for files
    const subdirs: Array<{ name: string; defaultType: 'video' | 'transcript' | 'pdf' | 'audio' }> = [
      { name: 'videos', defaultType: 'video' },
      { name: 'transcripts', defaultType: 'transcript' },
      { name: 'pdfs', defaultType: 'pdf' },
      { name: 'podcasts', defaultType: 'pdf' },  // Podcasts folder has PDFs and audio
    ];

    // Phase 1: cheaply collect every file we'll process. Subdirs are walked in
    // parallel; each subdir's stat() calls also fan out so we don't pay an N×stat
    // serialization cost on weeks with hundreds of files.
    type RawFile = {
      entry: string;
      filePath: string;
      relativePath: string;
      stats: Stats;
      ext: string;
      subdirName: string;
      defaultType: 'video' | 'transcript' | 'pdf' | 'audio';
    };

    const subdirResults = await Promise.all(subdirs.map(async (subdir) => {
      const subdirPath = path.join(weekPath, subdir.name);
      let entries: string[];
      try {
        entries = await readdir(subdirPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }

      const stats = await Promise.all(entries.map((entry) =>
        stat(path.join(subdirPath, entry)).catch(() => null)
      ));

      const raws: RawFile[] = [];
      for (let i = 0; i < entries.length; i++) {
        const s = stats[i];
        if (!s || !s.isFile()) continue;
        const entry = entries[i];
        const filePath = path.join(subdirPath, entry);
        raws.push({
          entry,
          filePath,
          relativePath: path.relative(env.DATA_DIR, filePath),
          stats: s,
          ext: path.extname(entry).toLowerCase(),
          subdirName: subdir.name,
          defaultType: subdir.defaultType,
        });
      }
      return raws;
    }));
    const rawFiles: RawFile[] = subdirResults.flat();

    // Phase 2: extract metadata in parallel with bounded concurrency. PDF parsing
    // dominates wall time here, and 16 workers keeps memory under control on
    // weeks with hundreds of multi-MB PDFs (1.5GB container limit).
    const files: FileInfo[] = await withConcurrency(rawFiles, 16, async (raw) => {
      const { entry, filePath, relativePath, stats, ext, defaultType } = raw;

      let fileType: 'video' | 'transcript' | 'pdf' | 'audio' = defaultType;
      if (ext === '.mp3' || ext === '.m4a' || ext === '.wav' || ext === '.ogg') {
        fileType = 'audio';
      } else if (ext === '.pdf') {
        fileType = 'pdf';
      } else if (ext === '.mp4' || ext === '.webm') {
        fileType = 'video';
      }

      let sourceUrl: string | undefined;
      let metadata: FileInfo['metadata'];

      if (fileType === 'pdf') {
        const info = await loadPdfFileInfo(filePath, stats.mtimeMs);
        sourceUrl = info.sourceUrl;
        metadata = info.metadata;
      } else if (fileType === 'audio') {
        try {
          const m = await readAudioMetadata(filePath);
          if (m) {
            metadata = {
              title: m.title, author: m.author, publication: m.publication,
              summary: m.summary, tags: m.tags,
            };
            sourceUrl = m.sourceUrl;
          }
        } catch { /* ignore */ }
      } else if (fileType === 'video') {
        try {
          const m = await readVideoMetadata(filePath);
          if (m) {
            metadata = {
              title: m.title, author: m.author, publication: m.publication,
              summary: m.summary, tags: m.tags,
            };
            sourceUrl = m.sourceUrl;
          }
        } catch { /* ignore */ }
      }

      return {
        name: entry,
        path: relativePath,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        type: fileType,
        sourceUrl,
        metadata,
      };
    });

    // Phase 3: link podcast PDFs to their audio sibling. The podcasts/ subdir
    // contains both PDF and MP3 with matching base names; cross-link them so
    // the UI can render a single combined row.
    const filesByBaseName = new Map<string, FileInfo[]>();
    for (let i = 0; i < rawFiles.length; i++) {
      if (rawFiles[i].subdirName !== 'podcasts') continue;
      const baseName = path.basename(rawFiles[i].entry, rawFiles[i].ext);
      if (!filesByBaseName.has(baseName)) filesByBaseName.set(baseName, []);
      filesByBaseName.get(baseName)!.push(files[i]);
    }
    for (const relatedFiles of filesByBaseName.values()) {
      if (relatedFiles.length < 2) continue;
      const pdfFile = relatedFiles.find(f => f.type === 'pdf');
      const audioFile = relatedFiles.find(f => f.type === 'audio');
      if (pdfFile && audioFile) {
        pdfFile.relatedFiles = [audioFile.path];
        audioFile.relatedFiles = [pdfFile.path];
      }
    }

    // Sort by modified date descending (newest first)
    files.sort((a, b) => {
      return new Date(b.modified).getTime() - new Date(a.modified).getTime();
    });

    res.json({
      weekId,
      files,
    });
  } catch (error) {
    console.error('Failed to list files in week:', {
      weekId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to list files in week',
    });
  }
});

/**
 * GET /weeks/:weekId/failures - List failed conversions for a specific week
 *
 * Returns: Array of failed jobs that occurred during the specified week
 * Jobs are filtered by the week they were created (job.timestamp)
 *
 * Status codes:
 * - 200 OK with failures array (may be empty)
 * - 400 Bad Request if weekId invalid format
 * - 500 Internal Server Error on failure
 */
filesRouter.get('/weeks/:weekId/failures', async (req: Request, res: Response): Promise<void> => {
  const weekId = req.params.weekId as string;

  // Validate weekId format
  if (!isValidWeekId(weekId)) {
    res.status(400).json({
      error: 'Invalid week ID format. Expected YYYY-WWW (e.g., 2026-W04)',
    });
    return;
  }

  try {
    const parsed = parseWeekId(weekId);
    if (!parsed) {
      res.status(400).json({
        error: 'Invalid week ID format',
      });
      return;
    }

    const failures: FailureInfo[] = [];
    const indexedJobIds = await getWeekIndexedJobIds(weekId, 'failed');

    if (indexedJobIds.length > 0) {
      for (const jobId of indexedJobIds) {
        const job = await conversionQueue.getJob(jobId);
        if (!job) continue;

        const failedReason = job.failedReason || 'unknown';
        const isBotDetected = failedReason.startsWith('bot_detected:') ||
          failedReason.startsWith('blank_page:') ||
          failedReason.toLowerCase().includes('bot detection');

        failures.push({
          url: job.data.url,
          originalUrl: job.data.originalUrl,
          failureReason: failedReason,
          failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : new Date(job.timestamp).toISOString(),
          isBotDetected,
          jobId: job.id!,
        });
      }
    } else {
      // Fallback for historical jobs not yet indexed.
      const failedJobs = await conversionQueue.getFailed();
      for (const job of failedJobs) {
        const jobDate = new Date(job.timestamp);
        const jobWeek = getISOWeekNumber(jobDate);
        if (jobWeek.year !== parsed.year || jobWeek.week !== parsed.week) continue;

        const failedReason = job.failedReason || 'unknown';
        const isBotDetected = failedReason.startsWith('bot_detected:') ||
          failedReason.startsWith('blank_page:') ||
          failedReason.toLowerCase().includes('bot detection');

        failures.push({
          url: job.data.url,
          originalUrl: job.data.originalUrl,
          failureReason: failedReason,
          failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : jobDate.toISOString(),
          isBotDetected,
          jobId: job.id!,
        });
      }
    }

    // Sort by failedAt descending (newest first)
    failures.sort((a, b) => {
      return new Date(b.failedAt).getTime() - new Date(a.failedAt).getTime();
    });

    res.json(failures);
  } catch (error) {
    console.error('Failed to list failures for week:', {
      weekId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to list failures for week',
    });
  }
});

/**
 * Extract source URL from PDF metadata (Subject field)
 * Returns null if metadata cannot be read or URL not found
 */
async function extractUrlFromPdf(pdfPath: string): Promise<string | null> {
  try {
    const pdfBytes = await readFile(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const subject = pdfDoc.getSubject();
    // Validate it looks like a URL
    if (subject && (subject.startsWith('http://') || subject.startsWith('https://'))) {
      return subject;
    }
    return null;
  } catch {
    return null;
  }
}

// PDF info reads for the GET /weeks/:weekId path live in loadPdfFileInfo above
// (single read for url + enriched metadata). The standalone extractUrlFromPdf
// is still used by the rerun handlers below where only the URL is needed.

/**
 * POST /weeks/:weekId/rerun - Rerun all URLs from a specific week
 *
 * Collects URLs from:
 * 1. Completed jobs in BullMQ (recent, within retention period)
 * 2. Failed jobs in BullMQ
 * 3. PDF metadata (for older files outside BullMQ retention)
 *
 * Resubmits all unique URLs for processing. Existing PDFs will be overwritten.
 *
 * Status codes:
 * - 200 OK with { submitted: number, urls: string[] }
 * - 400 Bad Request if weekId invalid format
 * - 500 Internal Server Error on failure
 */
filesRouter.post('/weeks/:weekId/rerun', requireApiToken, async (req: Request, res: Response): Promise<void> => {
  const weekId = req.params.weekId;

  // Validate weekId format
  if (!isValidWeekId(weekId)) {
    res.status(400).json({
      error: 'Invalid week ID format. Expected YYYY-WWW (e.g., 2026-W04)',
    });
    return;
  }

  try {
    const parsed = parseWeekId(weekId);
    if (!parsed) {
      res.status(400).json({
        error: 'Invalid week ID format',
      });
      return;
    }

    const urlsToRerun = new Set<string>();
    const urlToOldFile = new Map<string, string>();

    // 1. Get URLs from completed jobs in indexed week set (fallback to full queue scan)
    const indexedCompleted = await getWeekIndexedJobIds(weekId, 'completed');
    if (indexedCompleted.length > 0) {
      for (const jobId of indexedCompleted) {
        const job = await conversionQueue.getJob(jobId);
        if (!job) continue;

        const urlToUse = job.data.originalUrl || job.data.url;
        if (!urlToUse) continue;

        urlsToRerun.add(urlToUse);
        if (job.returnvalue?.pdfPath) {
          urlToOldFile.set(urlToUse, path.resolve(job.returnvalue.pdfPath));
        }
      }
    } else {
      const completedJobs = await conversionQueue.getCompleted();
      for (const job of completedJobs) {
        const jobDate = new Date(job.timestamp);
        const jobWeek = getISOWeekNumber(jobDate);
        if (jobWeek.year === parsed.year && jobWeek.week === parsed.week) {
          const urlToUse = job.data.originalUrl || job.data.url;
          if (urlToUse) {
            urlsToRerun.add(urlToUse);
            if (job.returnvalue?.pdfPath) {
              urlToOldFile.set(urlToUse, path.resolve(job.returnvalue.pdfPath));
            }
          }
        }
      }
    }

    // 2. Get URLs from failed jobs in indexed week set (fallback to full queue scan)
    const indexedFailed = await getWeekIndexedJobIds(weekId, 'failed');
    if (indexedFailed.length > 0) {
      for (const jobId of indexedFailed) {
        const job = await conversionQueue.getJob(jobId);
        if (!job) continue;
        const urlToUse = job.data.originalUrl || job.data.url;
        if (urlToUse) urlsToRerun.add(urlToUse);
      }
    } else {
      const failedJobs = await conversionQueue.getFailed();
      for (const job of failedJobs) {
        const jobDate = new Date(job.timestamp);
        const jobWeek = getISOWeekNumber(jobDate);
        if (jobWeek.year === parsed.year && jobWeek.week === parsed.week) {
          const urlToUse = job.data.originalUrl || job.data.url;
          if (urlToUse) urlsToRerun.add(urlToUse);
        }
      }
    }

    // 3. Get URLs from PDF metadata (for files outside BullMQ retention)
    // Disk scan overwrites BullMQ paths — reflects actual current state
    const weekPath = path.join(env.DATA_DIR, 'media', weekId);
    const pdfDir = path.join(weekPath, 'pdfs');

    try {
      const pdfFiles = await readdir(pdfDir);
      for (const file of pdfFiles) {
        if (file.endsWith('.pdf')) {
          const pdfFilePath = path.join(pdfDir, file);
          const url = await extractUrlFromPdf(pdfFilePath);
          if (url) {
            urlsToRerun.add(url);
            urlToOldFile.set(url, path.resolve(pdfFilePath));
          }
        }
      }
    } catch (error) {
      // PDF directory might not exist, that's OK
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    // Submit all URLs for reprocessing
    const urls = Array.from(urlsToRerun);
    const jobs = [];

    for (const url of urls) {
      // Route podcast URLs to podcast queue, others to conversion queue
      if (isApplePodcastsUrl(url)) {
        const podcastJobData: PodcastJobData = {
          url,
          originalUrl: url,
          source: 'rerun',
        };
        const job = await podcastQueue.add('transcribe-podcast', podcastJobData);
        jobs.push({ jobId: job.id, url, type: 'podcast' });
      } else {
        const job = await conversionQueue.add('convert-url', {
          url,
          originalUrl: url, // Preserve original for archive.is links
          oldFilePath: urlToOldFile.get(url),
        });
        jobs.push({ jobId: job.id, url, type: 'pdf' });
      }
    }

    console.log(JSON.stringify({
      event: 'week_rerun',
      weekId,
      urlCount: urls.length,
      timestamp: new Date().toISOString(),
    }));

    // Send Discord notification
    await notifyWeekRerun({ weekId, urlCount: urls.length });

    res.json({
      submitted: urls.length,
      jobs,
    });
  } catch (error) {
    console.error('Failed to rerun week:', {
      weekId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to rerun week',
    });
  }
});

/**
 * POST /delete - Delete selected files
 *
 * Request body: { files: string[] } - Array of file paths relative to DATA_DIR
 *
 * Status codes:
 * - 200 OK with { deleted: number }
 * - 400 Bad Request if files array is missing
 * - 500 Internal Server Error on failure
 */
filesRouter.post('/delete', requireApiToken, async (req: Request, res: Response): Promise<void> => {
  const { files } = req.body as { files?: string[] };

  if (!files || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({
      error: 'files array is required',
    });
    return;
  }

  try {
    const { unlink } = await import('node:fs/promises');
    const dataDir = path.resolve(env.DATA_DIR);
    let deleted = 0;

    for (const filePath of files) {
      // Resolve full path and ensure it's within DATA_DIR
      const fullPath = resolveWithinRoot(dataDir, filePath);
      if (!fullPath) {
        console.warn(`Delete rejected - path outside DATA_DIR: ${filePath}`);
        continue;
      }

      try {
        await unlink(fullPath);
        deleted++;
        console.log(`Deleted: ${fullPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`Failed to delete ${fullPath}:`, error);
        }
      }
    }

    res.json({ deleted });
  } catch (error) {
    console.error('Failed to delete files:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to delete files',
    });
  }
});

/**
 * POST /delete-failures - Delete failed jobs from BullMQ
 *
 * Request body: { jobIds: string[] } - Array of job IDs to remove
 *
 * Status codes:
 * - 200 OK with { deleted: number }
 * - 400 Bad Request if jobIds array is missing
 * - 500 Internal Server Error on failure
 */
filesRouter.post('/delete-failures', requireApiToken, async (req: Request, res: Response): Promise<void> => {
  const { jobIds } = req.body as { jobIds?: string[] };

  if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
    res.status(400).json({
      error: 'jobIds array is required',
    });
    return;
  }

  try {
    let deleted = 0;

    for (const jobId of jobIds) {
      try {
        const job = await conversionQueue.getJob(jobId);
        if (job) {
          await job.remove();
          deleted++;
          console.log(`Removed failed job: ${jobId}`);
        }
      } catch (error) {
        console.error(`Failed to remove job ${jobId}:`, error);
      }
    }

    res.json({ deleted });
  } catch (error) {
    console.error('Failed to delete failures:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to delete failures',
    });
  }
});

/**
 * POST /rerun-selected - Rerun selected items
 *
 * Request body:
 * - files: string[] - Array of file paths relative to DATA_DIR (URLs extracted from PDF metadata)
 * - urls: string[] - Array of URLs to rerun directly (for failed items)
 *
 * Status codes:
 * - 200 OK with { submitted: number, jobs: [...] }
 * - 400 Bad Request if neither files nor urls provided
 * - 500 Internal Server Error on failure
 */
filesRouter.post('/rerun-selected', requireApiToken, async (req: Request, res: Response): Promise<void> => {
  const { files, urls, videos } = req.body as { files?: string[]; urls?: string[]; videos?: string[] };

  const hasFiles = files && Array.isArray(files) && files.length > 0;
  const hasUrls = urls && Array.isArray(urls) && urls.length > 0;
  const hasVideos = videos && Array.isArray(videos) && videos.length > 0;

  if (!hasFiles && !hasUrls && !hasVideos) {
    res.status(400).json({
      error: 'files, urls, or videos array is required',
    });
    return;
  }

  try {
    const dataDir = path.resolve(env.DATA_DIR);
    const urlsToRerun: string[] = [];
    const urlToOldFile = new Map<string, string>();

    // Extract URLs from PDF files
    if (hasFiles) {
      for (const filePath of files!) {
        // Only process PDF files
        if (!filePath.endsWith('.pdf')) continue;

        // Resolve full path and ensure it's within DATA_DIR
        const fullPath = resolveWithinRoot(dataDir, filePath);
        if (!fullPath) {
          continue;
        }

        // Extract URL from PDF metadata
        const url = await extractUrlFromPdf(fullPath);
        if (url) {
          urlsToRerun.push(url);
          urlToOldFile.set(url, fullPath);
        }
      }
    }

    // Add direct URLs from failed items (no old file to track)
    if (hasUrls) {
      for (const url of urls!) {
        // Basic validation - must look like a URL
        if (url.startsWith('http://') || url.startsWith('https://')) {
          urlsToRerun.push(url);
        }
      }
    }

    // Submit URLs for reprocessing
    const jobs = [];

    // Video re-enrichment: read each MP4's embedded metadata, submit a re-enrich job
    // that reuses the on-disk file (skips download).
    if (hasVideos) {
      for (const vidPath of videos!) {
        if (!vidPath.toLowerCase().endsWith('.mp4')) continue;
        const fullPath = resolveWithinRoot(dataDir, vidPath);
        if (!fullPath) continue;

        const videoMeta = await readVideoMetadata(fullPath);
        const sourceUrl = videoMeta?.sourceUrl || `file://${fullPath}`;

        // Construct the minimum MediaItem needed for enrichVideo to run
        const item: MediaItem = {
          url: sourceUrl,
          canonicalUrl: sourceUrl,
          guid: path.basename(fullPath),
          source: 'karakeep',
          mediaType: 'video',
          enclosure: { url: sourceUrl, type: 'video/mp4' },
          title: videoMeta?.title,
        };

        const job = await mediaCollectionQueue.add('reenrich-video', {
          item,
          existingFilePath: fullPath,
        });
        jobs.push({ jobId: job.id, url: sourceUrl, type: 'video-reenrich', path: vidPath });
      }
    }

    for (const url of urlsToRerun) {
      // Route podcast URLs to podcast queue, others to conversion queue
      if (isApplePodcastsUrl(url)) {
        const podcastJobData: PodcastJobData = {
          url,
          originalUrl: url,
          source: 'rerun',
        };
        const job = await podcastQueue.add('transcribe-podcast', podcastJobData);
        jobs.push({ jobId: job.id, url, type: 'podcast' });
      } else {
        const job = await conversionQueue.add('convert-url', {
          url,
          originalUrl: url,
          oldFilePath: urlToOldFile.get(url),
        });
        jobs.push({ jobId: job.id, url, type: 'pdf' });
      }
    }

    console.log(JSON.stringify({
      event: 'rerun_selected',
      urlCount: urlsToRerun.length,
      timestamp: new Date().toISOString(),
    }));

    res.json({
      submitted: jobs.length,
      jobs,
    });
  } catch (error) {
    console.error('Failed to rerun selected:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    res.status(500).json({
      error: 'Failed to rerun selected items',
    });
  }
});

/**
 * GET /metadata/:filePath
 * Get full enriched metadata (including translation) from a PDF's Info Dict
 * filePath is relative to DATA_DIR (e.g., media/2026-W14/pdfs/example.com-article.pdf)
 */
filesRouter.get('/metadata/*', async (req: Request, res: Response): Promise<void> => {
  try {
    let relativePath = (req.params as Record<string, string>)[0];
    if (!relativePath.endsWith('.pdf')) relativePath += '.pdf';
    const dataDir = env.DATA_DIR || './data';
    const pdfPath = resolveWithinRoot(dataDir, relativePath);
    if (!pdfPath) {
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }

    const pdfBytes = await readFile(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    const tagsStr = readInfoDictField(pdfDoc, 'Tags');

    const metadata = {
      title: pdfDoc.getTitle() || null,
      author: pdfDoc.getAuthor() || null,
      publication: readInfoDictField(pdfDoc, 'Publication') || null,
      publishDate: readInfoDictField(pdfDoc, 'PublishDate') || null,
      language: readInfoDictField(pdfDoc, 'Language') || null,
      summary: readInfoDictField(pdfDoc, 'Summary') || null,
      tags: tagsStr ? tagsStr.split(', ').filter(Boolean) : [],
      translation: readInfoDictField(pdfDoc, 'Translation') || null,
      sourceUrl: pdfDoc.getSubject() || null,
      enrichedAt: readInfoDictField(pdfDoc, 'EnrichedAt') || null,
    };

    res.json(metadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: 'PDF not found' });
    } else {
      res.status(500).json({ error: 'Failed to read metadata' });
    }
  }
});
