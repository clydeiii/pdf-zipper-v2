/**
 * Conversion worker for URL-to-PDF processing
 *
 * Features:
 * - Processes jobs from the url-conversion queue
 * - Logs structured error data on failure (CONV-04)
 * - Graceful shutdown on SIGTERM/SIGINT
 */

import { Worker, Job } from 'bullmq';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { workerConnection } from '../config/redis.js';
import { QUEUE_NAME } from '../queues/conversion.queue.js';
import { env } from '../config/env.js';
import type { ConversionJobData, ConversionJobResult } from '../jobs/types.js';
import { initBrowser, closeBrowser } from '../browsers/manager.js';
import { convertUrlToPDF, isPdfUrl, downloadPdfDirect } from '../converters/pdf.js';
import { checkOllamaHealth } from '../quality/ollama.js';
import { scoreScreenshotQuality } from '../quality/scorer.js';
import { analyzePdfContent } from '../quality/pdf-content.js';
import { getISOWeekNumber } from '../media/organization.js';
import { notifyJobComplete, notifyJobFailed, isDiscordEnabled } from '../notifications/discord.js';

// Import CommonJS module using require
const require = createRequire(import.meta.url);
const sanitizeFilename = require('sanitize-filename') as (input: string) => string;

/** Flag to prevent multiple shutdown attempts */
let isShuttingDown = false;

/**
 * Embed source URL and metadata in PDF document properties
 * Uses pdf-lib to modify the PDF's metadata fields:
 * - Subject: Original source URL (used for rerun feature)
 * - Producer: pdf-zipper with timestamp
 */
async function embedPdfMetadata(pdfBuffer: Buffer, sourceUrl: string, originalUrl?: string): Promise<Buffer> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);

    // Store the original URL (with www preserved) in Subject field for rerun feature
    // Fall back to sourceUrl if originalUrl not provided
    pdfDoc.setSubject(originalUrl || sourceUrl);

    // Add producer info with capture timestamp
    pdfDoc.setProducer(`pdf-zipper v2 - captured ${new Date().toISOString()}`);

    // Save and return modified PDF
    const modifiedPdf = await pdfDoc.save();
    return Buffer.from(modifiedPdf);
  } catch (error) {
    // If metadata embedding fails, return original PDF
    console.warn(`Failed to embed PDF metadata for ${sourceUrl}:`, error);
    return pdfBuffer;
  }
}

/**
 * Save debug PDF for failed jobs
 * Path: {DATA_DIR}/debug/{jobId}.pdf
 * These can be viewed via /api/debug/:jobId endpoint
 *
 * Saves the actual PDF (not screenshot) so issues like truncation can be inspected
 */
async function saveDebugPdf(jobId: string, pdfBuffer: Buffer): Promise<string | null> {
  if (pdfBuffer.length === 0) return null;

  try {
    const dataDir = env.DATA_DIR || './data';
    const debugDir = path.join(dataDir, 'debug');
    await mkdir(debugDir, { recursive: true });

    const filename = `${jobId}.pdf`;
    const filePath = path.join(debugDir, filename);
    await writeFile(filePath, pdfBuffer);

    console.log(`Debug PDF saved: ${filePath}`);
    return filePath;
  } catch (error) {
    console.error(`Failed to save debug PDF for job ${jobId}:`, error);
    return null;
  }
}

/**
 * Delete the old PDF after a rerun if the new file has a different path.
 * No-op when paths match (writeFile already overwrote).
 * Best-effort: errors are logged but don't fail the job.
 */
