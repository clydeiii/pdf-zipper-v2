/**
 * Fix worker for AI self-healing diagnosis
 *
 * Processes pending fix requests by spawning headless Claude Code sessions.
 * Claude Code analyzes PDFs, diagnoses issues, and can autonomously apply fixes.
 */

import { Worker, Job } from 'bullmq';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { workerConnection } from '../config/redis.js';
import { env } from '../config/env.js';
import { FIX_QUEUE_NAME } from '../queues/fix.queue.js';
import { consumePendingFixes, saveFixHistory } from '../fix/pending.js';
import { buildDiagnosisPrompt } from '../fix/prompt-builder.js';
import { sendFixDiagnosisNotification } from '../notifications/discord.js';
import { conversionQueue } from '../queues/conversion.queue.js';
import type {
  FixJobData,
  FixJobContext,
  FixDiagnosis,
  FixHistoryEntry,
} from '../jobs/fix-types.js';

/** Flag to prevent multiple shutdown attempts */
let isShuttingDown = false;

/** Reference to the worker instance */
let fixWorkerInstance: Worker<FixJobData, FixHistoryEntry> | null = null;

/**
 * Parse Claude Code JSON output from the response
 *
 * Claude Code outputs JSON wrapped in markdown code blocks.
 * This extracts and parses that JSON.
 */
