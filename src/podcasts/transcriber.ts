/**
 * Whisper ASR transcription client
 *
 * Handles:
 * - Downloading podcast audio files
 * - Sending audio to Whisper ASR webservice
 * - Parsing transcription responses
 *
 * Whisper ASR Webservice docs: https://ahmetoner.com/whisper-asr-webservice/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlink, mkdir, writeFile } from 'node:fs/promises';
import { Agent } from 'undici';
import { env } from '../config/env.js';
import type { WhisperResponse, TranscriptionResult } from './types.js';

/**
 * Custom HTTP agent for Whisper requests with extended timeouts
 * Node's fetch uses undici internally, which has 5-minute default timeouts
 * Whisper transcription can take 7+ minutes for long podcasts
 */
const whisperAgent = new Agent({
  headersTimeout: 30 * 60 * 1000,  // 30 minutes for response headers
  bodyTimeout: 30 * 60 * 1000,     // 30 minutes for response body
  connectTimeout: 30 * 1000,       // 30 seconds to establish connection
});

/**
 * Temp directory for downloaded audio files
 */
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/podcast-transcriber';

/**
 * Download audio file to temporary location
 *
 * @param audioUrl - Direct URL to audio file (MP3/M4A)
 * @param extension - File extension (mp3, m4a)
 * @returns Path to downloaded file
 */
export async function downloadAudio(
  audioUrl: string,
  extension: string
): Promise<string> {
  // Ensure temp directory exists
  await mkdir(TEMP_DIR, { recursive: true });

  const filename = `${randomUUID()}.${extension}`;
  const filePath = path.join(TEMP_DIR, filename);

  console.log(JSON.stringify({
    event: 'audio_download_start',
    url: audioUrl.substring(0, 100) + '...',
    filePath,
    timestamp: new Date().toISOString(),
  }));

  const startTime = Date.now();

  const response = await fetch(audioUrl);

  if (!response.ok) {
    throw new Error(`Audio download failed: ${response.status} ${response.statusText}`);
  }

  // Get array buffer and write to file
  const arrayBuffer = await response.arrayBuffer();
  await writeFile(filePath, Buffer.from(arrayBuffer));

  const stats = fs.statSync(filePath);
  const downloadTime = Date.now() - startTime;

  console.log(JSON.stringify({
    event: 'audio_download_complete',
    filePath,
    sizeBytes: stats.size,
    sizeMB: Math.round(stats.size / 1024 / 1024 * 10) / 10,
    downloadTimeMs: downloadTime,
    timestamp: new Date().toISOString(),
  }));

  return filePath;
}

/**
 * Clean up temporary audio file
 */
export async function cleanupAudioFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
    console.log(JSON.stringify({
      event: 'audio_cleanup',
      filePath,
      timestamp: new Date().toISOString(),
    }));
  } catch (err) {
    // Ignore errors during cleanup
    console.warn(`Failed to cleanup audio file: ${filePath}`);
  }
}

/**
 * Clean up SRT-formatted text into plain paragraphs
 *
 * SRT format looks like:
 * ```
 * 1
 * 00:00:00,000 --> 00:00:05,000
 * Hello, this is the first segment.
 *
 * 2
 * 00:00:05,000 --> 00:00:10,000
 * And this is the second segment.
 * ```
 *
 * This function strips sequence numbers and timestamps,
 * then joins text into flowing paragraphs.
 */
function cleanupSrtText(text: string): string {
  const lines = text.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Skip sequence numbers (just digits)
    if (/^\d+$/.test(trimmed)) continue;

    // Skip timestamp lines (00:00:00,000 --> 00:00:05,000)
    if (/^\d{2}:\d{2}:\d{2}[,.:]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.:]\d{3}$/.test(trimmed)) continue;

    // This is actual text content
    textLines.push(trimmed);
  }

  // Join into paragraphs - group sentences together
  // Simple heuristic: join lines, add paragraph breaks at sentence-ending punctuation
  // followed by lines that start with capital letters
  const result: string[] = [];
  let currentParagraph: string[] = [];

  for (let i = 0; i < textLines.length; i++) {
    const line = textLines[i];
    currentParagraph.push(line);

    // Create paragraph break every ~5 sentences or when we hit a natural break
    // (This creates readable paragraphs from continuous transcript)
    const sentenceEnders = (currentParagraph.join(' ').match(/[.!?]/g) || []).length;
    if (sentenceEnders >= 5) {
      result.push(currentParagraph.join(' '));
      currentParagraph = [];
    }
  }

  // Add remaining text
  if (currentParagraph.length > 0) {
    result.push(currentParagraph.join(' '));
  }

  return result.join('\n\n');
}

/**
 * Detect if text is in SRT format
 */
function isSrtFormat(text: string): boolean {
  // Check for SRT timestamp pattern
  return /\d{2}:\d{2}:\d{2}[,.:]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.:]\d{3}/.test(text);
}

/**
 * Options for transcription
 */
