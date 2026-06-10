import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpellingCorrections } from '../dist/podcasts/transcript-formatter.js';

test('extracts all-caps acronyms from description text', () => {
  const out = buildSpellingCorrections({
    extraHintText: 'In this video we explore JEPA and VJEPA2, trained on video data.',
  });
  assert.ok(out.includes('"JEPA"'), `expected JEPA hint, got: ${out}`);
  assert.ok(out.includes('"VJEPA2"'), `expected VJEPA2 hint, got: ${out}`);
});

test('skips common all-caps noise words', () => {
  const out = buildSpellingCorrections({
    extraHintText: 'GET the FULL guide NOW — FREE for ALL users WITH a PDF.',
  });
  assert.equal(out, '');
});

test('episode title hint always included alongside description tokens', () => {
  const out = buildSpellingCorrections({
    episodeTitle: "Yann LeCun's $1B Bet Against LLMs",
    extraHintText: 'Discussion of JEPA architectures.',
  });
  assert.ok(out.includes('episode title'));
  assert.ok(out.includes('"JEPA"'));
});

test('dedupes case-insensitively and caps hint count', () => {
  const many = Array.from({ length: 50 }, (_, i) => `ACRO${i}`).join(' ');
  const out = buildSpellingCorrections({ extraHintText: `JEPA jepA JEPA ${many}` });
  const count = (out.match(/"/g) || []).length / 2;
  assert.ok(count <= 20, `expected <=20 hints, got ${count}`);
  assert.equal((out.match(/"JEPA"/gi) || []).length, 1);
});

test('still mines show-notes links (podcast path unchanged)', () => {
  const out = buildSpellingCorrections({
    showNotes: { links: [{ text: 'ChatGPT vs OpenClaw deep dive', url: 'https://x.com' }] },
  });
  assert.ok(out.toLowerCase().includes('chatgpt'));
});

test('camelCase brand extraction still works from description', () => {
  const out = buildSpellingCorrections({ extraHintText: 'Sponsored by DeepMind and LangChain.' });
  assert.ok(out.includes('"DeepMind"'));
  assert.ok(out.includes('"LangChain"'));
});