function parseClaudeOutput(output: string): {
  diagnoses: Array<{
    url: string;
    requestType: string;
    rootCause: string;
    suggestedFix?: string;
    filesModified: string[];
    fixApplied: boolean;
  }>;
  summary: string;
} | null {
  try {
    // Try to find JSON in the output
    // First try: look for ```json block
    const jsonBlockMatch = output.match(/```json\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return JSON.parse(jsonBlockMatch[1].trim());
    }

    // Second try: look for raw JSON object
    const jsonMatch = output.match(/\{[\s\S]*"diagnoses"[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    // Third try: parse entire output as JSON
    return JSON.parse(output);
  } catch (error) {
    console.error('Failed to parse Claude output:', error);
    console.error('Raw output:', output.substring(0, 500));
    return null;
  }
}

/**
 * Spawn Claude Code in headless mode and get diagnosis
 */
async function runClaudeDiagnosis(
  items: FixJobContext[]
): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const prompt = buildDiagnosisPrompt(items);

  return new Promise((resolve) => {
    const claudePath = env.CLAUDE_CLI_PATH;

    // Spawn Claude Code in headless mode
    const child = spawn(claudePath, [
      '--print',                          // Non-interactive, print output
      '--output-format', 'text',          // Plain text output
      '--allowedTools', 'Read,Grep,Glob,Bash,Edit,Write',  // Allowed tools
      '--dangerously-skip-permissions',   // Pre-approved for autonomy
      '-p', prompt,                        // The prompt
    ], {
      cwd: '/home/clyde/pdf-zipper-v2',
      env: {
        ...process.env,
        // Prevent Claude from prompting for input
        CLAUDE_CODE_HEADLESS: 'true',
      },
      timeout: 30 * 60 * 1000,  // 30 minute timeout (PDF analysis can be slow)
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          success: true,
          output: stdout,
        });
      } else {
        resolve({
          success: false,
          output: stdout,
          error: `Claude Code exited with code ${code}: ${stderr}`,
        });
      }
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        output: stdout,
        error: `Failed to spawn Claude Code: ${error.message}`,
      });
    });
  });
}

/**
 * Submit URL for re-conversion to verify fix
 */
async function submitForVerification(
  url: string
): Promise<{ jobId: string } | { error: string }> {
  try {
    const job = await conversionQueue.add('convert-url', {
      url,
      originalUrl: url,
    });

    return { jobId: job.id! };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Process a fix job
 *
 * 1. Consume all pending fix requests from Redis
 * 2. Spawn Claude Code with diagnosis prompt
 * 3. Parse output and create diagnoses
 * 4. Re-run affected URLs for verification
 * 5. Save history and send notifications
 */
async function processFixJob(
  job: Job<FixJobData, FixHistoryEntry>
): Promise<FixHistoryEntry> {
  const startedAt = new Date().toISOString();
  const batchId = randomUUID();

  console.log(`[Fix] Processing fix job ${job.id} (batch ${batchId})`);

  // Get pending items
  const items = await consumePendingFixes();

  if (items.length === 0) {
    console.log('[Fix] No pending items to process');
    return {
      batchId,
      itemCount: 0,
      diagnoses: [],
      totalFilesModified: 0,
      successfulVerifications: 0,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  console.log(`[Fix] Processing ${items.length} pending items`);

  // Run Claude Code diagnosis
  const result = await runClaudeDiagnosis(items);

  if (!result.success) {
    console.error('[Fix] Claude Code diagnosis failed:', result.error);

    // Create failed diagnoses for all items
    const diagnoses: FixDiagnosis[] = items.map((item) => ({
      context: item,
      rootCause: `Diagnosis failed: ${result.error}`,
      filesModified: [],
      fixApplied: false,
      diagnosedAt: new Date().toISOString(),
    }));

    const historyEntry: FixHistoryEntry = {
      batchId,
      itemCount: items.length,
      diagnoses,
      totalFilesModified: 0,
      successfulVerifications: 0,
      startedAt,
      completedAt: new Date().toISOString(),
    };

    await saveFixHistory(historyEntry);
    await sendFixDiagnosisNotification(historyEntry);

    return historyEntry;
  }

  // Parse Claude's output
  const parsed = parseClaudeOutput(result.output);

  if (!parsed) {
    console.error('[Fix] Failed to parse Claude output');

    const diagnoses: FixDiagnosis[] = items.map((item) => ({
      context: item,
      rootCause: 'Failed to parse diagnosis output',
      filesModified: [],
      fixApplied: false,
      diagnosedAt: new Date().toISOString(),
    }));

    const historyEntry: FixHistoryEntry = {
      batchId,
      itemCount: items.length,
      diagnoses,
      totalFilesModified: 0,
      successfulVerifications: 0,
      startedAt,
      completedAt: new Date().toISOString(),
    };

    await saveFixHistory(historyEntry);
    await sendFixDiagnosisNotification(historyEntry);

    return historyEntry;
  }

  // Map parsed diagnoses back to original items
  const diagnoses: FixDiagnosis[] = [];
  let totalFilesModified = 0;
  let successfulVerifications = 0;

  for (const item of items) {
    // Find matching diagnosis from Claude's output
    const claudeDiagnosis = parsed.diagnoses.find(
      (d) => d.url === item.url
    );

    if (claudeDiagnosis) {
      const diagnosis: FixDiagnosis = {
        context: item,
        rootCause: claudeDiagnosis.rootCause,
        suggestedFix: claudeDiagnosis.suggestedFix,
        filesModified: claudeDiagnosis.filesModified || [],
        fixApplied: claudeDiagnosis.fixApplied || false,
        diagnosedAt: new Date().toISOString(),
      };

      totalFilesModified += diagnosis.filesModified.length;

      // If a fix was applied, submit URL for verification
      if (diagnosis.fixApplied) {
        const verifyResult = await submitForVerification(item.url);

        if ('jobId' in verifyResult) {
          diagnosis.verification = {
            success: true,
            newJobId: verifyResult.jobId,
          };
          successfulVerifications++;
        } else {
          diagnosis.verification = {
            success: false,
            error: verifyResult.error,
          };
        }
      }

      diagnoses.push(diagnosis);
    } else {
      // No diagnosis found for this item
      diagnoses.push({
        context: item,
        rootCause: 'No diagnosis provided by Claude',
        filesModified: [],
        fixApplied: false,
        diagnosedAt: new Date().toISOString(),
      });
    }
  }

  // Create history entry
  const historyEntry: FixHistoryEntry = {
    batchId,
    itemCount: items.length,
    diagnoses,
    totalFilesModified,
    successfulVerifications,
    startedAt,
    completedAt: new Date().toISOString(),
  };

  // Save to history
  await saveFixHistory(historyEntry);

  // Send Discord notification
  await sendFixDiagnosisNotification(historyEntry);

  console.log(`[Fix] Completed batch ${batchId}: ${items.length} items, ${totalFilesModified} files modified`);

  return historyEntry;
}

/**
 * Create the fix worker
 */
function createFixWorker(): Worker<FixJobData, FixHistoryEntry> {
  const worker = new Worker<FixJobData, FixHistoryEntry>(
    FIX_QUEUE_NAME,
    processFixJob,
    {
      connection: workerConnection,
      concurrency: 1,  // Only one diagnosis at a time
    }
  );

  worker.on('completed', (job) => {
    console.log(`[Fix] Job ${job.id} completed`);
  });

  worker.on('failed', (job, error) => {
    console.error(`[Fix] Job ${job?.id} failed:`, error.message);
  });

  worker.on('error', (error) => {
    console.error('[Fix] Worker error:', error.message);
  });

  return worker;
}

/**
 * Start the fix worker
 *
 * Only starts if FIX_ENABLED is true.
 */
export async function startFixWorker(): Promise<void> {
  if (!env.FIX_ENABLED) {
    console.log('[Fix] Fix worker disabled (FIX_ENABLED=false)');
    return;
  }

  // Check if Claude CLI is available
  try {
    const { execSync } = await import('node:child_process');
    execSync(`${env.CLAUDE_CLI_PATH} --version`, { stdio: 'pipe' });
  } catch {
    console.error(`[Fix] Claude CLI not found at ${env.CLAUDE_CLI_PATH}`);
    console.error('[Fix] Fix worker will not start');
    return;
  }

  fixWorkerInstance = createFixWorker();
  console.log(`[Fix] Fix worker started for queue '${FIX_QUEUE_NAME}'`);
}

/**
 * Stop the fix worker gracefully
 */
export async function stopFixWorker(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  if (fixWorkerInstance) {
    console.log('[Fix] Stopping fix worker...');
    await fixWorkerInstance.close();
    console.log('[Fix] Fix worker stopped');
  }
}