export interface TranscribeOptions {
  /** Initial prompt to guide Whisper - helps with proper nouns, technical terms, etc. */
  initialPrompt?: string;
}

/**
 * Send audio to Whisper ASR for transcription
 *
 * Uses the whisper-asr-webservice API:
 * POST /asr?output=text
 * Content-Type: multipart/form-data
 * Body: audio_file=@file.mp3
 *
 * @param audioPath - Path to local audio file
 * @param options - Optional transcription options (initialPrompt for hints)
 * @returns Transcription result
 */
export async function transcribeAudio(
  audioPath: string,
  options?: TranscribeOptions
): Promise<WhisperResponse> {
  const url = new URL('/asr', env.WHISPER_HOST);
  url.searchParams.set('output', 'txt');  // Plain text transcript (not srt/vtt/json)

  console.log(JSON.stringify({
    event: 'transcription_start',
    audioPath,
    whisperHost: env.WHISPER_HOST,
    hasInitialPrompt: !!options?.initialPrompt,
    timestamp: new Date().toISOString(),
  }));

  const startTime = Date.now();

  // Read file and create form data
  const audioBuffer = fs.readFileSync(audioPath);
  const filename = path.basename(audioPath);

  const formData = new FormData();
  formData.append('audio_file', new Blob([audioBuffer]), filename);

  // Add initial_prompt if provided - helps Whisper with proper nouns and terms
  // Note: This only affects the first 30 seconds unless the ASR service has carry_initial_prompt=True
  if (options?.initialPrompt) {
    formData.append('initial_prompt', options.initialPrompt);
    console.log(JSON.stringify({
      event: 'whisper_initial_prompt',
      promptLength: options.initialPrompt.length,
      promptPreview: options.initialPrompt.substring(0, 200),
      timestamp: new Date().toISOString(),
    }));
  }

  // Whisper transcription can take 5-15+ minutes for long podcasts with medium.en model
  // Use custom agent with extended timeouts (undici default is 5 min which is too short)
  const response = await fetch(url.toString(), {
    method: 'POST',
    body: formData,
    // @ts-expect-error - dispatcher is valid for undici but not in standard fetch types
    dispatcher: whisperAgent,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper ASR error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  // Get response as text first for debugging
  const responseText = await response.text();
  const transcriptionTime = Date.now() - startTime;

  // Log raw response info for debugging
  console.log(JSON.stringify({
    event: 'whisper_response_received',
    responseLength: responseText.length,
    responsePreview: responseText.substring(0, 200),
    contentType: response.headers.get('content-type'),
    timestamp: new Date().toISOString(),
  }));

  // Parse the JSON response
  let result: WhisperResponse;
  try {
    result = JSON.parse(responseText) as WhisperResponse;
  } catch (parseError) {
    // If it's not JSON, the response might be plain text (output=text format)
    // Wrap it in our expected structure
    console.log(JSON.stringify({
      event: 'whisper_response_not_json',
      error: parseError instanceof Error ? parseError.message : String(parseError),
      timestamp: new Date().toISOString(),
    }));

    // Treat as plain text transcript
    result = { text: responseText };
  }

  // Clean up SRT format if detected (some Whisper deployments return SRT despite output=text)
  if (result.text && isSrtFormat(result.text)) {
    console.log(JSON.stringify({
      event: 'whisper_srt_cleanup',
      originalLength: result.text.length,
      timestamp: new Date().toISOString(),
    }));
    result.text = cleanupSrtText(result.text);
    console.log(JSON.stringify({
      event: 'whisper_srt_cleanup_complete',
      cleanedLength: result.text.length,
      timestamp: new Date().toISOString(),
    }));
  }

  console.log(JSON.stringify({
    event: 'transcription_complete',
    audioPath,
    transcriptLength: result.text?.length || 0,
    segmentCount: result.segments?.length || 0,
    detectedLanguage: result.language,
    transcriptionTimeMs: transcriptionTime,
    transcriptionTimeMinutes: Math.round(transcriptionTime / 60000 * 10) / 10,
    timestamp: new Date().toISOString(),
  }));

  return result;
}

/**
 * Full transcription pipeline: download → transcribe
 * NOTE: Does NOT clean up audio file - caller is responsible for cleanup after archival
 *
 * @param audioUrl - Direct URL to audio file
 * @param extension - File extension (mp3, m4a)
 * @param options - Optional transcription options (initialPrompt for hints)
 * @returns Transcription result with audio path for archival
 */
export async function transcribePodcast(
  audioUrl: string,
  extension: string,
  options?: TranscribeOptions
): Promise<TranscriptionResult> {
  // Download audio
  const audioPath = await downloadAudio(audioUrl, extension);

  // Get audio file size
  const stats = fs.statSync(audioPath);

  // Transcribe with optional hints
  const transcript = await transcribeAudio(audioPath, options);

  // Return both transcript and audio path (caller will archive and cleanup)
  return {
    transcript,
    audioPath,
    audioSize: stats.size,
  };
}
