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
import { savePdfToWeeklyBin } from '../utils/save-pdf.js';
import { workerConnection } from '../config/redis.js';
import { QUEUE_NAME } from '../queues/conversion.queue.js';
import { env } from '../config/env.js';
import type { ConversionJobData, ConversionJobResult } from '../jobs/types.js';
import { initBrowser, closeBrowser } from '../browsers/manager.js';
import { convertUrlToPDF, isPdfUrl, downloadPdfDirect, rewriteToPdfUrl } from '../converters/pdf.js';
import { checkOllamaHealth } from '../quality/ollama.js';
import { scoreScreenshotQuality } from '../quality/scorer.js';
import { analyzePdfContent } from '../quality/pdf-content.js';
import { getISOWeekNumber } from '../media/organization.js';
import { notifyJobComplete, notifyJobFailed, isDiscordEnabled } from '../notifications/discord.js';
import { addPendingFixes } from '../fix/pending.js';
import { classifyFailureMessage } from '../fix/failure.js';
import { shouldAutoTriggerFix } from '../fix/trigger-policy.js';
import { updateFixOutcome } from '../fix/ledger.js';
import { addJobToWeekIndex } from '../jobs/week-index.js';
import { enrichDocumentMetadata, type EnrichedMetadata } from '../metadata/enrichment.js';

/** Reference to the worker instance. Created explicitly by startWorker(). */
let conversionWorker: Worker<ConversionJobData, ConversionJobResult> | null = null;

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
    // Rewrite abstract/landing URLs to direct PDF (e.g., arxiv.org/abs/ → arxiv.org/pdf/)
    const pdfUrl = rewriteToPdfUrl(url);
    console.log(`PDF URL detected, using pass-through: ${pdfUrl}`);
    const passthroughResult = await downloadPdfDirect(pdfUrl);

    await job.updateProgress(50);

    if (!passthroughResult.success) {
      console.log(`PDF pass-through failed for ${pdfUrl}: ${passthroughResult.reason} - ${passthroughResult.error}`);
      throw new Error(`${passthroughResult.reason}: ${passthroughResult.error}`);
    }

    // Use suggested filename from Content-Disposition, or job title, or extract from URL
    const title = jobTitle || passthroughResult.suggestedFilename?.replace(/\.pdf$/i, '');

    // Extract text and enrich metadata (Karpathify the PDF)
    let enrichedMetadata: EnrichedMetadata | undefined;
    try {
      const contentResult = await analyzePdfContent(passthroughResult.pdfBuffer);
      if (contentResult.extractedText && contentResult.extractedText.length > 100) {
        enrichedMetadata = await enrichDocumentMetadata(contentResult.extractedText, url, title);
        console.log(`Pass-through PDF enriched: "${enrichedMetadata.title}" [${enrichedMetadata.language}]`);
      }
    } catch (error) {
      console.warn(`Pass-through PDF enrichment failed (non-fatal):`, error instanceof Error ? error.message : error);
    }

    await job.updateProgress(80);

    // Save to weekly bin with enriched metadata
    const filePath = await savePdfToWeeklyBin(passthroughResult.pdfBuffer, {
      url,
      title,
      bookmarkedAt,
      originalUrl,
      enrichedMetadata,
    });

    await job.updateProgress(100);

    console.log(`PDF pass-through completed: ${filePath}`);

    if (oldFilePath) await deleteOldFileIfDifferent(oldFilePath, filePath);

    return {
      pdfPath: filePath,
      pdfSize: passthroughResult.size,
      completedAt: new Date().toISOString(),
      url,
      summary: enrichedMetadata?.summary || undefined,
      language: enrichedMetadata?.language || undefined,
    };
  }

  // Convert URL to PDF (regular flow)
  const result = await convertUrlToPDF(url);

  // Use job title if provided, otherwise use extracted page title
  const title = jobTitle || (result.success ? result.pageTitle : undefined);
  // Track if this was an X Article capture (for filename generation)
  const isXArticle = result.success ? result.isXArticle : undefined;
  // Use expanded URL for filename generation (so t.co links get real domain names)
  const filenameUrl = (result.success ? result.expandedUrl : undefined) || url;

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

  // Check PDF content for truncation (catches paywalls that screenshot check misses).
  // Lenient mode for Nitter tweet captures (isXArticle === false): a tweet
  // with no replies legitimately has very little body text, so we only fail
  // when the PDF is truly blank. X Articles (isXArticle === true) are full
  // essays and get the strict checks like other articles.
  const lenient = isXArticle === false;
  const contentResult = await analyzePdfContent(result.pdfBuffer, { lenient });
  console.log(`PDF content analysis for ${url}: ${contentResult.charCount} chars, ${contentResult.pageCount} pages, ${contentResult.charsPerKb} chars/KB${lenient ? ' [lenient: tweet]' : ''}`);

  if (!contentResult.passed) {
    // Save debug PDF before failing
    await saveDebugPdf(job.id!, result.pdfBuffer);
    throw new Error(`truncated: ${contentResult.reason}`);
  }

  // Enrich metadata using AI (after quality checks pass to avoid wasting time on bad PDFs)
  let enrichedMetadata: EnrichedMetadata | undefined;
  if (contentResult.extractedText && contentResult.extractedText.length > 100) {
    try {
      enrichedMetadata = await enrichDocumentMetadata(contentResult.extractedText, url, title);
      console.log(`Metadata enriched for ${url}: "${enrichedMetadata.title}" by ${enrichedMetadata.author || 'unknown'} [${enrichedMetadata.language}]`);
    } catch (error) {
      console.warn(`Metadata enrichment failed for ${url}:`, error instanceof Error ? error.message : error);
      // Non-fatal: continue without enrichment
    }
  }

  await job.updateProgress(90);

  // Only save PDF after quality check passes
  const pdfPath = await savePdfToWeeklyBin(result.pdfBuffer, {
    url: filenameUrl,
    title,
    bookmarkedAt,
    originalUrl,
    isXArticle,
    enrichedMetadata,
  });
  console.log(`PDF saved to: ${pdfPath}`);

  if (oldFilePath) await deleteOldFileIfDifferent(oldFilePath, pdfPath);

  // Final progress
  await job.updateProgress(100);

  // Return success result with quality data and enrichment
  return {
    pdfPath,
    pdfSize: result.size,
    completedAt: new Date().toISOString(),
    url,
    qualityScore: qualityResult.score.score,
    qualityReasoning: qualityResult.score.reasoning,
    summary: enrichedMetadata?.summary || undefined,
    language: enrichedMetadata?.language || undefined,
  };
}

