/**
 * One-off re-render for the 5 transcript PDFs damaged by the
 * macmini→ubuntu-m1pro ASR failover incident.
 *
 * Those videos were re-enriched from metadata-less MP4s (the original
 * transcription crashed before source_url/title were written), so they got a
 * `file://` Subject and a "Video Transcript" placeholder title — baked into
 * BOTH the Info Dict and the rendered page-1 header.
 *
 * The real titles + source URLs were recovered by matching each PDF's
 * transcript content to the source YouTube videos. This script fully
 * regenerates each PDF via the real generateTranscriptPdf, so the visible
 * header is fixed too — reusing the summary/tags/author/publication/language
 * already embedded in the file and re-extracting the formatted transcript body
 * from the existing PDF text (the only place it survives — there's no sidecar).
 *
 *   DATA_DIR=./data npx tsx scripts/rerender-transcript-pdfs.ts --dry-run
 *   DATA_DIR=./data npx tsx scripts/rerender-transcript-pdfs.ts
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { readInfoDictField } from '../src/utils/pdf-info-dict.js';
import { generateTranscriptPdf } from '../src/metadata/transcript-pdf.js';

const execFileAsync = promisify(execFile);

interface Repair {
  base: string;
  title: string;
  url: string;
}

const REPAIRS: Repair[] = [
  {
    base: 'internet-of-bugs-the-dumbest-new-trend-in-coding-productivity-setti',
    title: 'The Dumbest New Trend in Coding Productivity is Setting Money on Fire',
    url: 'https://www.youtube.com/watch?v=E_xN-uC-lT0',
  },
  {
    base: 'y-combinator-inference-diffusion-world-models-and-more-yc-paper',
    title: 'Inference, Diffusion, World Models, and More | YC Paper Club',
    url: 'https://www.youtube.com/watch?v=wE1ZgJdt4uM',
  },
  {
    base: 'cal-newport-did-ai-just-solve-math-lets-take-a-closer-look',
    title: 'Did AI Just "Solve" Math? (Let\'s Take a Closer Look)',
    url: 'https://www.youtube.com/watch?v=fhZRWZ6J4k4',
  },
  {
    base: 'ai-explained-new-claude-opus-48-15-things-you-mayve-missed',
    title: "New Claude Opus 4.8: 15 Things You May've Missed",
    url: 'https://www.youtube.com/watch?v=aJvP3nXWkwM',
  },
  {
    base: 'the-primetime-maybe-we-were-wrong',
    title: 'Maybe We Were Wrong',
    url: 'https://www.youtube.com/watch?v=SUDrFXFV-6U',
  },
];

const VIDEOS_DIR = path.join(process.env.DATA_DIR || './data', 'media', '2026-W22', 'videos');

/** Does this text end at a sentence boundary? Used to detect page-break splits. */
function endsSentence(s: string): boolean {
  return /[.!?:)"'’”]\s*$/.test(s.trimEnd());
}

/**
 * Extract the formatted transcript body from a transcript PDF's rendered text.
 *
 * pdftotext emits one line per rendered line and a blank line per vertical gap
 * (real paragraph breaks AND page boundaries). We rejoin word-wrapped lines
 * into paragraphs, then merge any "paragraph" that doesn't end on sentence
 * punctuation into the next one — that collapses the false breaks introduced at
 * page boundaries while keeping the LLM's real paragraphing.
 */
async function extractTranscriptBody(pdfPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'pdftotext',
    [pdfPath, '-'],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  // Drop everything up to and including the "Transcript (N characters)" header.
  const marker = stdout.search(/^Transcript \([\d,]+ characters?\)\s*$/m);
  let body = marker >= 0 ? stdout.slice(stdout.indexOf('\n', marker) + 1) : stdout;
  body = body.replace(/\f/g, '\n'); // form feed (page break) -> blank line

  // Group lines into blank-line-delimited blocks, rejoining wrapped lines.
  const blocks: string[] = [];
  let current: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      if (current.length) { blocks.push(current.join(' ')); current = []; }
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join(' '));

  // Merge blocks split mid-sentence (page boundaries) back together.
  const paragraphs: string[] = [];
  for (const block of blocks) {
    const text = block.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (paragraphs.length && !endsSentence(paragraphs[paragraphs.length - 1])) {
      paragraphs[paragraphs.length - 1] += ' ' + text;
    } else {
      paragraphs.push(text);
    }
  }
  return paragraphs.join('\n\n');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  let done = 0;

  for (const r of REPAIRS) {
    const pdfPath = path.join(VIDEOS_DIR, `${r.base}.transcript.pdf`);
    try {
      await access(pdfPath);
    } catch {
      console.warn(`SKIP (not found): ${path.basename(pdfPath)}`);
      continue;
    }

    // Pull the metadata already embedded by the (broken) enrichment run.
    const existing = await PDFDocument.load(await readFile(pdfPath));
    const tagsCsv = readInfoDictField(existing, 'Tags');
    const opts = {
      title: r.title,
      sourceUrl: r.url,
      summary: readInfoDictField(existing, 'Summary'),
      tags: tagsCsv ? tagsCsv.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      language: readInfoDictField(existing, 'Language'),
      author: existing.getAuthor() || undefined,
      publication: readInfoDictField(existing, 'Publication'),
      channel: readInfoDictField(existing, 'Channel'),
      channelUrl: readInfoDictField(existing, 'ChannelUrl'),
      uploadDate: readInfoDictField(existing, 'UploadDate'),
      description: readInfoDictField(existing, 'Description'),
      date: readInfoDictField(existing, 'PublishDate'),
      transcriptText: await extractTranscriptBody(pdfPath),
    };

    console.log(`${dryRun ? 'WOULD re-render' : 'Re-rendering'} ${r.base}.transcript.pdf`);
    console.log(`    Title: "${r.title}"`);
    console.log(`    Transcript: ${opts.transcriptText.length.toLocaleString()} chars, summary: ${opts.summary ? 'yes' : 'no'}, tags: ${opts.tags?.length ?? 0}`);

    if (!dryRun) {
      const buf = await generateTranscriptPdf(opts);
      await writeFile(pdfPath, buf);
    }
    done++;
  }

  console.log(`Done: ${done}/${REPAIRS.length} ${dryRun ? '(dry-run)' : 're-rendered'}`);
}

main().catch((err) => {
  console.error('rerender-transcript-pdfs failed:', err);
  process.exit(1);
});
