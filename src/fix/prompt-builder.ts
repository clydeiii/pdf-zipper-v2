/**
 * Prompt builder for Claude Code diagnosis sessions
 *
 * Constructs prompts that provide Claude Code with:
 * - Context about what went wrong
 * - Paths to relevant PDFs and source files
 * - Clear instructions on what to diagnose and fix
 */

import type { FixJobContext } from '../jobs/fix-types.js';

/**
 * Build the diagnosis prompt for Claude Code
 *
 * The prompt instructs Claude to:
 * 1. Read the relevant PDF(s) to understand the issue
 * 2. Analyze the quality scoring and conversion code
 * 3. Identify root cause
 * 4. Apply a fix if possible
 * 5. Output structured JSON with diagnosis
 */
export function buildDiagnosisPrompt(items: FixJobContext[]): string {
  const sections: string[] = [];

  // Introduction
  sections.push(`# AI Self-Healing Diagnosis Session

You are diagnosing issues with pdf-zipper-v2's URL-to-PDF conversion and quality classification system.

## Your Task

The user has flagged the following items as incorrectly classified. Your job is to:

1. **Analyze each item** - Read the PDF(s) to understand what was captured
2. **Identify root cause** - Why did the system make the wrong decision?
3. **Apply fixes** - If you can identify a code fix that would prevent this, apply it
4. **Output diagnosis** - Return structured JSON with your findings

## Safety Boundaries

You are authorized to modify files within these boundaries:
- ✅ src/quality/* - Quality scoring logic
- ✅ src/converters/* - PDF conversion logic
- ✅ Run tests (npm test) to verify changes
- ❌ DO NOT modify config files (.env, docker-compose.yml)
- ❌ DO NOT modify package.json
- ❌ DO NOT make network requests
- ❌ DO NOT push to git (read-only git commands are OK)

## Items to Diagnose
`);

  // Add each item
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    sections.push(buildItemSection(item, i + 1));
  }

  // Output format
  sections.push(`
## Output Format

After completing your diagnosis, output a JSON object with this structure:

\`\`\`json
{
  "diagnoses": [
    {
      "url": "https://example.com/article",
      "requestType": "false_positive" | "false_negative",
      "rootCause": "Description of why the system made the wrong decision",
      "suggestedFix": "Description of the fix applied or recommended",
      "filesModified": ["src/quality/scorer.ts"],
      "fixApplied": true | false
    }
  ],
  "summary": "Brief summary of all diagnoses and any patterns observed"
}
\`\`\`

## Important Notes

- Be concise in your analysis - focus on actionable insights
- If you modify code, make minimal targeted changes
- If you're unsure about a fix, describe what you would change but set fixApplied to false
- Look for patterns across multiple items - one fix might address several issues
`);

  return sections.join('\n');
}

/**
 * Build the section for a single item
 */
function buildItemSection(item: FixJobContext, index: number): string {
  const lines: string[] = [];

  lines.push(`### Item ${index}: ${item.requestType === 'false_positive' ? 'False Positive' : 'False Negative'}`);
  lines.push('');
  lines.push(`**URL:** ${item.url}`);
  lines.push(`**Status:** ${item.status}`);
  lines.push(`**Week:** ${item.weekId}`);

  if (item.requestType === 'false_positive') {
    // False positive - a PDF was saved that shouldn't have been
    lines.push('');
    lines.push('**Issue:** This PDF was saved as successful, but the user believes it should have failed quality checks.');
    lines.push('');

    if (item.pdfPath) {
      lines.push(`**PDF to analyze:** ${item.pdfPath}`);
      lines.push('Read this PDF to see what was actually captured.');
    }

    if (item.qualityScore !== undefined) {
      lines.push(`**Quality Score:** ${item.qualityScore}/100`);
    }
    if (item.qualityReasoning) {
      lines.push(`**Quality Reasoning:** ${item.qualityReasoning}`);
    }

    lines.push('');
    lines.push('**Questions to answer:**');
    lines.push('- What is wrong with this PDF? (blank, truncated, paywall, wrong content, etc.)');
    lines.push('- Why did the quality scorer give it a passing score?');
    lines.push('- What check could be added to catch this issue?');

  } else {
    // False negative - a URL failed that should have succeeded
    lines.push('');
    lines.push('**Issue:** This URL failed conversion, but the user believes it should have succeeded.');
    lines.push('');

    if (item.failureReason) {
      lines.push(`**Failure Reason:** ${item.failureReason}`);
    }

    if (item.debugPdfPath) {
      lines.push(`**Debug PDF:** ${item.debugPdfPath}`);
      lines.push('Read this PDF to see what was actually captured before it was rejected.');
    }

    lines.push('');
    lines.push('**Questions to answer:**');
    lines.push('- Was this a legitimate failure or overly aggressive quality check?');
    lines.push('- If the PDF content is actually good, why was it rejected?');
    lines.push('- What change could prevent this false rejection?');
  }

  lines.push('');
  lines.push('---');

  return lines.join('\n');
}

/**
 * Build a verification prompt for re-running a URL after applying a fix
 */
export function buildVerificationPrompt(url: string, originalIssue: string): string {
  return `# Fix Verification

A code fix was applied to address this issue:

**URL:** ${url}
**Original Issue:** ${originalIssue}

Please verify the fix by checking if the URL would now be handled correctly.

Note: The actual re-conversion will be done by the system after this diagnosis session.
Just confirm whether your analysis suggests the fix should work.

Output:
\`\`\`json
{
  "expectedToWork": true | false,
  "reasoning": "Why you expect the fix to work or not"
}
\`\`\`
`;
}