async function deleteOldFileIfDifferent(oldFilePath: string, newFilePath: string): Promise<void> {
  const oldNorm = path.resolve(oldFilePath);
  const newNorm = path.resolve(newFilePath);
  if (oldNorm === newNorm) return; // same file — writeFile already overwrote
  try {
    await unlink(oldNorm);
    console.log(`Deleted old PDF (rerun): ${oldNorm}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`Old PDF already deleted: ${oldNorm}`);
    } else {
      console.error(`Failed to delete old PDF ${oldNorm}:`, error);
    }
  }
}

/**
 * Save PDF to weekly bin directory
 * Path: {DATA_DIR}/media/{year}-W{week}/pdfs/{filename}.pdf
 *
 * Filename format: {hostname}{pathname}.pdf
 * - Slashes replaced with dashes
 * - Trailing dashes removed
 * - www. prefix stripped from hostname
 * Example: nytimes.com-2026-01-15-business-article.pdf
 */
/**
 * Convert a title to a URL-safe slug
 * Lowercase, spaces to dashes, remove special characters
 */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['']/g, '')           // Remove apostrophes
    .replace(/[^a-z0-9\s-]/g, '')   // Remove special characters
    .replace(/\s+/g, '-')           // Spaces to dashes
    .replace(/-+/g, '-')            // Collapse multiple dashes
    .replace(/^-|-$/g, '')          // Trim leading/trailing dashes
    .substring(0, 50);              // Limit length
}

/**
 * Check if URL is a Twitter/X URL
 */
function isTwitterUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === 'x.com' || host === 'twitter.com' || host === 'www.x.com' || host === 'www.twitter.com';
  } catch {
    return false;
  }
}

async function savePdfToWeeklyBin(
  pdfBuffer: Buffer,
  url: string,
  title?: string,
  bookmarkedAt?: string,
  originalUrl?: string,
  isXArticle?: boolean
): Promise<string> {
  // Embed source URL in PDF metadata for rerun feature
  const pdfWithMetadata = await embedPdfMetadata(pdfBuffer, url, originalUrl);

  // Use bookmarkedAt or current date for week calculation
  const date = bookmarkedAt ? new Date(bookmarkedAt) : new Date();
  const { year, week } = getISOWeekNumber(date);
  const weekStr = week.toString().padStart(2, '0');

  // Build directory path
  const dataDir = env.DATA_DIR || './data';
  const pdfDir = path.join(dataDir, 'media', `${year}-W${weekStr}`, 'pdfs');

  // Ensure directory exists
  await mkdir(pdfDir, { recursive: true });

  // Generate filename from URL, with title fallback for non-descriptive paths
  let baseName: string;
  try {
    const parsed = new URL(url);
    // Strip www. prefix for cleaner names
    let hostname = parsed.hostname;
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    // Replace slashes with dashes, remove trailing dash
    let pathname = parsed.pathname.replace(/\//g, '-');
    if (pathname.endsWith('-')) {
      pathname = pathname.slice(0, -1);
    }
    // Remove leading dash if present (from leading /)
    if (pathname.startsWith('-')) {
      pathname = pathname.substring(1);
    }

    // Check if pathname is non-descriptive (needs title fallback)
    // Examples: HN "item", Reddit "comments", etc.
    const nonDescriptivePaths = ['item', 'comments', 'post', 'p', 'a', 'article', 'story', 's'];
    const isNonDescriptive = !pathname || nonDescriptivePaths.includes(pathname.toLowerCase());

    // Use title for non-descriptive paths or empty paths
    if (isNonDescriptive && title) {
      const titleSlug = slugifyTitle(title);
      if (titleSlug) {
        baseName = `${hostname}-${titleSlug}`;
      } else {
        baseName = pathname ? `${hostname}-${pathname}` : hostname;
      }
    } else {
      baseName = pathname ? `${hostname}-${pathname}` : hostname;
    }

    // For Twitter/X URLs, replace "status" with more descriptive term
    // isXArticle = true: X Article (captured directly from X.com)
    // isXArticle = false: regular tweet (captured via Nitter)
    if (isTwitterUrl(url) && baseName.includes('-status-')) {
      if (isXArticle === true) {
        baseName = baseName.replace('-status-', '-article-');
      } else if (isXArticle === false) {
        baseName = baseName.replace('-status-', '-post-');
      }
      // if isXArticle is undefined, leave as "status" (shouldn't happen for Twitter URLs)
    }
  } catch {
    baseName = 'document';
  }

  // Sanitize and truncate filename
  baseName = sanitizeFilename(baseName).substring(0, 100);
  const filename = `${baseName}.pdf`;
  const filePath = path.join(pdfDir, filename);

  // Write PDF with embedded metadata to disk
  await writeFile(filePath, pdfWithMetadata);

  return filePath;
}

/**
 * Process a conversion job
 *
 * Converts URL to PDF using Playwright browser.
 * Scores PDF quality using vision model.
 * Throws on failure to trigger BullMQ retry logic.
 */
async function processJob(job: Job<ConversionJobData, ConversionJobResult>): Promise<ConversionJobResult> {
  console.log(`[DEBUG] processJob called for job ${job.id}`);
  const { url, originalUrl, userId, title: jobTitle, bookmarkedAt, oldFilePath } = job.data;

  console.log(`Processing job ${job.id} for URL: ${url}${userId ? ` (user: ${userId})` : ''}`);

  // Initial progress
  await job.updateProgress(10);

  // Check if this is a direct PDF URL - use pass-through instead of conversion
  if (isPdfUrl(url)) {
    console.log(`PDF URL detected, using pass-through: ${url}`);
    const passthroughResult = await downloadPdfDirect(url);

    await job.updateProgress(50);

    if (!passthroughResult.success) {
      console.log(`PDF pass-through failed for ${url}: ${passthroughResult.reason} - ${passthroughResult.error}`);
      throw new Error(`${passthroughResult.reason}: ${passthroughResult.error}`);
    }

    // Use suggested filename from Content-Disposition, or job title, or extract from URL
    const title = jobTitle || passthroughResult.suggestedFilename?.replace(/\.pdf$/i, '');

    // Save directly to weekly bin (skip quality checks - it's an existing PDF)
    const filePath = await savePdfToWeeklyBin(
      passthroughResult.pdfBuffer,
      url,
      title,
      bookmarkedAt,
      originalUrl
    );

    await job.updateProgress(100);

    console.log(`PDF pass-through completed: ${filePath}`);

    if (oldFilePath) await deleteOldFileIfDifferent(oldFilePath, filePath);

    return {
      pdfPath: filePath,
      pdfSize: passthroughResult.size,
      completedAt: new Date().toISOString(),
      url,
    };
  }

  // Convert URL to PDF (regular flow)
  const result = await convertUrlToPDF(url);

  // Use job title if provided, otherwise use extracted page title
  const title = jobTitle || (result.success ? result.pageTitle : undefined);
  // Track if this was an X Article capture (for filename generation)
  const isXArticle = result.success ? result.isXArticle : undefined;

  // Update progress
  await job.updateProgress(50);

  if (!result.success) {
    console.log(`Conversion failed for ${url}: ${result.reason} - ${result.error}`);
    throw new Error(`${result.reason}: ${result.error}`);
  }

  // Check for blank page BEFORE saving (screenshot too small = blank/bot detection)
  // A real page screenshot is typically 50KB+, blank pages are <10KB
  const MIN_SCREENSHOT_SIZE = 15000; // 15KB minimum
  const MIN_PDF_SIZE = 5000; // 5KB minimum

  // Skip screenshot check if capture failed (0 bytes) - just use PDF size
  const screenshotFailed = result.screenshotBuffer.length === 0;
  const isBlankPage = screenshotFailed
    ? result.pdfBuffer.length < MIN_PDF_SIZE
    : result.screenshotBuffer.length < MIN_SCREENSHOT_SIZE || result.pdfBuffer.length < MIN_PDF_SIZE;

  if (isBlankPage) {
    console.warn(`Blank page detected for ${url} - screenshot: ${result.screenshotBuffer.length}B, PDF: ${result.pdfBuffer.length}B`);
    // Save debug PDF before failing (so user can inspect the actual output)
    await saveDebugPdf(job.id!, result.pdfBuffer);
    // Throw error so job goes to failed queue with clickable URL
    throw new Error(`bot_detected: Page is blank - likely bot detection blocked content (screenshot: ${result.screenshotBuffer.length}B, PDF: ${result.pdfBuffer.length}B)`);
  }

  // Score quality using screenshot BEFORE saving PDF
  // Skip quality scoring if screenshot capture failed
  let qualityResult;
  try {
    if (screenshotFailed) {
      // No screenshot to score - assume quality passed
      qualityResult = { passed: true, score: { score: -1, reasoning: 'Screenshot capture failed, quality check skipped', issue: undefined } };
      console.log(`Quality check skipped for ${url} - screenshot capture failed`);
    } else {
      qualityResult = await scoreScreenshotQuality(result.screenshotBuffer);
      console.log(`Quality score for ${url}: ${qualityResult.score.score} - ${qualityResult.score.reasoning}`);
      if (!qualityResult.passed) {
        // Save debug PDF before failing (so user can inspect the actual output)
        await saveDebugPdf(job.id!, result.pdfBuffer);
        // Quality check failed - throw error to fail the job
        // This ensures failed PDFs don't get saved and show as clickable failures in UI
        const issue = qualityResult.score.issue || 'quality_failed';
        throw new Error(`${issue}: ${qualityResult.score.reasoning}`);
      }
    }
  } catch (error) {
    // Re-throw quality failures (they have the issue: prefix)
    if (error instanceof Error && (
      error.message.startsWith('blank_page:') ||
      error.message.startsWith('paywall:') ||
      error.message.startsWith('bot_detected:') ||
      error.message.startsWith('quality_failed:') ||
      error.message.startsWith('truncated:') ||
      error.message.startsWith('low_contrast:') ||
      error.message.startsWith('missing_content:') ||
      error.message.startsWith('unknown:')
    )) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Quality scoring failed for ${url}: ${message}`);
    // Fallback to passing if Ollama is unavailable (don't block on Ollama issues)
    qualityResult = {
      passed: true,
      score: { score: 50, issue: undefined as string | undefined, reasoning: `Quality scoring error: ${message}` },
    };
  }

  // Check PDF content for truncation (catches paywalls that screenshot check misses)
  const contentResult = await analyzePdfContent(result.pdfBuffer);
  console.log(`PDF content analysis for ${url}: ${contentResult.charCount} chars, ${contentResult.pageCount} pages, ${contentResult.charsPerKb} chars/KB`);

  if (!contentResult.passed) {
    // Save debug PDF before failing
    await saveDebugPdf(job.id!, result.pdfBuffer);
    throw new Error(`truncated: ${contentResult.reason}`);
  }

  await job.updateProgress(90);

  // Only save PDF after quality check passes
  const pdfPath = await savePdfToWeeklyBin(result.pdfBuffer, url, title, bookmarkedAt, originalUrl, isXArticle);
  console.log(`PDF saved to: ${pdfPath}`);

  if (oldFilePath) await deleteOldFileIfDifferent(oldFilePath, pdfPath);

  // Final progress
  await job.updateProgress(100);

  // Return success result with quality data
  return {
    pdfPath,

    pdfSize: result.size,
    completedAt: new Date().toISOString(),
    url,
    qualityScore: qualityResult.score.score,
    qualityReasoning: qualityResult.score.reasoning,
  };
}

