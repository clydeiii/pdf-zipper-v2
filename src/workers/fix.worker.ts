/**
 * Fix worker for AI self-healing diagnosis/patching.
 *
 * Flow:
 * 1. Consume pending fix requests
 * 2. Run provider (round-robin Claude/Codex)
 * 3. Prepare patch branch/commit (if fix applied)
 * 4. Verification gate: build + targeted replay jobs
 * 5. Persist batch history + ledger outcomes
 */

import { Worker, Job, QueueEvents } from 'bullmq';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { workerConnection, createConnection } from '../config/redis.js';
import { env } from '../config/env.js';
import { FIX_QUEUE_NAME } from '../queues/fix.queue.js';
import { QUEUE_NAME, conversionQueue } from '../queues/conversion.queue.js';
import { consumePendingFixes, saveFixHistory } from '../fix/pending.js';
import { runDiagnosisWithProviders } from '../fix/providers.js';
import { classifyFailureMessage } from '../fix/failure.js';
import { updateFixOutcome } from '../fix/ledger.js';
import { sendFixDiagnosisNotification } from '../notifications/discord.js';
import type {
  FixJobData,
  FixJobContext,
  FixDiagnosis,
  FixGateStatus,
  FixHistoryEntry,
} from '../jobs/fix-types.js';

/** Flag to prevent multiple shutdown attempts */
let isShuttingDown = false;

/** Reference to the worker instance */
let fixWorkerInstance: Worker<FixJobData, FixHistoryEntry> | null = null;

/** Shared queue-events for conversion replay verification. Created lazily on startup. */
let conversionQueueEvents: QueueEvents | null = null;

function getConversionQueueEvents(): QueueEvents {
  if (!conversionQueueEvents) {
    conversionQueueEvents = new QueueEvents(QUEUE_NAME, {
      connection: createConnection({ maxRetriesPerRequest: null }),
    });
  }
  return conversionQueueEvents;
}

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    timeoutMs?: number;
  }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd || '/home/clyde/pdf-zipper-v2',
      env: process.env,
      timeout: options?.timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      const normalizedCode = code ?? 1;
      resolve({
        success: normalizedCode === 0,
        stdout,
        stderr,
        code: normalizedCode,
      });
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        code: 1,
      });
    });
  });
}

function parseGitStatusPaths(stdout: string): string[] {
  const files: string[] = [];
  const lines = stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);

  for (const line of lines) {
    // Porcelain format: XY <path> or XY <old> -> <new>
    const rawPath = line.substring(3).trim();
    if (!rawPath) continue;

    const renameParts = rawPath.split(' -> ');
    const pathValue = renameParts[renameParts.length - 1].trim();
    if (pathValue.length > 0) files.push(pathValue);
  }

  return files;
}

function isAllowedFixPath(filePath: string): boolean {
  return (
    filePath.startsWith('src/quality/') ||
    filePath.startsWith('src/converters/') ||
    filePath.startsWith('src/fix/')
  );
}

async function buildGate(): Promise<{ passed: boolean; error?: string }> {
  const result = await runCommand('npm', ['run', 'build', '--silent'], {
    timeoutMs: 10 * 60 * 1000,
  });

  if (result.success) {
    return { passed: true };
  }

  const tail = (result.stderr || result.stdout).slice(-1200);
  return {
    passed: false,
    error: `build_failed: ${tail}`.trim(),
  };
}

async function preparePatchBranch(params: {
  batchId: string;
  provider: string;
}): Promise<{
  success: boolean;
  branchName?: string;
  commitSha?: string;
  applyCommand?: string;
  changedFiles: string[];
  error?: string;
}> {
  const status = await runCommand('git', ['status', '--porcelain']);
  if (!status.success) {
    return {
      success: false,
      changedFiles: [],
      error: `git_status_failed: ${status.stderr || status.stdout}`,
    };
  }

  const changedFiles = parseGitStatusPaths(status.stdout).filter(isAllowedFixPath);
  if (changedFiles.length === 0) {
    return {
      success: false,
      changedFiles: [],
      error: 'no_allowed_changes_detected',
    };
  }

  const branchName = `fix/batch-${params.batchId.slice(0, 8)}-${params.provider}`;
  const checkout = await runCommand('git', ['switch', '-c', branchName]);
  if (!checkout.success) {
    return {
      success: false,
      changedFiles,
      error: `git_branch_failed: ${checkout.stderr || checkout.stdout}`,
    };
  }

  const add = await runCommand('git', ['add', '--', ...changedFiles]);
  if (!add.success) {
    return {
      success: false,
      changedFiles,
      error: `git_add_failed: ${add.stderr || add.stdout}`,
    };
  }

  const hasStaged = await runCommand('git', ['diff', '--cached', '--quiet']);
  if (hasStaged.success) {
    // diff --quiet exits 0 when there is no staged diff.
    return {
      success: false,
      changedFiles,
      error: 'no_staged_diff_after_add',
    };
  }

  const commit = await runCommand('git', [
    'commit',
    '-m',
    `fix(self-heal): batch ${params.batchId.slice(0, 8)} via ${params.provider}`,
  ]);
  if (!commit.success) {
    return {
      success: false,
      changedFiles,
      error: `git_commit_failed: ${commit.stderr || commit.stdout}`,
    };
  }

  const sha = await runCommand('git', ['rev-parse', 'HEAD']);
  if (!sha.success) {
    return {
      success: false,
      changedFiles,
      error: `git_rev_parse_failed: ${sha.stderr || sha.stdout}`,
    };
  }

  return {
    success: true,
    branchName,
    commitSha: sha.stdout.trim(),
    applyCommand: `git switch ${branchName}`,
    changedFiles,
  };
}

