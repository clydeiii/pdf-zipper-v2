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
import { isAllowedFixPath } from '../fix/boundary.js';
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

/**
 * Snapshot of working-tree paths, used to tell what a batch touched.
 *
 * The fix agent runs with unrestricted Edit/Write, so it can modify files
 * outside the commit boundary. Anything it leaves behind is stranded: never
 * committed, never reverted, and indistinguishable from the user's own
 * uncommitted work. Diffing this snapshot before and after the run is what
 * makes cleanup precise enough to be safe — the user keeps stray files in the
 * repo root (Karakeep drops .md files there) that must never be touched.
 */
async function snapshotWorkingTree(): Promise<Set<string>> {
  const status = await runCommand('git', ['status', '--porcelain']);
  if (!status.success) return new Set();
  return new Set(parseGitStatusPaths(status.stdout));
}

/**
 * Revert working-tree files the batch touched but that fall outside the commit
 * boundary, leaving the repo as the batch found it. Scoped to `touched` so
 * pre-existing local edits and untracked user files survive untouched.
 */
async function revertStrayBatchChanges(
  before: Set<string>,
  batchId: string
): Promise<string[]> {
  const after = await snapshotWorkingTree();
  const stray = [...after].filter((p) => !before.has(p) && !isAllowedFixPath(p));
  if (stray.length === 0) return [];

  // Tracked files go back to HEAD; files git doesn't know about are removed.
  const tracked: string[] = [];
  for (const filePath of stray) {
    const known = await runCommand('git', ['ls-files', '--error-unmatch', '--', filePath]);
    if (known.success) tracked.push(filePath);
    else await runCommand('rm', ['-f', '--', filePath]);
  }
  if (tracked.length > 0) {
    await runCommand('git', ['checkout', '--', ...tracked]);
  }

  console.warn(JSON.stringify({
    event: 'fix_stray_changes_reverted',
    batchId,
    files: stray,
    reason: 'outside_commit_boundary',
    timestamp: new Date().toISOString(),
  }));
  return stray;
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
  /**
   * What the batch concluded. The subject used to be "batch <id> via claude"
   * with an empty body for every branch, which made a 68-branch backlog
   * unreadable — you had to diff each one to learn what it did. Carrying the
   * diagnosis into the message means the next triage can skim.
   */
  summary?: string;
  rootCauses: string[];
  urls: string[];
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

  // Capture where we started so we can return HEAD here afterward. Creating the
  // fix branch must NOT strand the repo on it — the commit stays on the branch
  // for review, but the checked-out ref goes back to where it was, or a later
  // manual commit silently lands on the fix branch and `git push origin master`
  // no-ops while master stays behind.
  const origRef = await getCurrentGitRef();

  const branchName = `fix/batch-${params.batchId.slice(0, 8)}-${params.provider}`;
  const checkout = await runCommand('git', ['switch', '-c', branchName]);
  if (!checkout.success) {
    // Never left origRef — nothing to restore.
    return {
      success: false,
      changedFiles,
      error: `git_branch_failed: ${checkout.stderr || checkout.stdout}`,
    };
  }

  // We're on the fix branch now. Whatever happens below, restore origRef before
  // returning (the commit, if made, persists on branchName).
  try {
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
      // Git runs inside the container, where no ~/.gitconfig is mounted, so
      // there is no global user identity — without these -c overrides the
      // commit fails with "Author identity unknown" and the whole batch gates.
      '-c', 'user.name=pdf-zipper self-heal',
      '-c', 'user.email=self-heal@pdfzipper.local',
      'commit',
      '-m',
      `fix(self-heal): ${params.summary || `batch ${params.batchId.slice(0, 8)}`}`,
      '-m',
      [
        `Batch ${params.batchId.slice(0, 8)} via ${params.provider}.`,
        '',
        ...(params.rootCauses.length > 0
          ? ['Root causes diagnosed:', ...params.rootCauses.map((r) => `- ${r}`), '']
          : []),
        ...(params.urls.length > 0 ? ['Flagged items:', ...params.urls.map((u) => `- ${u}`)] : []),
      ].join('\n'),
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
  } finally {
    await restoreGitRef(origRef);
  }
}

/** Current checked-out ref: a branch name, or the HEAD SHA if detached. */
async function getCurrentGitRef(): Promise<{ ref: string; detached: boolean }> {
  const branch = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = branch.stdout.trim();
  if (branch.success && name && name !== 'HEAD') {
    return { ref: name, detached: false };
  }
  const sha = await runCommand('git', ['rev-parse', 'HEAD']);
  return { ref: sha.stdout.trim(), detached: true };
}

/** Return HEAD to a ref captured by getCurrentGitRef (best-effort, logged). */
async function restoreGitRef(orig: { ref: string; detached: boolean }): Promise<void> {
  const args = orig.detached ? ['switch', '--detach', orig.ref] : ['switch', orig.ref];
  const res = await runCommand('git', args);
  if (!res.success) {
    console.warn(`[Fix] could not restore git ref to ${orig.ref}: ${res.stderr || res.stdout}`);
  } else {
    console.log(`[Fix] restored git HEAD to ${orig.ref} after staging patch branch`);
  }
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
      // Verification verdict, not an organic failure — the failed handler
      // skips auto-fix-queueing for these (see maybeQueueAutoFix).
      fixVerification: true,
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
  // Snapshot first so anything the batch strands outside the boundary can be
  // told apart from work that was already dirty when we started.
  const treeBeforeBatch = await snapshotWorkingTree();
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
      alreadyAddressedBy: providerDiagnosis.alreadyAddressedBy,
      provider: providerResult.provider,
      diagnosedAt: new Date().toISOString(),
    };
  });

  // A batch that recognised its failure as already-fixed is a success: it names
  // the branch to merge instead of adding a duplicate to the backlog.
  const duplicates = diagnoses.filter((d) => d.alreadyAddressedBy);
  if (duplicates.length > 0) {
    console.log(JSON.stringify({
      event: 'fix_already_addressed',
      batchId,
      items: duplicates.map((d) => ({ url: d.context.url, branch: d.alreadyAddressedBy })),
      timestamp: new Date().toISOString(),
    }));
  }

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
      summary: providerResult.parsed.summary?.split('\n')[0]?.slice(0, 72),
      rootCauses: diagnoses
        .filter((d) => d.fixApplied)
        .map((d) => d.rootCause)
        .filter(Boolean),
      urls: diagnoses.map((d) => d.context.url),
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

  // Whatever happened above — patched, rejected, or nothing to patch — the
  // working tree must not be left dirty with this batch's leftovers. Runs on
  // every path so a rejected batch can't strand files either.
  await revertStrayBatchChanges(treeBeforeBatch, batchId);

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
