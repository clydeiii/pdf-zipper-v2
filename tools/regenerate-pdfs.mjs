/**
 * One-off PDF regenerator.
 *
 * Re-renders the latest N podcast PDFs and YouTube transcript PDFs with the
 * newly-supported artwork (podcasts) and thumbnails (videos) — without
 * re-transcribing. Reuses transcripts already stored in the media files:
 *   - Podcasts: MP3 ID3 USLT (unsynchronisedLyrics) frame
 *   - Videos:   embedded VTT subtitle stream (extracted via ffmpeg, then
 *               cleaned through formatTranscriptWithLLM since VTT is raw)
 *
 * Run inside the container:
 *   docker cp tools/regenerate-pdfs.mjs pdfzipper-v2:/tmp/
 *   docker exec pdfzipper-v2 node /tmp/regenerate-pdfs.mjs [N]
 */
import { readdir, stat, readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import NodeID3 from 'node-id3';
import { getPodcastMetadata } from '/app/dist/podcasts/apple.js';
import { generateTranscriptPdf as generatePodcastPdf } from '/app/dist/podcasts/pdf-generator.js';
import { generateTranscriptPdf as generateVideoPdf } from '/app/dist/metadata/transcript-pdf.js';
import { fetchYouTubeMetadata, isYouTubeOrVimeoUrl } from '/app/dist/media/youtube-metadata.js';
import { readVideoMetadata } from '/app/dist/metadata/media-tags-reader.js';
import { formatTranscriptWithLLM } from '/app/dist/podcasts/transcript-formatter.js';

const execFileAsync = promisify(execFile);
const N = parseInt(process.argv[2] || '10', 10);
const MEDIA_ROOT = '/data/media';

async function listWeekDirs() {
  const entries = await readdir(MEDIA_ROOT);
  return entries.filter(e => /^\d{4}-W\d{2}$/.test(e)).sort().reverse();
}

/** Walk most recent weeks, return up to `limit` matching files sorted by mtime desc. */
async function findLatest(subdir, predicate, limit) {
  const out = [];
  for (const week of await listWeekDirs()) {
    if (out.length >= limit) break;
    const dir = path.join(MEDIA_ROOT, week, subdir);
    let names;
    try { names = await readdir(dir); } catch { continue; }
    const matches = await Promise.all(names
      .filter(predicate)
      .map(async (n) => {
        const p = path.join(dir, n);
        const s = await stat(p);
        return { path: p, mtime: s.mtimeMs };
      }));
    matches.sort((a, b) => b.mtime - a.mtime);
    for (const m of matches) {
      if (out.length >= limit) break;
      out.push(m.path);
    }
  }
  return out;
}

async function readPdfSubject(pdfPath) {
  try {
    const buf = await readFile(pdfPath);
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const subj = doc.getSubject();
    if (subj && (subj.startsWith('http://') || subj.startsWith('https://'))) return subj;
  } catch {}
  return null;
}

async function extractVttFromMp4(mp4Path) {
  const tmp = `/tmp/regen-${process.pid}-${Date.now()}.vtt`;
  try {
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
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
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

async function regenPodcast(pdfPath) {
  const url = await readPdfSubject(pdfPath);
  if (!url || !url.includes('podcasts.apple.com')) {
    return { ok: false, reason: 'not an Apple Podcasts URL' };
  }
  const mp3Path = pdfPath.replace(/\.pdf$/, '.mp3');
  let id3;
  try { id3 = NodeID3.read(mp3Path); } catch (e) { return { ok: false, reason: `id3 read failed: ${e.message}` }; }

  // node-id3 returns USLT either as { text } object or as a plain string depending on version.
  let transcript;
  const usl = id3.unsynchronisedLyrics;
  if (typeof usl === 'string') transcript = usl;
  else if (usl && typeof usl.text === 'string') transcript = usl.text;
  else if (Array.isArray(usl) && usl[0]?.text) transcript = usl[0].text;

  if (!transcript) return { ok: false, reason: 'no USLT in MP3' };

  const meta = await getPodcastMetadata(url);
  const pdf = await generatePodcastPdf(meta, { text: transcript, language: 'en' });
  await writeFile(pdfPath, pdf);
  return {
    ok: true,
    bytes: pdf.length,
    artwork: !!meta.artworkUrl,
    feedImage: !!meta.feedChannelImage,
    transcriptChars: transcript.length,
  };
}

async function regenVideo(pdfPath) {
  const mp4Path = pdfPath.replace(/\.transcript\.pdf$/, '.mp4');
  const vmeta = await readVideoMetadata(mp4Path);
  if (!vmeta?.sourceUrl) return { ok: false, reason: 'no source URL in MP4 metadata' };
  if (!isYouTubeOrVimeoUrl(vmeta.sourceUrl)) {
    return { ok: false, reason: `not YouTube/Vimeo: ${vmeta.sourceUrl}` };
  }

  const ytMeta = await fetchYouTubeMetadata(vmeta.sourceUrl);
  if (!ytMeta) return { ok: false, reason: 'yt-dlp returned null (private/removed?)' };

  let rawTranscript;
  try {
    const vtt = await extractVttFromMp4(mp4Path);
    rawTranscript = vttToPlainText(vtt);
  } catch (e) {
    return { ok: false, reason: `vtt extract failed: ${e.message}` };
  }
  if (!rawTranscript) return { ok: false, reason: 'empty VTT' };

  // VTT is raw cue text. Re-clean through Gemma so the regenerated PDF reads
  // like the original (paragraphs, proper-noun fixes from title hint).
  let formatted = rawTranscript;
  try {
    formatted = await formatTranscriptWithLLM(rawTranscript, {
      episodeTitle: vmeta.title || ytMeta.title || undefined,
    });
  } catch (e) {
    console.warn(`  format failed, using raw VTT text: ${e.message}`);
  }

  const pdf = await generateVideoPdf({
    title: vmeta.title || ytMeta.title || 'Video',
    sourceUrl: vmeta.sourceUrl,
    date: ytMeta.uploadDate || vmeta.bookmarkedAt,
    uploadDate: ytMeta.uploadDate,
    summary: vmeta.summary,
    tags: vmeta.tags,
    author: ytMeta.channel || vmeta.author,
    publication: vmeta.publication || ytMeta.channel,
    channel: ytMeta.channel,
    channelUrl: ytMeta.channelUrl,
    description: ytMeta.description,
    thumbnail: ytMeta.thumbnail,
    transcriptText: formatted,
  });
  await writeFile(pdfPath, pdf);
  return {
    ok: true,
    bytes: pdf.length,
    channel: ytMeta.channel,
    thumbnail: !!ytMeta.thumbnail,
    transcriptChars: formatted.length,
  };
}

async function main() {
  console.log(`Regenerating top ${N} podcasts + top ${N} YouTube videos...`);
  console.log('---');

  const podcasts = await findLatest('podcasts', (n) => n.endsWith('.pdf'), N);
  console.log(`PODCASTS (${podcasts.length}):`);
  for (const p of podcasts) {
    process.stdout.write(`  ${path.basename(p)} ... `);
    try {
      const r = await regenPodcast(p);
      if (r.ok) console.log(`OK  ${(r.bytes/1024).toFixed(0)}KB  artwork=${r.artwork}  feedImage=${r.feedImage}  transcript=${r.transcriptChars}c`);
      else console.log(`SKIP (${r.reason})`);
    } catch (e) {
      console.log(`ERROR ${e.message}`);
    }
  }

  console.log('---');
  const videos = await findLatest('videos', (n) => n.endsWith('.transcript.pdf'), N * 3); // pull more, will filter
  console.log(`VIDEOS (scanning up to ${videos.length} candidates, formatting up to ${N})...`);
  let done = 0;
  for (const v of videos) {
    if (done >= N) break;
    process.stdout.write(`  ${path.basename(v)} ... `);
    try {
      const r = await regenVideo(v);
      if (r.ok) {
        console.log(`OK  ${(r.bytes/1024).toFixed(0)}KB  channel="${r.channel}"  thumb=${r.thumbnail}  transcript=${r.transcriptChars}c`);
        done++;
      } else {
        console.log(`SKIP (${r.reason})`);
      }
    } catch (e) {
      console.log(`ERROR ${e.message}`);
    }
  }
  console.log(`---\nDone. ${done} videos regenerated.`);
}

main().catch(err => { console.error(err); process.exit(1); });