/**
 * BullMQ worker for processing conversion jobs
 *
 * Configuration:
 * - concurrency: 1 (vision model is CPU/memory intensive)
 * - connection: workerConnection (with maxRetriesPerRequest: null)
 */
export const conversionWorker = new Worker<ConversionJobData, ConversionJobResult>(
  QUEUE_NAME,
  processJob,
  {
    connection: workerConnection,
    concurrency: 1,
  }
);

// Debug: log when worker receives a job
conversionWorker.on('active', (job) => {
  console.log(`[DEBUG] Worker activated job: ${job.id}`);
});

/**
 * Handle successful job completion
 */
conversionWorker.on('completed', async (job: Job<ConversionJobData, ConversionJobResult>) => {
  console.log(`Job ${job.id} completed successfully`);

  // Send Discord notification
  const result = job.returnvalue;
  if (result) {
    // Calculate duration from job timestamps
    const duration = job.finishedOn && job.processedOn
      ? job.finishedOn - job.processedOn
      : undefined;

    await notifyJobComplete({
      jobId: job.id!,
      url: job.data.originalUrl || job.data.url,
      pdfPath: result.pdfPath,
      pdfSize: result.pdfSize,
      qualityScore: result.qualityScore,
      qualityReasoning: result.qualityReasoning,
      duration,
    });
  }
});

