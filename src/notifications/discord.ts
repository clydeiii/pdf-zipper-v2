/**
 * Discord webhook notifications for job events
 *
 * Sends rich embeds to Discord when jobs complete or fail.
 * Only active if DISCORD_WEBHOOK_URL is configured.
 */

import { env } from '../config/env.js';

/**
 * Discord embed color codes
 */
const COLORS = {
  success: 0x28a745,  // Green
  failure: 0xdc3545,  // Red
  warning: 0xffc107,  // Yellow
  info: 0x17a2b8,     // Blue
};

/**
 * Discord embed field
 */
interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * Discord embed structure
 */
interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: EmbedField[];
  timestamp?: string;
  footer?: {
    text: string;
  };
}

/**
 * Discord webhook payload
 */
interface DiscordPayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

/**
 * Check if Discord notifications are enabled
 */
export function isDiscordEnabled(): boolean {
  return !!env.DISCORD_WEBHOOK_URL;
}

/**
 * Send a message to the configured Discord webhook
 */
async function sendToDiscord(payload: DiscordPayload): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) {
    return;
  }

  try {
    const response = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`Discord webhook failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    // Don't throw - notifications are best-effort
    console.error('Discord notification error:', error instanceof Error ? error.message : error);
  }
}

/**
 * Truncate text to fit Discord's limits
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Notify Discord of successful job completion
 */
export async function notifyJobComplete(data: {
  jobId: string;
  url: string;
  pdfPath?: string;
  pdfSize?: number;
  qualityScore?: number;
  qualityReasoning?: string;
  duration?: number;
}): Promise<void> {
  const fields: EmbedField[] = [
    { name: 'URL', value: truncate(data.url, 1024), inline: false },
  ];

  if (data.pdfSize) {
    fields.push({ name: 'Size', value: formatSize(data.pdfSize), inline: true });
  }

  if (data.qualityScore !== undefined && data.qualityScore >= 0) {
    fields.push({ name: 'Quality', value: `${data.qualityScore}/100`, inline: true });
  }

  if (data.duration) {
    fields.push({ name: 'Duration', value: `${(data.duration / 1000).toFixed(1)}s`, inline: true });
  }

  if (data.pdfPath) {
    // Extract just the filename for cleaner display
    const filename = data.pdfPath.split('/').pop() || data.pdfPath;
    fields.push({ name: 'File', value: truncate(filename, 256), inline: false });
  }

  await sendToDiscord({
    embeds: [{
      title: 'PDF Conversion Complete',
      color: COLORS.success,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: `Job #${data.jobId}` },
    }],
  });
}

/**
 * Notify Discord of job failure
 */
export async function notifyJobFailed(data: {
  jobId: string;
  url: string;
  error: string;
  reason?: string;
  attemptsMade?: number;
  maxAttempts?: number;
}): Promise<void> {
  const fields: EmbedField[] = [
    { name: 'URL', value: truncate(data.url, 1024), inline: false },
    { name: 'Error', value: truncate(data.error, 1024), inline: false },
  ];

  if (data.reason) {
    fields.push({ name: 'Reason', value: data.reason, inline: true });
  }

  if (data.attemptsMade !== undefined && data.maxAttempts !== undefined) {
    fields.push({
      name: 'Attempts',
      value: `${data.attemptsMade}/${data.maxAttempts}`,
      inline: true
    });
  }

  // Add archive.is link for convenience
  fields.push({
    name: 'Archive',
    value: `[View on archive.is](https://archive.is/${encodeURIComponent(data.url)})`,
    inline: true,
  });

  await sendToDiscord({
    embeds: [{
      title: 'PDF Conversion Failed',
      color: COLORS.failure,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: `Job #${data.jobId}` },
    }],
  });
}

/**
 * Notify Discord of week rerun initiated
 */
export async function notifyWeekRerun(data: {
  weekId: string;
  urlCount: number;
}): Promise<void> {
  await sendToDiscord({
    embeds: [{
      title: 'Week Rerun Started',
      description: `Reprocessing all URLs from **${data.weekId}**`,
      color: COLORS.info,
      fields: [
        { name: 'URLs Submitted', value: `${data.urlCount}`, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

/**
 * Generic notification for custom events (e.g., podcast transcription)
 */
export async function sendDiscordNotification(data: {
  type: 'success' | 'failure' | 'warning' | 'info';
  title: string;
  description?: string;
  url?: string;
  fields?: EmbedField[];
}): Promise<void> {
  const fields: EmbedField[] = data.fields || [];

  if (data.url) {
    fields.unshift({ name: 'URL', value: truncate(data.url, 1024), inline: false });
  }

  await sendToDiscord({
    embeds: [{
      title: data.title,
      description: data.description,
      color: COLORS[data.type],
      fields: fields.length > 0 ? fields : undefined,
      timestamp: new Date().toISOString(),
    }],
  });
}
