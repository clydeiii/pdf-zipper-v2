import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { analyzePdfContent } from '../dist/quality/pdf-content.js';

/**
 * Helper: create a PDF with given text content
 */
async function createPdfWithText(text, { pageCount = 1 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const chunkSize = Math.ceil(text.length / pageCount);
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792]);
    const chunk = text.slice(i * chunkSize, (i + 1) * chunkSize);
    page.drawText(chunk.slice(0, 2000), { // pdf-lib limit per drawText
      x: 50, y: 700, size: 10, font, maxWidth: 500,
    });
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/**
 * Helper: incompressible pseudo-random bytes (xorshift32). A periodic
 * pattern deflates to ~nothing inside the PDF, so size-inflation attachments
 * must be genuinely random-looking to push files past LARGE_PDF_THRESHOLD.
 */
function pseudoRandomNoise(length) {
  const noise = Buffer.alloc(length);
  let x = 123456789;
  for (let i = 0; i < length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x |= 0;
    noise[i] = x & 0xff;
  }
  return noise;
}

/**
 * Helper: generate filler text of a given length
 */
function filler(length) {
  const base = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
  return base.repeat(Math.ceil(length / base.length)).slice(0, length);
}

// --- Passing cases ---

test('analyzePdfContent passes normal article with sufficient text', async () => {
  const text = filler(2000);
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true);
  assert.ok(result.charCount > 500);
});

test('analyzePdfContent passes image-heavy article with >5000 chars (ratio bypass)', async () => {
  const text = filler(6000);
  const pdf = await createPdfWithText(text, { pageCount: 3 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, 'Should pass via SUFFICIENT_CHARS_BYPASS_RATIO');
});

// --- Failing cases ---

test('analyzePdfContent fails on very short content', async () => {
  const text = 'Short page.';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('characters'));
});

test('analyzePdfContent detects error page patterns', async () => {
  const text = 'Oops! The page you are looking for could not be found. Error 404.';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('rror page') || result.reason?.includes('404'));
});

test('analyzePdfContent detects firewall/WAF blocks', async () => {
  const text = 'Attention Required! | Cloudflare. Checking your browser before accessing the site.';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Firewall') || result.reason?.includes('WAF'));
});

test('analyzePdfContent detects stripped Reuters page (footer-only)', async () => {
  // Reuters silently serves the footer/nav skeleton when bot-throttled.
  // Char count is short and the only "real" sentence is the footer phrase.
  const text = 'Latest Browse Media About Reuters. Reuters, the news and media division of Thomson Reuters, is the world\'s largest multimedia news provider. LSEG Products. Workspace. Data Catalogue.';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Stripped page'));
});