/**
 * Handle job failure with structured error logging (CONV-04)
 *
 * Logs actionable error data including:
 * - jobId, url for identification
 * - attemptsMade and maxAttempts for retry context
 * - error message and stack for debugging
 * - timestamp for correlation
 */
conversionWorker.on('failed', async (job: Job<ConversionJobData, ConversionJobResult> | undefined, error: Error) => {
  const errorData = {
    event: 'job_failed',
    jobId: job?.id ?? 'unknown',
    url: job?.data?.url ?? 'unknown',
    attemptsMade: job?.attemptsMade ?? 0,
    maxAttempts: job?.opts?.attempts ?? 3,
    error: {
      message: error.message,
      stack: error.stack,
    },
    timestamp: new Date().toISOString(),
  };

  console.error('Job failed:', JSON.stringify(errorData, null, 2));

  // Send Discord notification (only on final failure, not retries)
  if (job && job.attemptsMade >= (job.opts?.attempts ?? 3)) {
    // Extract failure reason from error message prefix
    const reasonMatch = error.message.match(/^(\w+):/);
    const reason = reasonMatch ? reasonMatch[1] : undefined;

    await notifyJobFailed({
      jobId: job.id!,
      url: job.data.originalUrl || job.data.url,
      error: error.message,
      reason,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts ?? 3,
    });
  }
});

