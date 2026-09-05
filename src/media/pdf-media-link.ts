/**
 * PDF ↔ MP4 linking for posts that carry video (x.com today; Patreon shares
 * the basename convention).
 *
 * The KB consumer pairs a post's PDF with its videos by shared basename, but
 * that convention has two holes the owner asked to close (2026-09-05):
 * multi-video tweets publish `<base>-2.mp4`, `<base>-3.mp4` …, and a video
 * that dedup identified as a copy lives under ANOTHER tweet's basename. So the
 * PDF now carries `LinkedMedia`: the `; `-separated basenames of every MP4
 * acquired for this post, wherever they live.
 *
 * The PDF and the video are produced by different workers in either order, so
 * the link is a handoff through Redis: the media worker records the final
 * paths under the post's canonical key and embeds them if the PDF already
 * exists; the conversion worker, after saving the PDF, embeds whatever was
 * recorded. Whichever side finishes last completes the link. Re-embedding
 * changes the PDF's mtime, which is what makes the nightly bundle re-ship it.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { env } from '../config/env.js';
import { normalizeBookmarkUrl } from '../urls/normalizer.js';
import { buildUrlBaseName } from '../utils/save-pdf.js';
import { readInfoDictField, setInfoDictFields } from '../utils/pdf-info-dict.js';

const require = createRequire(import.meta.url);
const sanitizeFilename = require('sanitize-filename') as (input: string) => string;

export const LINKED_MEDIA_PREFIX = 'media:linked:';

export interface LinkStore {
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

/** Canonical Redis key for a post: normalized URL with a lowercased path (X handles are case-insensitive). */
export function linkedMediaKey(postUrl: string): string {
  let key = normalizeBookmarkUrl(postUrl);
  try {
    const u = new URL(key);
    u.pathname = u.pathname.toLowerCase();
    u.search = '';
    key = u.toString();
  } catch { /* keep normalized */ }
  return `${LINKED_MEDIA_PREFIX}${key}`;
}

/** The PDF basename the capture pipeline uses for a post (see savePdfToWeeklyBin). */
export function postPdfBasename(postUrl: string): string {
  return `${sanitizeFilename(buildUrlBaseName(postUrl, { isXArticle: false })).substring(0, 140)}.pdf`;
}

/** Locate the post's PDF across week bins; null when not captured (yet). */
export async function findPostPdf(postUrl: string): Promise<string | null> {
  const wanted = postPdfBasename(postUrl).toLowerCase();
  const mediaRoot = path.join(env.DATA_DIR, 'media');
  let weeks: string[];
  try { weeks = await readdir(mediaRoot); } catch { return null; }
  for (const week of weeks.sort().reverse()) {
    if (!/^\d{4}-W\d{2}$/.test(week)) continue;
    const dir = path.join(mediaRoot, week, 'pdfs');
    let files: string[];
    try { files = await readdir(dir); } catch { continue; }
    const hit = files.find((f) => f.toLowerCase() === wanted);
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/** Merge basenames into the PDF's LinkedMedia field (idempotent). Returns true when written. */
export async function embedLinkedMedia(pdfPath: string, basenames: string[]): Promise<boolean> {
  if (basenames.length === 0) return false;
  try {
    const doc = await PDFDocument.load(await readFile(pdfPath), { updateMetadata: false });
    const existing = (readInfoDictField(doc, 'LinkedMedia') || '').split(';').map((s) => s.trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...basenames])].sort();
    if (merged.length === existing.length && merged.every((m, i) => m === [...existing].sort()[i])) return false;
    setInfoDictFields(doc, { LinkedMedia: merged.join('; ') });
    await writeFile(pdfPath, Buffer.from(await doc.save()));
    console.log(JSON.stringify({ event: 'linked_media_embedded', pdf: path.basename(pdfPath), media: merged, timestamp: new Date().toISOString() }));
    return true;
  } catch (error) {
    console.warn(`[pdf-media-link] embed failed for ${pdfPath}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Media worker side: record the acquired files for the post and, if its PDF
 * is already on disk, embed the link now.
 */
export async function recordLinkedMedia(store: LinkStore, postUrl: string, mediaPaths: string[]): Promise<void> {
  const basenames = mediaPaths.map((p) => path.basename(p));
  if (basenames.length === 0) return;
  try { await store.sadd(linkedMediaKey(postUrl), ...basenames); } catch { /* the PDF-side lookup is the backstop */ }
  const pdf = await findPostPdf(postUrl);
  if (pdf) await embedLinkedMedia(pdf, basenames);
}

/**
 * Conversion worker side: after the PDF is saved, embed any media already
 * recorded for the post.
 */
export async function applyLinkedMediaToPdf(store: LinkStore, postUrl: string, pdfPath: string): Promise<void> {
  let basenames: string[] = [];
  try { basenames = await store.smembers(linkedMediaKey(postUrl)); } catch { return; }
  if (basenames.length > 0) await embedLinkedMedia(pdfPath, basenames);
}