test('analyzePdfContent ignores Reuters footer phrase in long article', async () => {
  // A long article that quotes the Reuters boilerplate (e.g. a meta-piece
  // about Reuters itself) should NOT be flagged.
  const text = filler(5000) + ' The brand line goes: "Reuters, the news and media division of Thomson Reuters."';
  const pdf = await createPdfWithText(text, { pageCount: 2 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, 'Reuters phrase in long content should not trigger');
});

test('analyzePdfContent detects hard paywall patterns', async () => {
  // Hard paywall should trigger regardless of text length.
  // Put the paywall text at the START so it fits within drawText limits.
  const text = 'Subscribe to continue reading this article with a WSJ subscription. ' + filler(6000);
  const pdf = await createPdfWithText(text, { pageCount: 2 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Paywall'));
});

test('analyzePdfContent detects "Subscribe to <site> to continue reading" (The Verge)', async () => {
  // Single-page preview with substantial nav/sidebar text plus Verge's paywall phrase.
  const text = 'Subscribe to The Verge to continue reading. ' + filler(2000);
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Paywall'));
});

test('analyzePdfContent detects soft paywall on short content', async () => {
  const text = 'This is a premium article. Unlock this article for just $4.99 per month to read more.';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Paywall'));
});

test('analyzePdfContent ignores soft paywall patterns in long content', async () => {
  // A long article that mentions pricing shouldn't be flagged
  const text = filler(6000) + ' Our service starts at $9.99 per month for premium features.';
  const pdf = await createPdfWithText(text, { pageCount: 2 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, 'Soft paywall in long content should not trigger');
});

test('analyzePdfContent ignores error page patterns in long content', async () => {
  // A tweet mentioning "404 error" shouldn't be flagged
  const text = filler(5000) + ' The server returned a 404 error when I tried to access the API.';
  const pdf = await createPdfWithText(text, { pageCount: 2 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, '404 mention in long content should not trigger');
});

test('analyzePdfContent detects reading-time mismatch (Economist-style fade)', async () => {
  // Lede + "X min read" badge but no body — silent paywall truncation.
  const text = 'Business | Bartleby How should bosses talk about AI? Employees are being asked to embrace a technology that causes fear. If you are a bank boss and in the headlines, you are either Jamie Dimon or you have screwed up. Bill Winters made waves recently when he talked about a planned 15% reduction in back-office jobs. May 28th 2026 | 4 min read advertisement';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Reading-time mismatch'), `expected mismatch reason, got: ${result.reason}`);
});

test('analyzePdfContent ignores "1 min read" short blurbs', async () => {
  // 1-minute blurbs can legitimately be short — don't flag.
  const text = filler(600) + ' 1 min read';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, '1 min read should not trigger mismatch');
});

test('analyzePdfContent passes when body matches claimed reading time', async () => {
  // 4 min × 500 chars/min = 2000 char floor; 2500 chars passes.
  const text = filler(2500) + ' 4 min read';
  const pdf = await createPdfWithText(text, { pageCount: 2 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, `should pass with sufficient body; got: ${result.reason}`);
});

test('analyzePdfContent ignores early sidebar "About the Author" (apollo.com layout)', async () => {
  // Apollo's Daily Spark puts the author bio in a sidebar that extracts at
  // char ~130, right after the headline — on a COMPLETE article. Markers in
  // the first 300 chars are layout, not end-of-truncated-body.
  const header = 'Home The Daily Spark Where Is the AI Jobs Crisis? MACRO INDICATORS June 09, 2026 Where Is the AI Jobs Crisis? About the Author Torsten Slok, Partner, Chief Economist. ';
  const text = header + filler(3000);
  const pdf = await createPdfWithText(text, { pageCount: 2 });
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, `sidebar author bio should not trigger; got: ${result.reason}`);
});

test('analyzePdfContent still detects stealth paywall via post-lede end-of-article marker', async () => {
  // Lede + 1 paragraph, then straight into end-of-page boilerplate — the
  // Fortune-style stealth truncation the marker check was built for.
  const text = filler(900) + ' About the Author. Jane Doe covers AI. Most Popular. Latest in Tech. ' + filler(400);
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Truncated body'), `expected truncation reason, got: ${result.reason}`);
});

test('analyzePdfContent passes image-heavy direct X post capture (low density)', async () => {
  // Direct x.com status capture: short text + huge embedded screenshots.
  // Large size + low chars/KB is normal for a complete tweet capture.
  const text = 'Garry Tan @garrytan Just trying to work on fixing GStack and running into this *long sigh* 4:04 AM Jun 10, 2026 34.2K Views Relevant people What’s happening Post your reply ' + filler(550);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(text.slice(i * 400, (i + 1) * 400), { x: 50, y: 700, size: 10, font, maxWidth: 500 });
  }
  // Inflate file size past the 500KB large-PDF threshold (stand-in for images)
  await doc.attach(pseudoRandomNoise(700 * 1024), 'image-noise.bin', { mimeType: 'application/octet-stream' });
  const bytes = await doc.save();
  const result = await analyzePdfContent(Buffer.from(bytes));
  assert.equal(result.passed, true, `X post chrome should exempt size/density checks; got: ${result.reason}`);
});

test('analyzePdfContent passes short direct X tweet capture in strict mode (logged-out chrome)', async () => {
  // Real case (job 14853): tweet linking an X Article got re-captured from
  // x.com in strict mode via the Nitter article-stub fallback. Complete
  // capture, 454 chars — must not fail the 500-char article minimum.
  const text = 'unprompted @unpromptednews OpenAI threatens Anthropic with AI price war. Is it shooting itself in the foot? ChatGPT maker @OpenAI was once the undisputed leader of the AI industry, but many now consider that its rival @AnthropicAI has removed it from its throne. As the two companies race towards IPOs and a... 4:49 AM Jun 11, 2026 23.7K Views Article 4 1 Don\'t miss what\'s happening People on X are the first to know. Log in Sign up Post';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, true, `complete tweet capture should pass; got: ${result.reason}`);
});

test('analyzePdfContent still fails chrome-only X shell (status did not render)', async () => {
  // Only the logged-out chrome, no status body — below the social floor.
  const text = 'Don\'t miss what\'s happening People on X are the first to know. Log in Sign up';
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.ok(result.reason?.includes('Social post'), `expected social-post floor reason, got: ${result.reason}`);
});

/**
 * Helper: multi-page PDF with explicit per-page text, size-inflated past the
 * 500KB large-PDF threshold (stand-in for heavy raster content).
 */
async function createLargePdfWithPages(pageTexts) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const pageText of pageTexts) {
    const page = doc.addPage([612, 792]);
    if (pageText) {
      page.drawText(pageText.slice(0, 2000), { x: 50, y: 700, size: 10, font, maxWidth: 500 });
    }
  }
  await doc.attach(pseudoRandomNoise(700 * 1024), 'image-noise.bin', { mimeType: 'application/octet-stream' });
  return Buffer.from(await doc.save());
}

