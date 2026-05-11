/**
 * One-off content scrubber for the "From Nazi Psychology to AI Auditing" video.
 *
 * Replaces "Nazi"/"Nazis" with "Authoritarian"/"authoritarians" in:
 *   - MP4 file basename (rename)
 *   - MP4 `title` tag
 *   - Embedded WebVTT subtitle stream
 *   - Transcript PDF basename (rename)
 *   - Transcript PDF body text + Info Dict Title
 *
 * Run inside the container:
 *   docker exec pdfzipper-v2 node /home/clyde/pdf-zipper-v2/tools/scrub-nazi.mjs
 *
 * Idempotent: safe to re-run; if the new files already exist it bails.
 */
import { readFile, writeFile, rename, unlink, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { generateTranscriptPdf as generateVideoPdf } from '/app/dist/metadata/transcript-pdf.js';
import { fetchYouTubeMetadata } from '/app/dist/media/youtube-metadata.js';
import { readVideoMetadata } from '/app/dist/metadata/media-tags-reader.js';
import { formatTranscriptWithLLM } from '/app/dist/podcasts/transcript-formatter.js';

const execFileAsync = promisify(execFile);

const VIDEOS_DIR = '/data/media/2026-W19/videos';
const OLD_BASE = 'from-nazi-psychology-to-ai-auditing-inside-the-system-i-built';
const NEW_BASE = 'from-authoritarian-psychology-to-ai-auditing-inside-the-system-i-built';

const OLD_MP4 = path.join(VIDEOS_DIR, `${OLD_BASE}.mp4`);
const OLD_PDF = path.join(VIDEOS_DIR, `${OLD_BASE}.transcript.pdf`);
const NEW_MP4 = path.join(VIDEOS_DIR, `${NEW_BASE}.mp4`);
const NEW_PDF = path.join(VIDEOS_DIR, `${NEW_BASE}.transcript.pdf`);

/** Word-level scrub. Order matters: plural before singular so "Nazis" doesn't become "Authoritarians". */
function scrub(text) {
  if (!text) return text;
  return text
    .replace(/Nazis/g, 'authoritarians')
    .replace(/nazis/g, 'authoritarians')
    .replace(/Nazi/g, 'Authoritarian')
    .replace(/nazi/g, 'authoritarian');
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function extractVtt(mp4Path) {
  const tmp = `/tmp/scrub-${process.pid}.vtt`;
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', mp4Path,
    '-map', '0:s:0',
    '-c:s', 'webvtt',
    tmp,
  ]);
  const vtt = await readFile(tmp, 'utf8');
  await unlink(tmp).catch(() => {});
  return vtt;
}

function vttToPlainText(vtt) {
  const out = [];
  for (const raw of vtt.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'WEBVTT') continue;
    if (line.includes('-->')) continue;
    if (/^\d+$/.test(line)) continue;
    if (line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) continue;
    out.push(line);
  }
  return out.join(' ');
}

/**
 * Re-mux MP4: copy video+audio from input, replace subtitle stream from new VTT,
 * override `title` tag. All other container metadata is preserved by ffmpeg's
 * default copy behavior on input 0.
 */