async function getAllowedWorkingTreeChanges(): Promise<string[]> {
  const status = await runCommand('git', ['status', '--porcelain']);
  if (!status.success) return [];
  return parseGitStatusPaths(status.stdout).filter(isAllowedFixPath);
}

async function runReplayGate(urls: string[]): Promise<{
  passed: boolean;
  successful: number;
  jobIds: string[];
  errors: string[];
}> {
  const uniqueUrls = Array.from(new Set(urls)).filter((url) => url.startsWith('http://') || url.startsWith('https://'));
  if (uniqueUrls.length === 0) {
    return {
      passed: true,
      successful: 0,
      jobIds: [],
      errors: [],
    };
  }

  const jobs = [];
  for (const url of uniqueUrls) {
    const job = await conversionQueue.add('convert-url', {
      url,
      originalUrl: url,
    });
    jobs.push(job);
  }

  const jobIds = jobs.map((job) => job.id!).filter(Boolean);
  const errors: string[] = [];
  let successful = 0;

  for (const job of jobs) {
    try {
      await job.waitUntilFinished(getConversionQueueEvents(), 12 * 60 * 1000);
      successful++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`job_${job.id}: ${message}`);
    }
  }

  return {
    passed: errors.length === 0,
    successful,
    jobIds,
    errors,
  };
}

function createFallbackDiagnoses(items: FixJobContext[], reason: string): FixDiagnosis[] {
  return items.map((item) => ({
    context: item,
    rootCause: reason,
    filesModified: [],
    fixApplied: false,
    provider: item.forceProvider || 'claude',
    diagnosedAt: new Date().toISOString(),
  }));
}

async function updateLedgerForBatch(entry: FixHistoryEntry): Promise<void> {
  for (const diagnosis of entry.diagnoses) {
    const failureClass = diagnosis.context.failureClass || classifyFailureMessage(diagnosis.context.failureReason);

    let outcome: 'diagnosed' | 'ready' | 'rejected' | 'failed' = 'diagnosed';
    if (entry.gateStatus === 'ready' || entry.gateStatus === 'applied') outcome = 'ready';
    else if (entry.gateStatus === 'rejected') outcome = 'rejected';
    else if (entry.gateStatus === 'failed') outcome = 'failed';

    await updateFixOutcome({
      url: diagnosis.context.url,
      outcome,
      provider: diagnosis.provider,
      batchId: entry.batchId,
      failureClass,
      details: {
        gateStatus: entry.gateStatus,
        gateReason: entry.gateReason,
      },
    });
  }
}

/**
 * Process a fix job.
 */