/**
 * Auto-submit retryable final failures to the fix diagnosis queue.
 */
async function maybeQueueAutoFix(
  job: Job<ConversionJobData, ConversionJobResult>,
  error: Error
): Promise<void> {
  if (!env.FIX_ENABLED) return;

  const failureClass = classifyFailureMessage(error.message);
  const decision = shouldAutoTriggerFix(failureClass);

  if (!decision.allowed) {
    await updateFixOutcome({
      url: job.data.originalUrl || job.data.url,
      outcome: 'skipped',
      failureClass,
      details: {
        reason: decision.reason,
        source: 'conversion_final_failure',
      },
    });
    return;
  }

  const week = getISOWeekNumber(new Date(job.timestamp));
  const weekId = `${week.year}-W${week.week.toString().padStart(2, '0')}`;
  const queued = await addPendingFixes([
    {
      originalJobId: job.id!,
      url: job.data.originalUrl || job.data.url,
      requestType: 'false_negative',
      status: 'failed',
      debugPdfPath: path.join(env.DATA_DIR, 'debug', `${job.id}.pdf`),
      failureReason: error.message,
      weekId,
      requestedAt: new Date().toISOString(),
      requestedBy: 'automatic',
      failureClass,
      triggerReason: decision.reason,
    },
  ]);

  if (queued > 0) {
    console.log(`[Fix] Auto-queued failure for diagnosis: ${job.data.url} (${failureClass})`);
  }
}

function createConversionWorker(): Worker<ConversionJobData, ConversionJobResult> {
  const worker = new Worker<ConversionJobData, ConversionJobResult>(
    QUEUE_NAME,
    processJob,
    {
      connection: workerConnection,
      concurrency: env.CONCURRENCY,
    }
  );

  worker.on('active', (job) => {
    console.log(`[DEBUG] Worker activated job: ${job.id}`);
  });

  worker.on('completed', async (job: Job<ConversionJobData, ConversionJobResult>) => {
    console.log(`Job ${job.id} completed successfully`);

    const jobWeek = getISOWeekNumber(new Date(job.timestamp));
    const weekId = `${jobWeek.year}-W${jobWeek.week.toString().padStart(2, '0')}`;
    await addJobToWeekIndex({
      weekId,
      kind: 'completed',
      jobId: job.id!,
      scoreTimestampMs: job.finishedOn || Date.now(),
    });

    const result = job.returnvalue;
    if (result) {
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

  worker.on('failed', async (job: Job<ConversionJobData, ConversionJobResult> | undefined, error: Error) => {
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

    if (job && job.attemptsMade >= (job.opts?.attempts ?? 3)) {
      const jobWeek = getISOWeekNumber(new Date(job.timestamp));
      const weekId = `${jobWeek.year}-W${jobWeek.week.toString().padStart(2, '0')}`;
      await addJobToWeekIndex({
        weekId,
        kind: 'failed',
        jobId: job.id!,
        scoreTimestampMs: job.finishedOn || Date.now(),
      });

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

      try {
        await maybeQueueAutoFix(job, error);
      } catch (autoFixError) {
        console.error('[Fix] Failed to auto-queue diagnosis:', autoFixError);
      }
    }
  });

  worker.on('error', (error: Error) => {
    console.error(`Worker error: ${error.message}`);
  });

  return worker;
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
  if (conversionWorker) {
    console.log(`Worker already started for queue '${QUEUE_NAME}'`);
    return;
  }

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

  conversionWorker = createConversionWorker();
  console.log(`Worker started for queue '${QUEUE_NAME}' with concurrency ${env.CONCURRENCY}`);
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
  if (conversionWorker) {
    await conversionWorker.close();
    conversionWorker = null;
  }
  await closeBrowser();
  console.log('Worker stopped');
}
