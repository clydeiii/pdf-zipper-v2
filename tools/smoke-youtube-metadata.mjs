// Smoke test: fetch yt-dlp metadata for a YouTube URL and render a transcript PDF
// without doing the actual transcription step.
import { fetchYouTubeMetadata } from '/app/dist/media/youtube-metadata.js';
import { generateTranscriptPdf } from '/app/dist/metadata/transcript-pdf.js';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const meta = await fetchYouTubeMetadata(url);
if (!meta) {
  console.error('yt-dlp returned null');
  process.exit(1);
}

console.log('channel:', meta.channel);
console.log('uploadDate:', meta.uploadDate);
console.log('title:', meta.title);
console.log('descriptionLength:', meta.description?.length);
console.log('descriptionPreview:', (meta.description || '').slice(0, 160));
console.log('durationSeconds:', meta.durationSeconds);
console.log('viewCount:', meta.viewCount);
console.log('thumbnail:', meta.thumbnail);

const pdf = await generateTranscriptPdf({
  title: meta.title || 'Test Video',
  sourceUrl: url,
  date: meta.uploadDate,
  uploadDate: meta.uploadDate,
  channel: meta.channel,
  channelUrl: meta.channelUrl,
  description: meta.description,
  thumbnail: meta.thumbnail,
  summary: 'AI-extracted summary would normally appear here.',
  tags: ['music', 'pop'],
  transcriptText: 'This is a stub transcript used only to render the PDF header layout.',
});

const out = '/data/debug/yt-metadata-smoke-test.pdf';
writeFileSync(out, pdf);
console.log(`Wrote ${pdf.length} bytes to ${out}`);