async function remuxMp4(srcMp4, dstMp4, scrubbedVtt, scrubbedTitle) {
  const vttPath = `/tmp/scrub-${process.pid}.subs.vtt`;
  const tmpOut = `${dstMp4}.tmp.mp4`;
  try {
    await writeFile(vttPath, scrubbedVtt);
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', srcMp4,
      '-i', vttPath,
      '-map', '0:v', '-map', '0:a', '-map', '1:s',
      '-c', 'copy',
      '-c:s', 'mov_text',
      '-metadata:s:s:0', 'language=eng',
      '-metadata:s:s:0', 'title=Transcript',
      '-metadata', `title=${scrubbedTitle}`,
      tmpOut,
    ], { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
    await rename(tmpOut, dstMp4);
  } finally {
    await unlink(vttPath).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}

async function main() {
  console.log(`Scrubbing: ${OLD_MP4}`);

  // Bail if already scrubbed (idempotent guard)
  if (await exists(NEW_MP4) || await exists(NEW_PDF)) {
    console.log('Target file(s) already exist — refusing to overwrite. Aborting.');
    process.exit(1);
  }
  if (!(await exists(OLD_MP4)) || !(await exists(OLD_PDF))) {
    console.log('Source MP4 or PDF missing.');
    process.exit(1);
  }

  // 1. Read existing MP4 metadata (title, summary, tags, sourceUrl)
  const vmeta = await readVideoMetadata(OLD_MP4);
  if (!vmeta?.sourceUrl) {
    console.log('No sourceUrl in MP4 metadata — bailing.');
    process.exit(1);
  }
  console.log(`  source URL: ${vmeta.sourceUrl}`);
  console.log(`  old title:  ${vmeta.title}`);
  const newTitle = scrub(vmeta.title);
  const newSummary = scrub(vmeta.summary);
  console.log(`  new title:  ${newTitle}`);

  // 2. yt-dlp metadata (channel, uploadDate, thumbnail, description)
  // Best-effort — failed once before, may still fail.
  let ytMeta = null;
  try {
    ytMeta = await fetchYouTubeMetadata(vmeta.sourceUrl);
    if (ytMeta) console.log(`  yt-dlp:     channel="${ytMeta.channel}" upload=${ytMeta.uploadDate}`);
  } catch (e) {
    console.warn(`  yt-dlp failed: ${e.message}`);
  }

  // 3. Extract VTT, scrub
  const vttRaw = await extractVtt(OLD_MP4);
  const vttScrubbed = scrub(vttRaw);
  const rawTranscript = vttToPlainText(vttScrubbed);
  console.log(`  VTT scrubbed: ${vttRaw.length} -> ${vttScrubbed.length} chars`);

  // 4. Format transcript with LLM (matches original generation flow).
  // The title hint is the SCRUBBED title so the formatter doesn't reintroduce
  // "Nazi" via proper-noun correction.
  let formattedTranscript = rawTranscript;
  try {
    formattedTranscript = await formatTranscriptWithLLM(rawTranscript, {
      episodeTitle: newTitle,
    });
    console.log(`  LLM formatted: ${rawTranscript.length} -> ${formattedTranscript.length} chars`);
  } catch (e) {
    console.warn(`  LLM format failed, using raw VTT text: ${e.message}`);
  }
  // Belt-and-suspenders: scrub the LLM output too in case it reintroduced anything
  formattedTranscript = scrub(formattedTranscript);

  // 5. Re-mux MP4 to new path with scrubbed VTT + scrubbed title
  await remuxMp4(OLD_MP4, NEW_MP4, vttScrubbed, newTitle);
  console.log(`  MP4 written: ${NEW_MP4}`);

  // 6. Generate new transcript PDF
  const pdf = await generateVideoPdf({
    title: newTitle,
    sourceUrl: vmeta.sourceUrl,
    date: ytMeta?.uploadDate,
    uploadDate: ytMeta?.uploadDate,
    summary: newSummary,
    tags: vmeta.tags,
    author: ytMeta?.channel || vmeta.author,
    publication: vmeta.publication || ytMeta?.channel,
    channel: ytMeta?.channel,
    channelUrl: ytMeta?.channelUrl,
    description: scrub(ytMeta?.description),
    thumbnail: ytMeta?.thumbnail,
    transcriptText: formattedTranscript,
  });
  await writeFile(NEW_PDF, pdf);
  console.log(`  PDF written: ${NEW_PDF} (${pdf.length} bytes)`);

  // 7. Delete originals (safe — new files exist and were written successfully)
  await unlink(OLD_MP4);
  await unlink(OLD_PDF);
  console.log(`  Removed originals.`);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
