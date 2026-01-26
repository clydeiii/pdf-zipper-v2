/**
 * REST API routes for file browsing
 *
 * GET /weeks - List all week directories
 * GET /weeks/:weekId - List files in a specific week
 * POST /weeks/:weekId/rerun - Rerun all URLs from a week
 */

import { Router, Request, Response } from 'express';
import { readdir, stat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { env } from '../../config/env.js';
import { conversionQueue } from '../../queues/conversion.queue.js';
import { podcastQueue } from '../../podcasts/podcast.queue.js';
import { isApplePodcastsUrl } from '../../podcasts/apple.js';
import { getISOWeekNumber } from '../../media/organization.js';
import { notifyWeekRerun } from '../../notifications/discord.js';
import type { PodcastJobData } from '../../podcasts/types.js';

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

    const files: FileInfo[] = [];

    // Scan subdirectories for files
    const subdirs: Array<{ name: string; defaultType: 'video' | 'transcript' | 'pdf' | 'audio' }> = [
      { name: 'videos', defaultType: 'video' },
      { name: 'transcripts', defaultType: 'transcript' },
      { name: 'pdfs', defaultType: 'pdf' },
      { name: 'podcasts', defaultType: 'pdf' },  // Podcasts folder has PDFs and audio
    ];

    // Track files by base name for linking related files (podcast PDF ↔ audio)
    const filesByBaseName = new Map<string, FileInfo[]>();

    for (const subdir of subdirs) {
      const subdirPath = path.join(weekPath, subdir.name);

      try {
        const entries = await readdir(subdirPath);

        for (const entry of entries) {
          const filePath = path.join(subdirPath, entry);
          const stats = await stat(filePath);

          if (stats.isFile()) {
            // Path relative to DATA_DIR
            const relativePath = path.relative(env.DATA_DIR, filePath);

            // Determine file type by extension
            const ext = path.extname(entry).toLowerCase();
            let fileType: 'video' | 'transcript' | 'pdf' | 'audio' = subdir.defaultType;
            if (ext === '.mp3' || ext === '.m4a' || ext === '.wav' || ext === '.ogg') {
              fileType = 'audio';
            } else if (ext === '.pdf') {
              fileType = 'pdf';
            } else if (ext === '.mp4' || ext === '.webm') {
              fileType = 'video';
            }

            // Extract source URL from PDF metadata
            let sourceUrl: string | undefined;
            if (fileType === 'pdf') {
              sourceUrl = await extractUrlFromPdf(filePath) || undefined;
            }

            const fileInfo: FileInfo = {
              name: entry,
              path: relativePath,
              size: stats.size,
              modified: stats.mtime.toISOString(),
              type: fileType,
              sourceUrl,
            };

            files.push(fileInfo);

            // Track by base name for podcasts folder (to link PDF ↔ audio)
            if (subdir.name === 'podcasts') {
              const baseName = path.basename(entry, ext);
              if (!filesByBaseName.has(baseName)) {
                filesByBaseName.set(baseName, []);
              }
              filesByBaseName.get(baseName)!.push(fileInfo);
            }
          }
        }
      } catch (error) {
        // Subdirectory doesn't exist, skip
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    // Link related files in podcasts folder (PDF ↔ audio)
    for (const [_baseName, relatedFiles] of filesByBaseName) {
      if (relatedFiles.length > 1) {
        // Find the PDF and audio files
        const pdfFile = relatedFiles.find(f => f.type === 'pdf');
        const audioFile = relatedFiles.find(f => f.type === 'audio');

        if (pdfFile && audioFile) {
          // Link them to each other
          pdfFile.relatedFiles = [audioFile.path];
          audioFile.relatedFiles = [pdfFile.path];
        }
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

    // Get all failed jobs from the queue
    const failedJobs = await conversionQueue.getFailed();

    const failures: FailureInfo[] = [];

    // Filter jobs by week based on when they were created
    for (const job of failedJobs) {
      // job.timestamp is when the job was created
      const jobDate = new Date(job.timestamp);
      const jobWeek = getISOWeekNumber(jobDate);

      // Match against requested week
      if (jobWeek.year === parsed.year && jobWeek.week === parsed.week) {
        // BullMQ stores error message in failedReason for failed jobs
        const failedReason = job.failedReason || 'unknown';
        // Check if failure is due to bot detection (blank_page also indicates bot blocking)
        const isBotDetected = failedReason.startsWith('bot_detected:') ||
          failedReason.startsWith('blank_page:') ||
          failedReason.toLowerCase().includes('bot detection');

        failures.push({
          url: job.data.url,
          originalUrl: job.data.originalUrl,  // Preserved for archive.is links
          failureReason: failedReason,
          failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : jobDate.toISOString(),
          isBotDetected,
          jobId: job.id!,  // For debug screenshot link
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
filesRouter.post('/weeks/:weekId/rerun', async (req: Request, res: Response): Promise<void> => {
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

    // 1. Get URLs from completed jobs in BullMQ
    const completedJobs = await conversionQueue.getCompleted();
    for (const job of completedJobs) {
      const jobDate = new Date(job.timestamp);
      const jobWeek = getISOWeekNumber(jobDate);
      if (jobWeek.year === parsed.year && jobWeek.week === parsed.week) {
        // Use originalUrl if available, otherwise use url
        const urlToUse = job.data.originalUrl || job.data.url;
        if (urlToUse) {
          urlsToRerun.add(urlToUse);
        }
      }
    }

    // 2. Get URLs from failed jobs in BullMQ
    const failedJobs = await conversionQueue.getFailed();
    for (const job of failedJobs) {
      const jobDate = new Date(job.timestamp);
      const jobWeek = getISOWeekNumber(jobDate);
      if (jobWeek.year === parsed.year && jobWeek.week === parsed.week) {
        const urlToUse = job.data.originalUrl || job.data.url;
        if (urlToUse) {
          urlsToRerun.add(urlToUse);
        }
      }
    }

    // 3. Get URLs from PDF metadata (for files outside BullMQ retention)
    const weekPath = path.join(env.DATA_DIR, 'media', weekId);
    const pdfDir = path.join(weekPath, 'pdfs');

    try {
      const pdfFiles = await readdir(pdfDir);
      for (const file of pdfFiles) {
        if (file.endsWith('.pdf')) {
          const pdfPath = path.join(pdfDir, file);
          const url = await extractUrlFromPdf(pdfPath);
          if (url) {
            urlsToRerun.add(url);
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
filesRouter.post('/delete', async (req: Request, res: Response): Promise<void> => {
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
      const fullPath = path.resolve(dataDir, filePath);
      if (!fullPath.startsWith(dataDir)) {
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
filesRouter.post('/delete-failures', async (req: Request, res: Response): Promise<void> => {
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
filesRouter.post('/rerun-selected', async (req: Request, res: Response): Promise<void> => {
  const { files, urls } = req.body as { files?: string[]; urls?: string[] };

  const hasFiles = files && Array.isArray(files) && files.length > 0;
  const hasUrls = urls && Array.isArray(urls) && urls.length > 0;

  if (!hasFiles && !hasUrls) {
    res.status(400).json({
      error: 'files or urls array is required',
    });
    return;
  }

  try {
    const dataDir = path.resolve(env.DATA_DIR);
    const urlsToRerun: string[] = [];

    // Extract URLs from PDF files
    if (hasFiles) {
      for (const filePath of files!) {
        // Only process PDF files
        if (!filePath.endsWith('.pdf')) continue;

        // Resolve full path and ensure it's within DATA_DIR
        const fullPath = path.resolve(dataDir, filePath);
        if (!fullPath.startsWith(dataDir)) {
          continue;
        }

        // Extract URL from PDF metadata
        const url = await extractUrlFromPdf(fullPath);
        if (url) {
          urlsToRerun.push(url);
        }
      }
    }

    // Add direct URLs from failed items
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
      submitted: urlsToRerun.length,
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
