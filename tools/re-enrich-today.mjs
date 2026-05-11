/**
 * Re-enrich today's video transcript PDFs with fresh yt-dlp metadata.
 *
 * Context: the yt-dlp metadata call was failing all day (cookies poisoning +
 * missing format fallback). Now that those are fixed, regenerate today's
 * transcript PDFs so they pick up channel name, upload date, thumbnail, and
 * description. Also update each MP4's container metadata with the same fields.
 *
 * Transcript body is reused verbatim from the existing PDF — no re-formatting,
 * no LLM call. The Whisper/Parakeet content is preserved exactly. Only the
 * header (title, channel, date, thumbnail, description, summary) is regenerated.
 *
 * Special case: the "from-authoritarian-..." file (originally Nazi, scrubbed).
 * yt-dlp will return YouTube's original title/description which contain "Nazi".
 * These get re-scrubbed before being written anywhere.
 *
 * Run:
 *   docker exec pdfzipper-v2 node /home/clyde/pdf-zipper-v2/tools/re-enrich-today.mjs
 */
import { readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { PDFParse } from '/app/node_modules/pdf-parse/dist/pdf-parse/esm/index.js';
import { generateTranscriptPdf } from '/app/dist/metadata/transcript-pdf.js';
import { fetchYouTubeMetadata } from '/app/dist/media/youtube-metadata.js';
import { readVideoMetadata } from '/app/dist/metadata/media-tags-reader.js';

const execFileAsync = promisify(execFile);
const VIDEOS_DIR = '/data/media/2026-W19/videos';
const TODAY_PDFS = [
  'robotics-end-game-nvidias-jim-fan.transcript.pdf',
  'ai-that-designs-its-own-chips-ricursives-anna-goldie-and-azalia-mirhoseini.transcript.pdf',
  'inside-the-rise-of-autonomous-ai-hackers-xbows-oege-de-moor.transcript.pdf',
  'building-makemore-part-5-building-a-wavenet.transcript.pdf',
  'why-we-switched-from-claude-code-to-codex.transcript.pdf',
  'clawdbot-moltbot-has-100k-stars.-it-has-zero-ai.transcript.pdf',
  'video-as-code-my-ai-animation-stack.transcript.pdf',
  'from-authoritarian-psychology-to-ai-auditing-inside-the-system-i-built.transcript.pdf',
];

const SCRUB_TARGETS = new Set([
  'from-authoritarian-psychology-to-ai-auditing-inside-the-system-i-built.transcript.pdf',
]);

function scrub(text) {
  if (!text) return text;
  return text
    .replace(/Nazis/g, 'authoritarians')
    .replace(/nazis/g, 'authoritarians')
    .replace(/Nazi/g, 'Authoritarian')
    .replace(/nazi/g, 'authoritarian');
}

/**
 * Extract just the transcript body from an existing transcript PDF.
 * Splits on the "Transcript (XX,XXX characters)" marker the generator writes.
 * pdf-parse joins single lines within a paragraph with \n and emits a blank
 * line between paragraphs — which matches what generateTranscriptPdf expects
 * on the way back in.
 */
async function extractTranscriptBody(pdfPath) {
  const buf = await readFile(pdfPath);
  const parser = new PDFParse({ data: buf });
  const { text } = await parser.getText();
  const marker = /\bTranscript\s*\([\d,]+\s*characters\)\s*\n/;
  const m = text.match(marker);
  if (!m) throw new Error(`could not locate "Transcript (N characters)" header`);
  return text.slice(m.index + m[0].length).trim();
}

async function reMuxMp4Metadata(mp4Path, yt, scrubbedTitle) {
  const tmp = `${mp4Path}.reenrich.tmp.mp4`;
  const args = [
    '-y', '-loglevel', 'error',
    '-i', mp4Path,
    '-c', 'copy',
  ];
  // Only override title when explicitly given (Nazi case). Otherwise leave
  // the existing title tag intact — ffmpeg's -c copy preserves all other tags.
  if (scrubbedTitle) args.push('-metadata', `title=${scrubbedTitle}`);
  if (yt.channel) args.push('-metadata', `channel=${yt.channel}`);
  if (yt.uploadDate) args.push('-metadata', `upload_date=${yt.uploadDate}`);
  if (yt.description) args.push('-metadata', `yt_description=${yt.description.slice(0, 4000)}`);
  args.push(tmp);

  await execFileAsync('ffmpeg', args, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
  await rename(tmp, mp4Path);
}

async function reEnrich(pdfName) {
  const pdfPath = path.join(VIDEOS_DIR, pdfName);
  const mp4Path = pdfPath.replace(/\.transcript\.pdf$/, '.mp4');
  const isScrubTarget = SCRUB_TARGETS.has(pdfName);

  const vmeta = await readVideoMetadata(mp4Path);
  if (!vmeta?.sourceUrl) return { ok: false, reason: 'no source URL in MP4 metadata' };

  const yt = await fetchYouTubeMetadata(vmeta.sourceUrl);
  if (!yt) return { ok: false, reason: 'yt-dlp returned null' };

  // For the Nazi/Authoritarian video, yt-dlp returns YouTube's original
  // title/description which contain "Nazi". Scrub before use anywhere.
  if (isScrubTarget) {
    yt.title = scrub(yt.title);
    yt.description = scrub(yt.description);
  }

  const transcriptBody = await extractTranscriptBody(pdfPath);

  // Title source: always the MP4's existing title (already scrubbed for the
  // Nazi case, correct for everyone else). Don't trust yt-dlp's title for the
  // scrub target.
  const finalTitle = vmeta.title || yt.title || path.basename(mp4Path, '.mp4');

  const pdfBytes = await generateTranscriptPdf({
    title: finalTitle,
    sourceUrl: vmeta.sourceUrl,
    date: yt.uploadDate,
    uploadDate: yt.uploadDate,
    summary: isScrubTarget ? scrub(vmeta.summary) : vmeta.summary,
    tags: vmeta.tags,
    author: yt.channel || vmeta.author,
    publication: vmeta.publication || yt.channel,
    channel: yt.channel,
    channelUrl: yt.channelUrl,
    description: yt.description,
    thumbnail: yt.thumbnail,
    transcriptText: transcriptBody,
  });
  await writeFile(pdfPath, pdfBytes);

  // Update MP4 container with yt-dlp custom fields it missed the first time.
  // Pass scrubbed title only for the scrub target; for others, MP4 title is
  // already correct and reMuxMp4Metadata leaves it untouched.
  await reMuxMp4Metadata(mp4Path, yt, isScrubTarget ? finalTitle : undefined);

  return {
    ok: true,
    channel: yt.channel,
    uploadDate: yt.uploadDate,
    thumbnail: !!yt.thumbnail,
    descriptionChars: yt.description?.length ?? 0,
    transcriptChars: transcriptBody.length,
    pdfBytes: pdfBytes.length,
    scrubbed: isScrubTarget,
  };
}

async function main() {
  console.log(`Re-enriching ${TODAY_PDFS.length} transcript PDFs from 2026-05-10`);
  console.log('---');
  let okCount = 0;
  for (const name of TODAY_PDFS) {
    process.stdout.write(`  ${name} ... `);
    try {
      const r = await reEnrich(name);
      if (r.ok) {
        const tags = [];
        if (r.scrubbed) tags.push('SCRUBBED');
        if (r.thumbnail) tags.push('thumb');
        console.log(`OK  channel="${r.channel}"  date=${r.uploadDate}  desc=${r.descriptionChars}c  pdf=${(r.pdfBytes/1024).toFixed(0)}KB ${tags.length ? '[' + tags.join(',') + ']' : ''}`);
        okCount++;
      } else {
        console.log(`SKIP (${r.reason})`);
      }
    } catch (e) {
      console.log(`ERROR ${e.message}`);
    }
  }
  console.log(`---\nDone. ${okCount}/${TODAY_PDFS.length} re-enriched.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
