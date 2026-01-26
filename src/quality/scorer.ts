/**
 * PDF quality scorer using vision model analysis
 * Combines PDF-to-image conversion with Ollama analysis for quality scoring
 */

import { analyzeImageWithOllama } from './ollama.js';
import { env } from '../config/env.js';
import type { QualityResult, QualityIssue, QualityScore } from './types.js';

/**
 * Quality scoring prompt for vision model
 * Instructs model to return JSON with score, issue type, and reasoning
 */
const QUALITY_PROMPT = `You are analyzing a screenshot of the TOP PORTION of a web page (first viewport only).
This is used to verify the page loaded correctly before PDF conversion.

IMPORTANT: This screenshot shows ONLY the top ~800px of the page. It is NORMAL for article content to continue below what's visible. Do NOT mark pages as "truncated" just because you can only see the beginning of an article.

Check for these ACTUAL problems:
- Blank/empty page (no content loaded)
- Bot detection or captcha pages
- Paywall blocking content
- Error messages
- Login required pages

Score the quality from 0-100:
- 0: Blank page, solid color only, or critical error
- 0-20: Bot detection, captcha, "verify you are human" message
- 20-40: Paywall visible, login required, content explicitly blocked
- 40-60: Page loaded but has significant issues (broken layout, error messages mixed with content)
- 60-80: Content present with minor issues (ads, some missing images)
- 80-100: Page loaded successfully with readable content visible

VALID pages that should score 80+:
- Article with headline and opening paragraphs visible (even if article continues below)
- Tweet/post with the content visible
- Blog post with title and beginning of content
- Dark-themed pages with readable text

Respond with ONLY valid JSON:
{"score": <number 0-100>, "issue": "<issue_type or null>", "reasoning": "<brief explanation>"}

issue_type: "blank_page", "paywall", "bot_detected", "login_required", "error_page", or null

Examples:
{"score": 0, "issue": "blank_page", "reasoning": "Page is completely blank with no content"}
{"score": 15, "issue": "bot_detected", "reasoning": "Captcha verification page shown"}
{"score": 25, "issue": "paywall", "reasoning": "Subscribe to read message blocks content"}
{"score": 85, "issue": null, "reasoning": "Article headline and opening paragraphs visible, page loaded correctly"}
{"score": 90, "issue": null, "reasoning": "Blog post content is visible and readable"}`;

/**
 * Parse quality response from vision model
 * Handles both clean JSON and markdown-wrapped JSON responses
 * @param response - Raw response string from vision model
 * @returns Parsed QualityScore or null if parsing fails
 */
function parseQualityResponse(response: string): QualityScore | null {
  try {
    // Try direct JSON parse first
    const parsed = JSON.parse(response);
    if (typeof parsed.score === 'number' && typeof parsed.reasoning === 'string') {
      return {
        score: Math.max(0, Math.min(100, parsed.score)), // clamp to 0-100
        issue: parsed.issue || undefined,
        reasoning: parsed.reasoning,
      };
    }
  } catch {
    // Try to extract JSON from markdown code blocks or surrounding text
    const jsonMatch = response.match(/\{[\s\S]*?"score"[\s\S]*?"reasoning"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.score === 'number' && typeof parsed.reasoning === 'string') {
          return {
            score: Math.max(0, Math.min(100, parsed.score)),
            issue: parsed.issue || undefined,
            reasoning: parsed.reasoning,
          };
        }
      } catch {
        // Fall through to null
      }
    }
  }
  return null;
}

/**
 * Score page quality using vision model analysis on a screenshot
 * @param screenshotBuffer - PNG screenshot as Buffer (from Playwright)
 * @returns Quality result with pass/fail, score, and optional issue
 */
export async function scoreScreenshotQuality(screenshotBuffer: Buffer): Promise<QualityResult> {
  // Convert to base64 for Ollama
  const imageBase64 = screenshotBuffer.toString('base64');

  // Send to vision model
  const response = await analyzeImageWithOllama(imageBase64, QUALITY_PROMPT);

  // Parse response with fallback handling
  const parsedScore = parseQualityResponse(response);

  if (!parsedScore) {
    // Couldn't parse response - log and use default score
    console.warn('Failed to parse quality response:', response.substring(0, 200));
    return {
      passed: false,
      score: { score: 0, issue: 'unknown', reasoning: 'Failed to parse quality assessment response' },
      issue: 'unknown',
    };
  }

  // Determine pass/fail based on threshold
  const threshold = env.QUALITY_THRESHOLD;
  const passed = parsedScore.score >= threshold;

  if (passed) {
    return {
      passed: true,
      score: parsedScore,
    };
  } else {
    return {
      passed: false,
      score: parsedScore,
      issue: parsedScore.issue || 'unknown',
    };
  }
}