test('classifies blur-obfuscated paywall as paywall (every.to shape)', async () => {
  // Real case (job 21206, every.to/vibe-check/opus-5): textful lede page,
  // blurred raster body pages with zero extractable text, then textful
  // bio/footer page. Must fail with "Paywall detected" so the failure
  // classifies as paywall (archive candidate) instead of a suspected
  // quality false-negative.
  const pdf = await createLargePdfWithPages([
    'Skip to content. ' + filler(320), // lede
    '',                                // blurred body
    '',                                // blurred body
    filler(600),                       // author bios + footer
    'Pricing FAQ Terms Site map',      // footer overflow
  ]);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.match(result.reason || '', /Paywall detected/, `expected paywall reason, got: ${result.reason}`);
});

test('plain large-PDF truncation keeps the truncated-article reason', async () => {
  // Text spread across pages (SPA shell / hero-image truncation) — no
  // textless run sandwiched between textful pages, so it must keep the
  // "Large PDF" wording (quality_false_negative_suspected downstream).
  const pdf = await createLargePdfWithPages([filler(400), filler(400), filler(200)]);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.match(result.reason || '', /Large PDF/, `expected truncation reason, got: ${result.reason}`);
});

test('classifies body-stripped page with engagement chrome as paywall (Business Insider shape)', async () => {
  // Real case (job 23416, businessinsider.com premium "EXCLUSIVE"): 611KB PDF,
  // 545 chars — headline, byline, hero caption, comment CTA and "Read next"
  // widget all render; every body paragraph is stripped client-side.
  const pdf = await createLargePdfWithPages([
    'Read in app Start the conversation Read next EXCLUSIVE Google is in talks ' +
      'for a $1.5 billion-plus deal with AI coding agent startup Mechanize ' +
      'By Katie Roof, Ben Bergman, Charles Rollet, and Hugh Langley Aug 5, 2026, 8:14 AM ET ' +
      'Business Insider tells the innovative stories you want to know ' +
      'Alphabet CEO Sundar Pichai. Bloomberg/Getty Images',
    'Ben Bergman Business Insider tells the innovative stories you want to know ' + filler(150),
  ]);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.match(result.reason || '', /Paywall detected.*chrome/, `expected paywall-strip reason, got: ${result.reason}`);
});

test('single engagement phrase in prose keeps the truncated-article reason', async () => {
  // One marker alone ("read next" can appear in article copy) must not
  // reclassify a genuine truncation as a paywall.
  const pdf = await createLargePdfWithPages([
    filler(300) + ' Here is what to read next this weekend. ',
    filler(300),
  ]);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.match(result.reason || '', /Large PDF/, `expected truncation reason, got: ${result.reason}`);
});

test('trailing blank overflow pages do not trigger the blur-paywall reason', async () => {
  // Blank pages at the END (print overflow) are not a blurred body.
  const pdf = await createLargePdfWithPages([filler(500), filler(300), '', '']);
  const result = await analyzePdfContent(pdf);
  assert.equal(result.passed, false);
  assert.match(result.reason || '', /Large PDF/, `expected truncation reason, got: ${result.reason}`);
});

test('domain-root landing page is exempt from the large-PDF truncation check', async () => {
  // ai-reports.org shape: 2.3MB PDF (hero art), ~855 chars of landing copy.
  const pdf = await createLargePdfWithPages([filler(500), filler(355)]);
  const result = await analyzePdfContent(pdf, { sourceUrl: 'https://www.ai-reports.org/' });
  assert.equal(result.passed, true, `homepage capture should pass; got: ${result.reason}`);
});

test('deep article path keeps the large-PDF truncation check (Axios SPA shell)', async () => {
  const pdf = await createLargePdfWithPages([filler(500), filler(355)]);
  const result = await analyzePdfContent(pdf, {
    sourceUrl: 'https://www.axios.com/2026/07/29/anthropic-claude-open-models-ban-china',
  });
  assert.equal(result.passed, false);
  assert.match(result.reason || '', /Large PDF/, `expected truncation reason, got: ${result.reason}`);
});

