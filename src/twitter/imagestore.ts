import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { env } from '../config/env.js';
import {
  getImageIndex,
  getTwitterDb,
  upsertImageIndex,
  type TwitterDatabase,
} from './db.js';
import type { ImageStoreResult } from './types.js';

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
};

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function extensionForImage(contentType: string | null, sourceUrl: string): string {
  const normalizedType = contentType?.split(';', 1)[0].trim().toLowerCase() ?? '';
  const fromType = CONTENT_TYPE_EXTENSIONS[normalizedType];
  if (fromType) return fromType;
  let pathname = sourceUrl;
  try {
    pathname = new URL(decodeURIComponent(sourceUrl), 'http://nitter.invalid').pathname;
  } catch {
    // Use the undecoded source below.
  }
  const candidate = path.extname(pathname).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(candidate) ? candidate : '.bin';
}

export function imageRelativePath(sha256: string, extension: string): string {
  return path.posix.join('twitter', 'imagestore', sha256.slice(0, 2), `${sha256}${extension}`);
}

function fetchUrlForNitter(nitterHost: string, fetchUrl: string): string {
  if (!fetchUrl.startsWith('/pic/')) {
    throw new Error(`Refusing non-Nitter image path: ${fetchUrl}`);
  }
  return new URL(fetchUrl, `${nitterHost.replace(/\/+$/, '')}/`).toString();
}

export interface StoreImageOptions {
  db?: TwitterDatabase;
  dataDir?: string;
  nitterHost?: string;
  sourceUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function storeNitterImage(
  fetchUrl: string,
  options: StoreImageOptions = {},
): Promise<ImageStoreResult> {
  const db = options.db ?? getTwitterDb();
  const dataDir = options.dataDir ?? env.DATA_DIR;
  const nitterHost = options.nitterHost ?? env.NITTER_HOST;
  const sourceUrl = options.sourceUrl ?? fetchUrl;
  const fetchImpl = options.fetchImpl ?? fetch;
  const existing = getImageIndex(db, sourceUrl);

  if (existing?.file) {
    return {
      url: sourceUrl,
      file: existing.file,
      sha256: existing.sha256,
      bytes: existing.bytes,
      contentType: existing.content_type,
      downloaded: false,
      error: null,
    };
  }
  if (existing?.error) {
    const age = Date.now() - new Date(existing.fetched_at).getTime();
    if (Number.isFinite(age) && age < RETRY_AFTER_MS) {
      return {
        url: sourceUrl,
        file: null,
        sha256: null,
        bytes: null,
        contentType: existing.content_type,
        downloaded: false,
        error: existing.error,
      };
    }
  }

  const fetchedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(fetchUrlForNitter(nitterHost, fetchUrl), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error('empty response');
    const sha256 = sha256Hex(bytes);
    const extension = extensionForImage(contentType, fetchUrl);
    const file = imageRelativePath(sha256, extension);
    const absoluteFile = path.join(dataDir, ...file.split('/'));
    // Content-addressed: identical bytes from a different URL already live at
    // this exact path — refer to the existing copy instead of rewriting it.
    if (!existsSync(absoluteFile)) {
      await mkdir(path.dirname(absoluteFile), { recursive: true });
      await writeFile(absoluteFile, bytes);
    }
    upsertImageIndex(db, {
      url: sourceUrl,
      file,
      sha256,
      bytes: bytes.byteLength,
      content_type: contentType,
      fetched_at: fetchedAt,
      error: null,
    });
    return {
      url: sourceUrl,
      file,
      sha256,
      bytes: bytes.byteLength,
      contentType,
      downloaded: true,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    upsertImageIndex(db, {
      url: sourceUrl,
      file: null,
      sha256: null,
      bytes: null,
      content_type: null,
      fetched_at: fetchedAt,
      error: message,
    });
    return {
      url: sourceUrl,
      file: null,
      sha256: null,
      bytes: null,
      contentType: null,
      downloaded: false,
      error: message,
    };
  }
}
