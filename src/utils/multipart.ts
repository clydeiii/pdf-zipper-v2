import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import * as path from 'node:path';

interface MultipartFileOptions {
  filePath: string;
  fieldName?: string;
  filename?: string;
  contentType?: string;
  fields?: Record<string, string | undefined>;
}

export interface MultipartFileBody {
  body: Readable;
  contentType: string;
  contentLength: number;
}

/**
 * Build a streaming multipart/form-data body for one file plus small text fields.
 * This avoids buffering long podcast/video audio into memory before ASR upload.
 */
export async function createMultipartFileBody(options: MultipartFileOptions): Promise<MultipartFileBody> {
  const {
    filePath,
    fieldName = 'audio_file',
    filename = path.basename(filePath),
    contentType = 'application/octet-stream',
    fields = {},
  } = options;

  const boundary = `----pdfzipper-${randomUUID()}`;
  const fieldParts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    fieldParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
    ));
  }

  const fileHeader = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fileSize = (await stat(filePath)).size;

  async function* streamParts(): AsyncGenerator<Buffer> {
    for (const part of fieldParts) yield part;
    yield fileHeader;
    for await (const chunk of createReadStream(filePath)) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    yield closing;
  }

  const contentLength = fieldParts.reduce((sum, part) => sum + part.length, 0)
    + fileHeader.length
    + fileSize
    + closing.length;

  return {
    body: Readable.from(streamParts()),
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength,
  };
}