test('near-blank homepage shell still fails the minimum-chars floor', async () => {
  const pdf = await createLargePdfWithPages([filler(200)]);
  const result = await analyzePdfContent(pdf, { sourceUrl: 'https://example.com/' });
  assert.equal(result.passed, false, 'homepage exemption must not admit blank shells');
});

// --- Extracted text ---

test('analyzePdfContent returns extracted text for downstream use', async () => {
  const text = filler(1000);
  const pdf = await createPdfWithText(text);
  const result = await analyzePdfContent(pdf);
  assert.ok(result.extractedText);
  assert.ok(result.extractedText.length > 0);
});

// --- Corrupted/empty PDF ---

test('analyzePdfContent passes gracefully on corrupted PDF', async () => {
  const garbage = Buffer.from('not a pdf at all');
  const result = await analyzePdfContent(garbage);
  // Should not throw, should pass (fail-open for unparseable PDFs)
  assert.equal(result.passed, true);
  assert.ok(result.reason?.includes('parsing failed'));
});

test('flags Condé Nast "You Might Also Like" stealth paywall (Wired truncation)', async () => {
  // Headline + lede + 1 paragraph, then the related-content widget appears early.
  const text =
    "'Dangerous' AI Models Are Coming No Matter What. " +
    "The US government crackdown on Anthropic hides a glaring truth. " +
    "LATE LAST WEEK, Anthropic took its new Claude models offline following a " +
    "United States government export-control directive barring any foreign national " +
    "from using the services. The company has been in talks with the White House " +
    "since Friday but has yet to secure an agreement to reinstate the offerings. " +
    filler(250) +  // push the marker past the 300-char floor, like the real capture (char ~907)
    " You Might Also Like " +
    "In your inbox the week's biggest tech news. " + filler(800);
  const pdf = await createPdfWithText(text);
  const r = await analyzePdfContent(pdf);
  assert.equal(r.passed, false);
  assert.match(r.reason || '', /paywall/i);
});

test('does NOT flag a full article that ends with "You Might Also Like" past the body', async () => {
  // A complete long article: the related-content header lands well past the
  // truncation window, so it must NOT be treated as a paywall.
  const text = filler(6000) + ' You Might Also Like ' + filler(500);
  const pdf = await createPdfWithText(text, { pageCount: 4 });
  const r = await analyzePdfContent(pdf);
  assert.equal(r.passed, true);
});

test('flags archived Bloomberg paywall fade (lede duplicated + Terminal chrome)', async () => {
  // Real extracted text from an archive.today snapshot that archived Bloomberg's
  // paywall fence, not the article: headline + lede rendered twice (visible +
  // fade layer), "Subscribe", then footer. The archive-fallback path runs this
  // same check on the rendered snapshot — it must fail so the job is marked
  // failed instead of saving a paywall capture as success.
  const lede =
    'Asian technology stocks slumped after a report that Nvidia Corp.’s ' +
    'next-generation AI server rack system has been delayed by more than a year ' +
    'due to manufacturing difficulties. Research firm SemiAnalysis said in an X ' +
    'post that Nvidia’s Kyber NVL144 hit setbacks in the construction of ' +
    'printed circuit boards for the platform. Nvidia did not respond to a ' +
    'request for comment outside of regular office hours. ';
  const text =
    'Markets Nvidia AI Server Delay Report Sends Asian Tech Stocks Sliding ' +
    'By Abhishek Vishnoi and Sangmi Cha July 6, 2026 at 5:52 AM UTC ' +
    'Save Skip to content The Company & its Products Bloomberg Terminal Demo Request ' +
    'Bloomberg Anywhere Login Customer Support Translate ' +
    lede + lede +
    'Subscribe Home BTV+ Market Data Opinion Audio Originals Magazine Events News ' +
    'Terms of Service Trademarks Privacy Policy Careers Advertise Ad Choices Help ' +
    '©2026 Bloomberg L.P. All Rights Reserved.';
  const pdf = await createPdfWithText(text, { pageCount: 2 });
  const r = await analyzePdfContent(pdf);
  assert.equal(r.passed, false);
  assert.match(r.reason || '', /paywall/i);
});

test('prose "the latest in a string of" does NOT trip the Latest-in widget marker', async () => {
  // Real CNBC copy that false-positived when the marker was case-insensitive.
  const text =
    'Nvidia Kyber rack system delayed. ' + filler(600) +
    ' has been delayed by more than 12 months to 2028, according to research firm SemiAnalysis, ' +
    'the latest in a string of reported setbacks raising questions about the AI giant’s product roadmap. ' +
    filler(3000);
  const pdf = await createPdfWithText(text, { pageCount: 3 });
  const r = await analyzePdfContent(pdf);
  assert.equal(r.passed, true);
});
