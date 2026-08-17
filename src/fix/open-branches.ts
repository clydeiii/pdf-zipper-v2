/**
 * Open self-heal branches, surfaced to the next diagnosis.
 *
 * Batches land on `fix/batch-*` and never auto-merge, so an unmerged branch
 * does nothing to stop the failure recurring — the same item gets flagged
 * again, a fresh batch runs, and it re-derives the same patch. That is not
 * hypothetical: the Aug-2026 triage found one fix re-implemented on seven
 * consecutive nights and another six times across six branches, out of a
 * 68-branch backlog.
 *
 * Showing the agent what is already waiting lets it say "this is already
 * addressed by fix/batch-XXXX" instead of writing branch number eight.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_DIR = process.env.FIX_REPO_DIR || '/home/clyde/pdf-zipper-v2';

/** Keep the prompt bounded; the newest branches are the relevant ones. */
const MAX_BRANCHES = 25;
/** Per-branch file list cap — enough to recognise overlap, not a full diff. */
const MAX_FILES_SHOWN = 6;
/** Symbols are the highest-signal field; a handful identifies a branch. */
const MAX_SYMBOLS_SHOWN = 8;

export interface OpenFixBranch {
  name: string;
  /** Commit subject of the branch tip. */
  subject: string;
  /** Repo-relative paths the branch changes, relative to master. */
  files: string[];
  /**
   * Top-level identifiers the branch introduces (constants, functions).
   *
   * The generated commit subjects are all "fix(self-heal): batch <id> via
   * claude" with an empty body, so they carry no information about what the
   * branch does. The symbols it adds do: a branch introducing
   * SUBSTACK_PAID_BADGE is recognisably the Substack-preview fix.
   */
  addedSymbols: string[];
}

/**
 * Symbols a branch introduces, read from its added lines.
 *
 * Anchored at column 0 so only module-level declarations count — matching
 * indented lines too pulled in every local (`page`, `cookies`, `obj`) and
 * buried the names that actually identify the branch.
 *
 * Exported for testing.
 */
export function extractAddedSymbols(diff: string): string[] {
  const symbols = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const m = line.match(
      /^\+(?:export\s+)?(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)/
    );
    if (m) symbols.add(m[1]);
  }
  return [...symbols];
}

async function git(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: REPO_DIR,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * List unmerged `fix/batch-*` branches, newest first. Returns [] on any
 * failure — branch awareness is an optimisation, never a reason to skip a
 * diagnosis.
 */
export async function listOpenFixBranches(): Promise<OpenFixBranch[]> {
  // --no-merged master: a branch already folded into master is settled and
  // would only add noise.
  const listed = await git([
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)%09%(contents:subject)',
    '--no-merged', 'master',
    'refs/heads/fix/',
  ]);
  if (!listed) return [];

  const rows = listed.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, MAX_BRANCHES);
  const branches: OpenFixBranch[] = [];

  for (const row of rows) {
    const [name, ...subjectParts] = row.split('\t');
    if (!name) continue;
    const changed = await git(['diff', '--name-only', `master...${name}`]);
    const files = (changed || '').split('\n').map((f) => f.trim()).filter(Boolean);
    const diff = await git(['diff', '--unified=0', `master...${name}`, '--', 'src']);
    branches.push({
      name,
      subject: (subjectParts.join('\t') || '').trim(),
      files,
      addedSymbols: extractAddedSymbols(diff || '').slice(0, MAX_SYMBOLS_SHOWN),
    });
  }
  return branches;
}

/**
 * Render the branch list for the diagnosis prompt. Returns '' when there's
 * nothing open, so the prompt gains no empty section.
 *
 * Exported for testing.
 */
export function buildOpenBranchSection(branches: OpenFixBranch[]): string {
  if (branches.length === 0) return '';

  const lines = branches.map((b) => {
    const shown = b.files.slice(0, MAX_FILES_SHOWN);
    const extra = b.files.length > shown.length ? ` (+${b.files.length - shown.length} more)` : '';
    const files = shown.length > 0 ? `${shown.join(', ')}${extra}` : 'no file changes';
    const symbols = b.addedSymbols && b.addedSymbols.length > 0
      ? `\n  adds: ${b.addedSymbols.join(', ')}`
      : '';
    return `- **${b.name}** — ${b.subject || 'no subject'}\n  touches: ${files}${symbols}`;
  });

  return `
## Fixes already waiting for review (DO NOT re-implement)

These branches were produced by earlier runs of this same system and are
awaiting human review. **An unmerged branch does not stop the failure from
recurring**, so the item you are looking at may well be one these already fix.
That is the normal case here, not the exception.

${lines.join('\n')}

Before writing any code:

1. Check whether one of the above already addresses this root cause — compare
   the files it touches and read its diff with
   \`git diff master...<branch> -- <file>\`.
2. If it does, set \`"fixApplied": false\`, name the branch in
   \`"alreadyAddressedBy"\`, and explain in \`rootCause\` why it applies. Write
   no code. This is a **successful** diagnosis, not a failure — it tells the
   human which branch to merge.
3. Only write a fix if none of them covers it, or if you can explain in
   \`rootCause\` why the existing attempt is wrong or incomplete.

A duplicate branch is worse than no branch: it splits the evidence across two
diffs and makes the backlog harder to clear.
`;
}
