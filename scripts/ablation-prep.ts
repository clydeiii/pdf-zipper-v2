/**
 * Ablation test preparation
 * - Fetches podcast metadata from iTunes API
 * - Downloads MP3
 * - Extracts audio from MP4 (via docker exec on the running container)
 * - Sends both to Whisper ASR
 * - Saves raw transcripts + show notes as test inputs
 *
 * Idempotent: skips work if outputs already exist.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { Agent } from 'undici';
import { getPodcastMetadata } from '../src/podcasts/apple.js';
import { transcribeAudio } from '../src/podcasts/transcriber.js';

const ABLATION_DIR = '/home/clyde/pdf-zipper-v2/data/ablation';
const INPUTS_DIR = path.join(ABLATION_DIR, 'inputs');

const PODCAST_URL =
  'https://podcasts.apple.com/us/podcast/80-000-hours-podcast/id1245002988?i=1000759061525';
const MP4_PATH =
  '/home/clyde/pdf-zipper-v2/data/media/2026-W14/videos/stop-using-claude-code-in-terminal-its-holding-you-back.mp4';

// Extended timeouts for large file downloads
const dlAgent = new Agent({
  headersTimeout: 30 * 60 * 1000,
  bodyTimeout: 30 * 60 * 1000,
  connectTimeout: 60 * 1000,
});

async function main() {
  await mkdir(INPUTS_DIR, { recursive: true });

  const metaPath = path.join(INPUTS_DIR, 'podcast-metadata.json');
  const mp3Path = path.join(INPUTS_DIR, 'podcast.mp3');
  const podcastTxt = path.join(INPUTS_DIR, 'podcast.transcript.txt');
  const videoWav = path.join(INPUTS_DIR, 'video.wav');
  const videoTxt = path.join(INPUTS_DIR, 'video.transcript.txt');

  // ---- 1. Fetch podcast metadata ----
  let metadata: Awaited<ReturnType<typeof getPodcastMetadata>>;
  if (fs.existsSync(metaPath)) {
    console.log('[skip] podcast metadata already fetched');
    metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } else {
    console.log('[fetch] iTunes metadata...');
    metadata = await getPodcastMetadata(PODCAST_URL);
    await writeFile(metaPath, JSON.stringify(metadata, null, 2));
    console.log(`  -> ${metadata.episodeTitle}`);
    console.log(`  -> ${metadata.showNotes?.links?.length ?? 0} show-notes links`);
  }

  // ---- 2. Download podcast MP3 ----
  if (fs.existsSync(mp3Path)) {
    console.log('[skip] mp3 already downloaded');
  } else {
    console.log(`[download] ${metadata.audioUrl}`);
    const res = await fetch(metadata.audioUrl, {
      // @ts-expect-error undici dispatcher
      dispatcher: dlAgent,
    });
    if (!res.ok) throw new Error(`MP3 download: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(mp3Path, buf);
    console.log(`  -> ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  }

  // ---- 3. Extract audio from MP4 (via docker exec) ----
  if (fs.existsSync(videoWav)) {
    console.log('[skip] video audio already extracted');
  } else {
    console.log('[extract] audio from mp4 via docker ffmpeg...');
    const containerMp4 = '/data/media/2026-W14/videos/stop-using-claude-code-in-terminal-its-holding-you-back.mp4';
    const containerWav = '/tmp/ablation-video.wav';
    execSync(
      `docker exec pdfzipper-v2 ffmpeg -y -i "${containerMp4}" -vn -ac 1 -ar 16000 "${containerWav}"`,
      { stdio: 'inherit' }
    );
    execSync(`docker cp pdfzipper-v2:${containerWav} "${videoWav}"`);
    execSync(`docker exec pdfzipper-v2 rm -f "${containerWav}"`);
    const stat = fs.statSync(videoWav);
    console.log(`  -> ${(stat.size / 1024 / 1024).toFixed(1)} MB wav`);
  }

  // ---- 4. Transcribe podcast ----
  if (fs.existsSync(podcastTxt)) {
    console.log('[skip] podcast transcript exists');
  } else {
    console.log('[whisper] transcribing podcast (this may take ~25 min)...');
    const t0 = Date.now();
    const result = await transcribeAudio(mp3Path);
    console.log(`  -> ${result.text.length} chars in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    await writeFile(podcastTxt, result.text);
  }

  // ---- 5. Transcribe video ----
  if (fs.existsSync(videoTxt)) {
    console.log('[skip] video transcript exists');
  } else {
    console.log('[whisper] transcribing video...');
    const t0 = Date.now();
    const result = await transcribeAudio(videoWav);
    console.log(`  -> ${result.text.length} chars in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    await writeFile(videoTxt, result.text);
  }

  console.log('\n[done] inputs ready in', INPUTS_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
