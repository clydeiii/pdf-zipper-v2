/**
 * Fix provider orchestration (Claude/Codex) with round-robin selection.
 */

import { spawn } from 'node:child_process';
import { env } from '../config/env.js';
import { queueConnection } from '../config/redis.js';
import { buildDiagnosisPrompt } from './prompt-builder.js';
import { loadExclusionSignals } from './signals.js';
import type { FixJobContext, FixProvider, FixRequestType } from '../jobs/fix-types.js';

const ROUND_ROBIN_KEY = 'fix:provider:round-robin-next';
const ALLOWED_TOOLS = 'Read,Grep,Glob,Bash,Edit,Write';

interface RawCommandResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ProviderDiagnosisItem {
  url: string;
  requestType: FixRequestType;
  rootCause: string;
  suggestedFix?: string;
  filesModified: string[];
  fixApplied: boolean;
}

export interface ProviderDiagnosisOutput {
  diagnoses: ProviderDiagnosisItem[];
  summary: string;
}

export interface ProviderRunResult {
  provider: FixProvider;
  parsed: ProviderDiagnosisOutput;
  rawOutput: string;
  fallbackUsed: boolean;
}

function parseArgs(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function runCommand(
  command: string,
  args: string[],
  options?: {
    timeoutMs?: number;
    extraEnv?: Record<string, string>;
  }
): Promise<RawCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: '/home/clyde/pdf-zipper-v2',
      env: {
        ...process.env,
        ...(options?.extraEnv || {}),
      },
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
      if (code === 0) {
        resolve({ success: true, output: stdout });
        return;
      }
      resolve({
        success: false,
        output: stdout,
        error: `${command} exited with code ${code}: ${stderr}`.trim(),
      });
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        output: stdout,
        error: `Failed to spawn ${command}: ${error.message}`,
      });
    });
  });
}

function extractJsonText(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const objectMatch = raw.match(/\{[\s\S]*"diagnoses"[\s\S]*\}/);
  if (objectMatch?.[0]) return objectMatch[0].trim();

  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  return null;
}

function isRequestType(value: unknown): value is FixRequestType {
  return value === 'false_positive' || value === 'false_negative';
}

function parseProviderOutput(raw: string): ProviderDiagnosisOutput | null {
  const jsonText = extractJsonText(raw);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const diagnosesRaw = (parsed as { diagnoses?: unknown }).diagnoses;
    const summaryRaw = (parsed as { summary?: unknown }).summary;
    if (!Array.isArray(diagnosesRaw)) return null;

    const diagnoses: ProviderDiagnosisItem[] = [];
    for (const item of diagnosesRaw) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.url !== 'string') continue;
      if (!isRequestType(rec.requestType)) continue;
      if (typeof rec.rootCause !== 'string') continue;

      diagnoses.push({
        url: rec.url,
        requestType: rec.requestType,
        rootCause: rec.rootCause,
        suggestedFix: typeof rec.suggestedFix === 'string' ? rec.suggestedFix : undefined,
        filesModified: Array.isArray(rec.filesModified)
          ? rec.filesModified.filter((v): v is string => typeof v === 'string')
          : [],
        fixApplied: rec.fixApplied === true,
      });
    }

    return {
      diagnoses,
      summary: typeof summaryRaw === 'string' ? summaryRaw : '',
    };
  } catch {
    return null;
  }
}

function buildProviderCommand(provider: FixProvider, prompt: string): { cmd: string; args: string[] } {
  if (provider === 'claude') {
    return {
      cmd: env.CLAUDE_CLI_PATH,
      args: [
        '--print',
        '--output-format', 'text',
        '--allowedTools', ALLOWED_TOOLS,
        '-p', prompt,
      ],
    };
  }

  const configuredArgs = parseArgs(env.CODEX_CLI_ARGS);
  if (configuredArgs.length === 0) {
    return {
      cmd: env.CODEX_CLI_PATH,
      args: ['-p', prompt],
    };
  }

  const hasPlaceholder = configuredArgs.some((arg) => arg.includes('{prompt}'));
  if (hasPlaceholder) {
    return {
      cmd: env.CODEX_CLI_PATH,
      args: configuredArgs.map((arg) => arg.replace(/\{prompt\}/g, prompt)),
    };
  }

  return {
    cmd: env.CODEX_CLI_PATH,
    args: [...configuredArgs, prompt],
  };
}

async function runProvider(provider: FixProvider, items: FixJobContext[]): Promise<{ parsed?: ProviderDiagnosisOutput; raw: string; error?: string }> {
  const exclusionSignals = await loadExclusionSignals();
  const prompt = buildDiagnosisPrompt(items, exclusionSignals);
  const timeoutMs = Math.max(1, env.FIX_PROVIDER_TIMEOUT_MINUTES) * 60 * 1000;
  const command = buildProviderCommand(provider, prompt);
  const result = await runCommand(command.cmd, command.args, {
    timeoutMs,
    extraEnv: {
      CLAUDE_CODE_HEADLESS: 'true',
      CODEX_HEADLESS: 'true',
    },
  });

  if (!result.success) {
    return {
      raw: result.output,
      error: result.error || `${provider} command failed`,
    };
  }

  const parsed = parseProviderOutput(result.output);
  if (!parsed) {
    return {
      raw: result.output,
      error: `${provider} output was not valid structured JSON`,
    };
  }

  return {
    parsed,
    raw: result.output,
  };
}

async function getRoundRobinOrder(forcedProvider?: FixProvider): Promise<FixProvider[]> {
  if (forcedProvider) {
    return [forcedProvider];
  }

  const current = await queueConnection.get(ROUND_ROBIN_KEY);
  const first: FixProvider = current === 'codex' ? 'codex' : 'claude';
  const second: FixProvider = first === 'claude' ? 'codex' : 'claude';

  // Rotate pointer for next batch
  await queueConnection.set(ROUND_ROBIN_KEY, second);

  return [first, second];
}

/**
 * Run provider(s) with round-robin primary and one fallback attempt.
 */
export async function runDiagnosisWithProviders(
  items: FixJobContext[],
  forcedProvider?: FixProvider
): Promise<ProviderRunResult | { error: string; rawOutput?: string }> {
  const order = await getRoundRobinOrder(forcedProvider);
  let lastError = 'No provider attempted';
  let lastOutput = '';

  for (let index = 0; index < order.length; index++) {
    const provider = order[index];
    const result = await runProvider(provider, items);
    if (result.parsed) {
      return {
        provider,
        parsed: result.parsed,
        rawOutput: result.raw,
        fallbackUsed: index > 0,
      };
    }

    lastError = result.error || `${provider} failed`;
    lastOutput = result.raw;
  }

  return {
    error: lastError,
    rawOutput: lastOutput,
  };
}

