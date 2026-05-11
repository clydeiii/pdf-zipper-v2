// Smoke test: fetch real podcast metadata + generate a PDF with stub transcript.
// Verifies that artwork is embedded in the header.
import { getPodcastMetadata } from '/app/dist/podcasts/apple.js';
import { generateTranscriptPdf } from '/app/dist/podcasts/pdf-generator.js';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'https://podcasts.apple.com/us/podcast/the-ai-daily-brief-artificial-intelligence/id1680633614?i=1000746731002';

const metadata = await getPodcastMetadata(url);
console.log('artworkUrl:', metadata.artworkUrl);
console.log('feedChannelImage:', metadata.feedChannelImage);
console.log('podcastName:', metadata.podcastName);
console.log('episodeTitle:', metadata.episodeTitle);

const transcript = {
  text: 'This is a stub transcript used only to render the PDF header.\n\nThe artwork above this paragraph should be the podcast or episode cover image.',
  language: 'en',
};

const pdf = await generateTranscriptPdf(metadata, transcript);
const outPath = '/data/debug/artwork-smoke-test.pdf';
writeFileSync(outPath, pdf);
console.log(`Wrote ${pdf.length} bytes to ${outPath}`);