async function processFixJob(
  job: Job<FixJobData, FixHistoryEntry>
): Promise<FixHistoryEntry> {
  const startedAt = new Date().toISOString();
  const batchId = randomUUID();

  console.log(`[Fix] Processing fix job ${job.id} (batch ${batchId})`);

  const items = await consumePendingFixes();
  if (items.length === 0) {
    const emptyEntry: FixHistoryEntry = {
      batchId,
      itemCount: 0,
      diagnoses: [],
      summary: 'No pending items',
      totalFilesModified: 0,
      successfulVerifications: 0,
      gateStatus: 'diagnosed',
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await saveFixHistory(emptyEntry);
    return emptyEntry;
  }

  const forcedProvider = items.find((item) => !!item.forceProvider)?.forceProvider;
  const providerResult = await runDiagnosisWithProviders(items, forcedProvider);

  if (!('parsed' in providerResult)) {
    const failedEntry: FixHistoryEntry = {
      batchId,
      itemCount: items.length,
      diagnoses: createFallbackDiagnoses(
        items,
        `Provider diagnosis failed: ${providerResult.error}`
      ),
      summary: providerResult.error,
      totalFilesModified: 0,
      successfulVerifications: 0,
      gateStatus: 'failed',
      gateReason: providerResult.error,
      startedAt,
      completedAt: new Date().toISOString(),
    };

    await saveFixHistory(failedEntry);
    await updateLedgerForBatch(failedEntry);
    await sendFixDiagnosisNotification(failedEntry);
    return failedEntry;
  }

  const diagnosisByUrl = new Map(
    providerResult.parsed.diagnoses.map((d) => [d.url, d] as const)
  );

  const diagnoses: FixDiagnosis[] = items.map((item) => {
    const providerDiagnosis = diagnosisByUrl.get(item.url);
    if (!providerDiagnosis) {
      return {
        context: item,
        rootCause: 'No diagnosis provided for URL',
        filesModified: [],
        fixApplied: false,
        provider: providerResult.provider,
        diagnosedAt: new Date().toISOString(),
      };
    }

    return {
      context: item,
      rootCause: providerDiagnosis.rootCause,
      suggestedFix: providerDiagnosis.suggestedFix,
      filesModified: providerDiagnosis.filesModified,
      fixApplied: providerDiagnosis.fixApplied,
      provider: providerResult.provider,
      diagnosedAt: new Date().toISOString(),
    };
  });

  const fixAppliedDiagnoses = diagnoses.filter((d) => d.fixApplied);
  const allowedWorkingChanges = await getAllowedWorkingTreeChanges();
  const totalFilesModified = diagnoses.reduce((acc, d) => acc + d.filesModified.length, 0);

  let gateStatus: FixGateStatus = 'diagnosed';
  let gateReason: string | undefined;
  let branchName: string | undefined;
  let commitSha: string | undefined;
  let applyCommand: string | undefined;
  let verificationJobs: string[] = [];
  let successfulVerifications = 0;

  const shouldPreparePatch = fixAppliedDiagnoses.length > 0 || allowedWorkingChanges.length > 0;

  if (shouldPreparePatch) {
    gateStatus = 'patched';

    const branchResult = await preparePatchBranch({
      batchId,
      provider: providerResult.provider,
    });

    if (!branchResult.success) {
      gateStatus = 'rejected';
      gateReason = branchResult.error || 'patch_branch_prep_failed';
    } else {
      branchName = branchResult.branchName;
      commitSha = branchResult.commitSha;
      applyCommand = branchResult.applyCommand;
      gateStatus = 'verifying';

      const buildResult = await buildGate();
      if (!buildResult.passed) {
        gateStatus = 'rejected';
        gateReason = buildResult.error || 'build_failed';

        for (const diagnosis of fixAppliedDiagnoses) {
          diagnosis.verification = {
            success: false,
            buildPassed: false,
            replayPassed: false,
            error: gateReason,
          };
        }
      } else {
        const replayTargetUrls = fixAppliedDiagnoses.length > 0
          ? fixAppliedDiagnoses.map((d) => d.context.url)
          : diagnoses.map((d) => d.context.url);
        const replayResult = await runReplayGate(replayTargetUrls);
        verificationJobs = replayResult.jobIds;
        successfulVerifications = replayResult.successful;

        for (const diagnosis of fixAppliedDiagnoses) {
          diagnosis.verification = {
            success: replayResult.passed,
            buildPassed: true,
            replayPassed: replayResult.passed,
            newJobIds: replayResult.jobIds,
            error: replayResult.passed ? undefined : replayResult.errors.join('; '),
          };
        }

        if (replayResult.passed) {
          gateStatus = 'ready';
        } else {
          gateStatus = 'rejected';
          gateReason = replayResult.errors.join('; ');
        }
      }
    }
  }

  const historyEntry: FixHistoryEntry = {
    batchId,
    itemCount: items.length,
    diagnoses,
    summary: providerResult.parsed.summary,
    provider: providerResult.provider,
    providerFallbackUsed: providerResult.fallbackUsed,
    totalFilesModified,
    successfulVerifications,
    gateStatus,
    gateReason,
    branchName,
    commitSha,
    applyCommand,
    verificationJobs,
    startedAt,
    completedAt: new Date().toISOString(),
  };

  await saveFixHistory(historyEntry);
  await updateLedgerForBatch(historyEntry);
  await sendFixDiagnosisNotification(historyEntry);

  console.log(
    `[Fix] Completed batch ${batchId}: ${items.length} items, ${totalFilesModified} files modified, gate=${gateStatus}`
  );

  return historyEntry;
}

function createFixWorker(): Worker<FixJobData, FixHistoryEntry> {
  const worker = new Worker<FixJobData, FixHistoryEntry>(
    FIX_QUEUE_NAME,
    processFixJob,
    {
      connection: workerConnection,
      concurrency: 1,
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

export async function startFixWorker(): Promise<void> {
  if (!env.FIX_ENABLED) {
    console.log('[Fix] Fix worker disabled (FIX_ENABLED=false)');
    return;
  }

  await getConversionQueueEvents().waitUntilReady();
  fixWorkerInstance = createFixWorker();
  console.log(`[Fix] Fix worker started for queue '${FIX_QUEUE_NAME}'`);
}

export async function stopFixWorker(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  if (fixWorkerInstance) {
    console.log('[Fix] Stopping fix worker...');
    await fixWorkerInstance.close();
    console.log('[Fix] Fix worker stopped');
  }

  try {
    await conversionQueueEvents?.close();
    conversionQueueEvents = null;
  } catch {
    // Ignore close errors.
  }
}