/**
 * Handle unexpected worker-level errors
 */
conversionWorker.on('error', (error: Error) => {
  console.error(`Worker error: ${error.message}`);
});

/**
 * Graceful shutdown handler
 *
 * Waits for in-flight jobs to complete before exiting.
 * Prevents new jobs from being picked up during shutdown.
 * Closes browser after worker to ensure no jobs are mid-conversion.
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received, closing worker gracefully...`);

  try {
    await conversionWorker.close();
    console.log('Worker closed');

    // Close browser after worker (no more jobs can start)
    await closeBrowser();
    console.log('Browser closed');
  } catch (error) {
    console.error('Error during shutdown:', error);
  }

  process.exit(0);
}

/**
 * Start the worker and register signal handlers
 *
 * Call this from the main entry point to:
 * 1. Initialize browser before processing jobs
 * 2. Check Ollama health (fail-fast if unavailable)
 * 3. Register SIGTERM/SIGINT handlers for graceful shutdown
 * 4. Log that the worker is ready for jobs
 */
export async function startWorker(): Promise<void> {
  // Initialize browser before starting worker
  await initBrowser();

  // Check Ollama health (warn but don't block startup - jobs will fail gracefully)
  const ollamaHealth = await checkOllamaHealth();
  if (!ollamaHealth.healthy) {
    console.warn(`Ollama health check failed: ${ollamaHealth.error}`);
    console.warn('Quality verification will be unavailable until Ollama is running:');
    console.warn('  ollama serve');
    console.warn('  ollama pull gemma3');
  } else {
    console.log(`Ollama healthy, available models: ${ollamaHealth.models?.join(', ') ?? 'unknown'}`);
  }

  // Register signal handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  console.log(`Worker started for queue '${QUEUE_NAME}' with concurrency 1`);
}

/**
 * Stop the worker programmatically
 *
 * Useful for testing or programmatic control.
 * Waits for in-flight jobs to complete.
 * Closes browser after worker.
 */
export async function stopWorker(): Promise<void> {
  console.log('Stopping worker...');
  await conversionWorker.close();
  await closeBrowser();
  console.log('Worker stopped');
}
