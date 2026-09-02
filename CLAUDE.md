# CLAUDE.md - Project Context for AI Assistants

## Project Overview

pdf-zipper-v2 is an async URL-to-PDF conversion system:
- **BullMQ + Redis** job queue for URLs from RSS feeds (Matter, Karakeep)
- **Playwright** + stealth plugin for PDF generation
- **Ollama** (Gemma 4) for vision-based quality scoring + AI metadata enrichment
- **Parakeet-TDT** (MLX on mac.mini:9003) for podcast/video transcription — whisper-asr-webservice compatible API
- **Web UI** for browsing, rerun, fix flagging
- **AI self-healing** via headless Claude Code for classification errors
- **Chrome extension** (`chrome-extension/`) for manual capture when paywalled; POSTs to `/api/manual-capture` using CF Access cookie auth

## Key Architecture Invariants

These are non-obvious rules that aren't derivable from a quick code read. Respect them when making changes.

### URL Handling
- **Canonical URL** (`url`): normalized for deduplication (strips `www.`, normalizes protocol)
- **Original URL** (`originalUrl`): preserved for archive.is (archive.is treats `www.` and non-`www` as different)
- Use `originalUrl` for HTTP fetch + external links; use canonical only for dedup keys
- **Never** pass canonical URLs through conversion — sites like `uncoveralpha.com` require `www.`
- **YouTube canonicalization** (`canonicalizeYouTubeUrl` in `src/urls/normalizer.ts`): every spelling of a video (watch/shorts/live/embed/youtu.be, any `is=`/`si=` share token, `t=` timestamps) collapses to `youtube.com/watch?v=<id>` for dedup keys ONLY. The phone share sheet mints a fresh `is=` token per share — before this, sharing the same video twice created two "new" bookmarks and two full downloads.
- **General rel=canonical dedup layer** (`src/urls/canonical-declaration.ts`, inside `dedupCandidates`): for the long tail with no dedicated rule, the page's own `rel=canonical`/`og:url` (and post-redirect URL) become EXTRA dedup-key candidates — so a future unknown share-token scheme still meets the clean spelling at the declared key. DEDUP KEYS ONLY, never storage/filenames (sites mis-declare; a wrong stored URL overwrites the wrong file). Guards: the canonical must retain an identity token of the original (sluggy last path segment or long query value — generic "blog"/"news" segments don't count, protecting query-string-identity sites like qwen.ai); hosts with dedicated handling (YouTube/X/Substack/Apple Podcasts/arxiv) and direct files are ineligible; fetch failure = no candidate = pre-layer behavior. A wrong candidate is benign by design: articles refresh-on-seen instead of skipping, and media skip-gates never consult this layer.
- **X/Twitter share-param stripping** (`stripTwitterShareParams` in `src/urls/normalizer.ts`): the iOS share sheet appends `?s=20`/`t=<token>` that laptop copy-links don't, so the same tweet bookmarked from both devices produced two dedup keys (9,172 historical seen-set entries carried these params; stripped forms seeded 2026-08-31). Host-gated to x.com/twitter.com — `s`/`t` can be meaningful elsewhere. Tweet double-capture was never file-corrupting (status-id filenames overwrite; twitter.db upserts by tweet id) — the fix saves the duplicate capture work and, for video tweets, the duplicate download.
- **Substack candidate-key dedup** (`src/urls/substack-canonical.ts`, used inside `BookmarkDeduplicator`): the same post has three spellings — iOS share sheet (`open.substack.com/pub/<pub>/p/<slug>?r=…`), pub subdomain (`<pub>.substack.com/p/<slug>`), custom domain (`www.dwarkesh.com/p/<slug>`) — and the pub→custom-domain mapping only exists on Substack's side (pub root 301s to it; resolved once per pub, cached in-memory). Substack post URLs therefore expand to a CANDIDATE SET of dedup keys: `isUrlSeen` hits on any, `markUrlSeen` adds all. Custom-domain bookmarks need no Substack detection — their plain normalized key IS the other spellings' resolved candidate. Added 2026-08-30 after the same dwarkesh post was captured twice (iOS then Chrome) within hours. Pre-fix seen-set entries were expanded by the one-time `scripts/seed-substack-dedup-keys.ts`.
- **Substack STORAGE canonicalization** (`canonicalizeSubstackUrl`, applied at the top of conversion `processJob` — covering feed poll, direct API, and both rerun paths — and in the manual-capture route): a deliberate exception to "url stays ORIGINAL". Substack posts are stored (capture target, PDF Subject, filename, Karakeep injection) under `https://<canonical host>/p/<slug>`, rebuilt from host+slug. Custom-domain post URLs (`/p/<slug>` path shape on any host) get share params stripped in place. **The user's personal `r=` reader token (`r=9qonx`) identifies them and must NEVER reach stored metadata** — every spelling Substack's share flows produce carries it (iOS share sheet AND web "copy link"). Rerunning an old `open.substack.com-*` capture migrates it to the canonical filename automatically (oldFilePath cleanup).
- **Re-bookmark = refresh, for articles only** (poll worker, 2026-08-31, user preference): a NEW bookmark of an already-seen URL re-captures instead of skipping — canonical filenames make it an in-place overwrite, not a duplicate. Two hard skips remain: (1) media items (video enclosure/mediaType, Apple Podcasts) — re-downloading was the exact duplicate-work problem the YouTube share-token fix closed; (2) URLs whose first capture source is `'manual'` (`getUrlSource`, which checks all candidate spellings) — an automated re-capture would clobber the Chrome-extension paywall rescue with a paywalled render. Same-GUID re-polls are unaffected (GUID dedup runs first); only genuinely new bookmarks trigger refresh. Logs `rebookmark_refresh`.
- `BookmarkItem.url` / `MediaItem.url` is the ORIGINAL feed URL (it flows into file metadata: PDF Subject, MP4 source_url); `canonicalUrl` is a separate field used only for dedup jobIds. Don't set `url: canonicalUrl` when building items — that strips `www.` from every embedded source URL downstream.

### URL Routing (by type, before queuing)
- **Apple Podcasts** (`podcasts.apple.com`) → `podcastQueue` (iTunes API metadata + audio download + Parakeet transcription)
- **Video** (YouTube/Vimeo) → rejected in direct API; from Karakeep with enclosure → media collection. When Karakeep produces NO video asset within the poller's wait window (24 polls ≈ 2h), the item is **not dropped**: the poll worker points the enclosure at the watch URL with `downloadVia: 'yt-dlp'` and the collector runs our own yt-dlp (`src/media/ytdlp-video.ts` — needs `--js-runtimes node` for YouTube signature solving; anonymous first, `YT_DLP_COOKIES_FILE` retry only on age/bot-gate failures). Added 2026-08-20 after Karakeep's bundled yt-dlp spent days 403-blocked by YouTube, silently dropping every bookmarked video. **The wait window depends on the video being re-polled**: waiting videos are deliberately left GUID-unseen, but the Karakeep parser paginates newest-first and stops at the first seen bookmark — so a burst of newer bookmarks pushed 45 waiting videos off page 1 mid-wait and froze their counters (2026-09-02, a 385-bookmark evening). The poll worker now looks each pending GUID (`feed:video-retries:<source>` keys) up directly by id (`fetchKarakeepBookmarkItem`) when the feed didn't surface it — one cheap request per waiting video, independent of feed position. Deep pagination was tried first and rejected: 41 of the 45 stranded GUIDs were older than the top 1,000 bookmarks, so it cost 20 pages per poll and still couldn't reach them. A 404 (deleted, or swept by Karakeep's 14-day cleaner) drops the entry (`video_wait_abandoned`); a transient error leaves it pending.
- **PDF URLs** (`.pdf`, arxiv `/abs/` `/html/` `/pdf/`) → direct fetch pass-through (skip Playwright). arxiv `/abs/` is rewritten to `/pdf/` first
- **Karakeep PDF asset** (`content.type: "asset"`, `assetType: "pdf"`) → media collection, download via `/api/assets/{id}`. Filename lives in `bookmark.assets[].fileName`, not `content.fileName`
- **Twitter/X** → rewritten to local Nitter (`NITTER_HOST`). Exception: X Articles go direct (Nitter can't render)
- **ChatGPT share links** (`chatgpt.com/share/<id>`) → scroll-harvest converter (`src/converters/chatgpt-share.ts`). The share page is a virtualized list (only ~6 messages hydrated at a time; the rest are empty placeholders that un-hydrate on scroll-away), so ANY direct print — Playwright or the Chrome extension — captures one viewport + blank pages. The converter slow-scrolls to hydrate every message, harvests markdown (KaTeX → original LaTeX via the embedded `<annotation>`), and renders its own clean KaTeX document to PDF. Falls back to regular conversion on harvest failure.
- Everything else → `conversionQueue` (Playwright)

Rerun endpoints must apply the same routing — both `/weeks/:weekId/rerun` and `/rerun-selected` check `isApplePodcastsUrl()` before queuing.

### Manual Capture vs Karakeep Collision Protection
Manual captures (Chrome extension → `/api/manual-capture`) must never be overwritten by a later Karakeep bookmark of the same URL. The manual-capture route therefore: (1) marks the URL seen in `BookmarkDeduplicator` (source `'manual'`) so the feed poll skips it, (2) removes matching failed AND waiting/delayed conversion jobs, (3) injects the URL into Karakeep via `createKarakeepBookmark` so the Karakeep plugin shows "already saved", (4) deletes stale same-filename copies from other ISO-week bins (re-capture freshness — the new file's mtime makes it "new" for Select New). Don't remove any of these when refactoring the route.

### App-Shell Scroll Panes (`src/converters/pdf.ts`, un-pin phase)
`page.pdf()` paginates off the **document** height, so any layout that scrolls the article inside a fixed-height box prints one clipped page no matter how long the article is. `innerText` still reads the whole thing, which is why these look fine to text-based checks and broken in the PDF. Three variants are handled, all self-gating (they only fire when content actually overflows a pinned box, so normal articles pay nothing):
1. **html/body/shallow shells** pinned to `100vh` (Politico's Nuxt `div.h-screen`).
2. **Nested panes at any depth** — an `overflow-y:auto` div ≤ viewport-tall holding ≥30% of the page text and ≥1000 chars. qwen.ai nests a 27000px article in a 900px pane three levels down (`body > #ice-container > div > #…LAYOUT_CONTENT`), and every ancestor is `height:900px; overflow:hidden` — so releasing the pane alone does nothing. **Release the whole ancestor chain up to `<html>`, not just the pane.** The 30% text-share gate is what keeps nav rails and comment sidebars clipped.
3. **Capped `pre`/`code`/`table`** with their own scrollbar (qwen.ai caps each listing at 500px, hiding ~two-thirds of the long ones). Bounded at 20000px so a runaway embedded log can't expand into hundreds of pages.

Verify changes here against a spread of live URLs, not just the target site — the phase runs on every capture. A before/after harness comparing page count + extracted chars is the cheap way to prove a change is surgical.

### Paywall/Bot-Wall Rescue Tiers (order matters)
When a primary capture fails on an access wall, two rescue tiers run in order:
1. **smry.ai reader view** (`src/converters/smry-rescue.ts`, needs `SMRY_API_KEY` — paid Pro, 500 fresh extractions/day, repeat URLs are free cache hits). One authenticated API call; rescues bot-walled free content (Reuters, Fortune), metered paywalls, gift links, and sites that connection-reset our IP (its candidate set adds `timeout`/`navigation_error` on top of the archive tier's). Renders a clean reader PDF (`ViaSmry` Info Dict field, creator `pdf-zipper-v2-smry`).
2. **archive.today** (`src/converters/archive-fallback.ts`) — only chance for hard paywalls (WSJ/Bloomberg/Economist), but captcha/cookie/429-fragile.

**smry's API quality fields are unreliable — never gate on them.** Validated 2026-08-17: a WSJ lede-only partial (1,933 chars) and The Information's 28KB page-config JSON both returned `truncated: false, qualityStatus: "usable"`. The real gates are ours: `stripExtractionArtifacts` (smry's Axios text arrives laced with Tailwind class soup that otherwise trips the blob gate), `looksLikeMachineBlob`, a **host-aware char floor** (`minCharsForUrl`: 2500 on known hard-paywall hosts — above their observed lede sizes — and 1200 elsewhere, because a complete short Axios piece (1,949 chars) is the same length as a WSJ lede (1,933); ledes are a property of the publisher, not of length), a **Substack paid-preview gate** (the post API's true `wordcount` vs extracted words — a preview ending on a clean sentence passes every text heuristic; confirmed false accept 2026-08-21), and `analyzePdfContent` on the rendered PDF. A rejected rescue costs nothing (falls through); a wrong accept silently archives a partial article as a success.

### Quality Pipeline
Two-layer quality check, both must pass:
1. **Vision score** (`src/quality/scorer.ts`): Ollama sees viewport-only screenshot (~800px). Don't flag "truncated" from viewport alone. Threshold configurable via `QUALITY_THRESHOLD`.
2. **PDF content analysis** (`src/quality/pdf-content.ts`): extracts text, checks char counts, char/KB ratio, error-page patterns, paywall patterns.

Tunable bypasses in pdf-content.ts — don't re-introduce false positives that were explicitly worked around:
- `SUFFICIENT_CHARS_BYPASS_RATIO = 5000` — skip ratio check on image-heavy articles
- `MIN_CHARS_PER_PAGE_BYPASS = 400` — skip ratio check on short announcement pages
- Error-page regex only runs when content < 2000 chars (real 404s don't have long bodies)
- Pass-through PDFs (arxiv, direct .pdf) skip quality checks but **do** run metadata enrichment

### Video Compression (`src/media/video-compress.ts`)
All videos arrive via Karakeep assets, but sources differ wildly: Karakeep's yt-dlp grabs YouTube at 360p/~160-500 kbps, while X/Twitter variants arrive up to 4K (observed 2.7 GB for one 36-min X clip). `maybeCompressVideo` runs in the collection worker BEFORE `enrichVideo` (so metadata/VTT embed into the final file) and re-encodes only when:
1. **Oversize**: shorter frame side > `VIDEO_COMPRESS_MAX_HEIGHT` (default 720; **compose pins 480**) → downscale. Gate is on the SHORT side so portrait phone video isn't crushed.
2. **Fat bitrate**: kbps > max(1200 floor, `VIDEO_COMPRESS_KBPS_PER_MEGAPIXEL` × frame MP). The floor keeps every YouTube grab untouched.
3. **High fps**: fps > `VIDEO_COMPRESS_MAX_FPS` (30) → resample (also applied on top of triggers 1-2). +0.5 tolerance so NTSC 29.97 never fires.

Bitrate gating makes it idempotent (compressed output falls below threshold on re-enrich). Audio/subtitle streams are stream-copied; the re-encode is discarded if not ≥10% smaller. Never throws — any failure keeps the original file.

### Duplicate Embedded Videos (`src/media/video-dedup.ts`)
Bookmarking an original tweet AND a quote-tweet of it delivers the same embedded video twice (different Karakeep assets, near-identical bytes). Before compressing a fresh download, the collection worker probes the whole library: duration ±50ms + aspect ratio ±1% + same has-audio bit, confirmed by an 8x8 perceptual frame hash. A confirmed duplicate is deleted and the new bookmark's URL is appended to the canonical mp4's `also_bookmarked_as` metadata tag (`; `-separated). No state beyond the files themselves — identity is re-derived from probes each time. Dedup is skipped on re-enrich jobs (`existingFilePath` set), which would otherwise match and delete the very file being refreshed. **KB consumers must treat `source_url` + `also_bookmarked_as` as the complete set of tweets referencing a video**; the quote-tweet's own PDF capture carries the quote relationship from the other side. Canonical attribution follows bookmark order (first bookmark wins the filename), so a QT bookmarked before the original keeps the QT's account in the filename — the tags, not the filename, are authoritative.

### Substack AI Detection (`src/substack/pangram.ts`)
Substack ships reader-facing AI detection (Pangram, live 2026-07-21). The score is **not** in the page — the server HTML carries only the `enable_pangram_ai_detection` flag; the verdict is fetched on demand. So this is a plain-HTTP harvest (no Playwright), two unauthenticated GETs: `/api/v1/posts/<slug>` → post id, then `/api/v1/pangram/detection/p-<id>` → verdict. Both work on `*.substack.com` **and** Substack-hosted custom domains (`newsletter.semianalysis.com`); `open.substack.com/pub/<pub>/p/<slug>` share links must be resolved to the publication first.

Result lands in Info Dict as `AIDetection*` + `AIDisclosure` (writer's "How I make this" statement) via `extraInfoDictFields`. Surfaced in the web UI as a colour-coded badge on the file row, filterable with `ai:>50` / `ai:scored` / `ai:any`.

**The badge and filter key off AI _involvement_ (`100 − human`, i.e. fully-AI + AI-assisted), not `AIDetectionAI`.** A real capture reads `ai=0%, assisted=51%, human=49%` — Pangram calls it "Partially AI-assisted text", but keying off the fully-AI figure badges it "AI 0%" and hides it from every threshold filter. `aiInvolvementPercent` in `src/utils/percent.ts` owns that definition; the breakdown stays in the tooltip. Non-fatal and additive — any failure returns null and the capture proceeds. Fetch at **capture time**: the verdict is computed against the post as it stands, so a later edit scores differently. Unhappy answers (`Subscription required`, `Not eligible`, writer-`disabled`) are recorded too — "we checked and got no score" is a different fact from "we never checked", and absence of the field must never be read as "human-written".

### Patreon Video Capture (`src/media/patreon.ts`)
The only video source whose bytes don't come from Karakeep. Karakeep has no Patreon session, so member-only posts arrive as plain `link` bookmarks — no `videoAssetId`, no video asset — and would otherwise be PDF-only. There's also no mp4 to scrape: the video is Mux-hosted HLS (`rendition.m3u8`) behind short-lived signed URLs, so it must be muxed from segments at capture time. The Karakeep parser therefore points the enclosure at the **post URL itself** with `downloadVia: 'yt-dlp'`, and `collector.ts` branches on that instead of its HTTP path.

- Auth is `COOKIES_FILE` (the personal cookies.txt), **not** `YT_DLP_COOKIES_FILE` (that's the work Google account for age-gated YouTube).
- Format selection caps height at `VIDEO_COMPRESS_MAX_HEIGHT`, so we pull the 480p rendition (~250 kbps) directly and land under the compressor's 1200 kbps floor — no re-encode, ~1/8th the bytes of the 1080p.
- Filenames use `buildUrlBaseName` like Twitter, so the mp4 pairs with the post's PDF.
- A text-only post returns `reason: 'no_media'`, which the collection worker treats as **terminal** — retrying an extraction five times reaches the same answer.
- Patreon is in `isNonArticleUrl` (`quality/pdf-content.ts`): the post page is a player plus a short blurb, and all four real captures were rejected as `Truncated body: site-template marker "Related posts"`. It keeps the min-chars floor and hostile-page checks.
- `fetchYouTubeMetadata` accepts Patreon (metadata only, never naming) — it's the sole source of the real title, the description with the creator's source links, and the publish date. Karakeep supplies the title `"patreon.com"`, which `isHostnamePlaceholderTitle` discards so it can't win a fallback chain.

**Known wart (pre-existing, affects X too):** `getMediaFilename` lowercases, `buildUrlBaseName` for PDFs doesn't — so `patreon.com-aiexplained-…mp4` sits beside `patreon.com-AIExplained-…pdf`, and the KB's pair-by-basename convention needs a case-insensitive match.

### Debug Artifacts
Failed jobs save the actual PDF (not screenshot) to `data/debug/{jobId}.pdf`. Viewable via failure badge or `GET /api/debug/:jobId`.

### Karpathy Knowledge Base Pattern
Every output file is self-describing with embedded metadata — a downstream Claude Code instance on another network builds a wiki from these files. Never write sidecar `.md` files; never assume the consuming side has any context beyond the file itself.

The full metadata contract is documented in `public/doex-enrichment-details.md`, which ships at the root of every nightly captures zip. **Whenever metadata semantics change (new Info Dict field, new MP4 tag, changed meaning), update that file in the same commit** — the consuming side has no other way to learn about the change.

| Format | Where metadata lives |
|---|---|
| PDF | Info Dict custom fields: Title, Author, Summary, Tags, Language, Translation, Publication, PublishDate, Creator. Tweet captures also get **QuotedTweet** / **InReplyTo** (canonical x.com URLs lifted from the Nitter DOM) and an exact DOM-derived PublishDate that overrides the LLM's guess — timeline reconstruction should treat these as authoritative graph edges. Use helpers in `src/utils/pdf-info-dict.ts` — don't re-cast `(pdfDoc as any).getInfoDict()` |
| MP3 | ID3 standard tags + TXXX custom frames (SUMMARY, TAGS, SOURCE_URL, AUDIO_URL, PODCAST_FEED, DURATION_MS, PUBLISHED_AT) via `node-id3` |
| MP4 | ffmpeg metadata fields (written with `-movflags use_metadata_tags` so custom keys like `source_url`/`doc_type` survive the muxer; `comment` also packs Summary/Tags/Transcript/Source lines as a reader fallback) + embedded VTT subtitles + `.transcript.pdf` sidecar |

All three PDF paths must run `analyzePdfContent` → `enrichDocumentMetadata` → embed in Info Dict:
1. Playwright conversion (`conversion.worker.ts`)
2. Pass-through download (arxiv/.pdf URLs)
3. Karakeep PDF asset download (`media/collection-worker.ts`)
4. Manual capture from Chrome extension (`api/routes/manual-capture.ts`)

Shared save pipeline is in `src/utils/save-pdf.ts` (`savePdfToWeeklyBin` + `embedPdfMetadata`, with `creatorOverride` for extension version tracking).

### Filename Conventions
- Source URL is embedded in PDF `Subject` so Rerun works after BullMQ pruning (14 days / 2000 jobs retention)
- Non-descriptive URL paths (HN `/item`, Reddit `/comments`, bare section indexes like `/blog`, `/news`) use the page title for filename instead of the path segment. Whole-path matches only — `replit.com/blog/some-slug` keeps its slug. This matters where the post id lives in the query string (`qwen.ai/blog?id=qwen3.8`): without it every post on the site saves as `qwen.ai-blog.pdf` and silently overwrites the previous one
- `pageTitle` falls back to the page's single `h1` when `<title>` is just the site's own name (title reduces to a substring of the hostname). Single-title SPAs never update `<title>` per route — every qwen.ai post reports "Qwen". A deliberately short *real* title ("FAR.AI Leaderboard 2026") is not a hostname substring and is left alone
- Twitter: `article` for X Articles (direct from X), `post` for tweets (via Nitter) — never "status"
- **All filenames are lowercase.** `buildUrlBaseName` lowercases at the end, and it's the single source for both the PDF and the MP4 (`getMediaFilename` calls it), so the two always pair. Before 2026-08-12 the PDF kept URL capitalisation (`x.com-JeffLadish-…pdf`) while the MP4 lowercased it, and the KB's link-by-basename convention silently missed every such pair. Don't reintroduce a case-preserving path — `test/filename-basename.test.js` asserts the MP4 and PDF derive an identical base name
- On rerun, if new filename differs from old, the worker deletes `oldFilePath` *after* successful save. Both rerun endpoints must thread `oldFilePath` through `ConversionJobData`.

### Transcript Formatting — Fidelity Over Aesthetics
Two stages, both inside `formatTranscriptWithLLM` (`src/podcasts/transcript-formatter.ts`):
1. **S1-mini normalization** (`src/podcasts/s1-normalizer.ts`, `TRANSCRIPT_NORMALIZE_MODEL`, empty disables): a 0.6B single-task model removing fillers/stutters and fixing casing. Measured MORE word-faithful than gemma (kept hedges gemma deleted; fixed "Deep Mind"→"DeepMind" without hints; never hallucinated fixes for garbles). Quirks that must not be "simplified" away: requires the exact documented system prompt AND the raw Qwen3 template with a primed empty `<think>` block via `/api/generate` — Ollama's `/api/chat` path yields BLANK output. Per-chunk length-ratio sanity check falls back to the raw chunk; the stage can only be a no-op, never a failure.
2. **gemma paragraphing + hint-driven proper-noun repair** — the prompt is deliberately strict: formatter, not editor. Do NOT weaken it. It now explicitly PRESERVES hedging phrases ("sort of", "I think") — an observed gemma failure was deleting meaningful hedges under its old filler license. Known hazard: `gemma4:latest` will hallucinate "smart" substitutions (e.g., Whisper's "01" → "Gemini") if the prompt permits editing. Downstream Claude trusts the transcript as ground truth.

Video transcripts (`src/media/video-enrichment.ts`) must also run through `formatTranscriptWithLLM` with the video title as `episodeTitle` hint — don't hand raw Whisper/Parakeet output to the PDF generator. Formatting must run BEFORE `enrichDocumentMetadata` (both video and podcast paths) — enriching from raw ASR bakes phonetic misspellings ("Jan Lakun" for Yann LeCun) into the summary/tags even when the PDF body is corrected.

### Privacy Filter
`PRIVACY_FILTER_TERMS` (comma-separated) runs in-page JS to hide elements containing those strings. Used to scrub the user's name/handle from sidebars.

### WinAnsi Sanitization
Podcast/transcript PDFs use pdf-lib StandardFonts (WinAnsi-only). LLM output contains invisible chars (U+2060 Word Joiner, zero-width spaces, smart quotes). `sanitizeForWinAnsi` in `src/podcasts/pdf-generator.ts` must stay — removing it breaks PDF generation on certain transcripts.

### Structured Twitter/X Database (`src/twitter/`)
Every Nitter tweet capture ALSO harvests structured data (plain HTTP fetch of Nitter's server-rendered HTML — no Playwright) into `data/twitter/twitter.db` (better-sqlite3, WAL, versioned migrations via `PRAGMA user_version`) plus a sha256 content-addressed imagestore at `data/twitter/imagestore/`. Non-obvious rules:
- **Harvest is non-fatal and additive** — it runs after `savePdfToWeeklyBin` in the worker, gated by `TWITTER_DB_ENABLED`; a harvest failure must never fail the conversion job.
- **X Articles are `/status/` URLs** — the article id EQUALS the announcing tweet's status id, rendered at Nitter `/i/article/<id>`. The converter hops to the article page for the PDF (≥600-char body gate, direct-x.com fallback preserved); `harvestTweetToDb` chains the article automatically. Route harvests by URL shape, not `isXArticle`.
- **Nitter rate limits govern harvest pacing**: the single-session instance affords roughly 90-130 thread fetches per ~45 min before `ConversationTimeline` 429s. The backfill script (`scripts/backfill-twitter-db.ts`) has a circuit breaker (failure streak → 15-min pause); keep delays conservative.
- **Line breaks are literal newlines** in `content_text`/`content_html` (Nitter renders with `white-space: pre-wrap`) — preserve them; the viewer depends on it.
- **tweet_links + pdf_index**: outbound links are matched against the PDF library via the Info Dict `Subject` URL (normalized). `scripts/rematch-twitter-links.ts` re-matches after new captures land.
- **Scripts run on the HOST** (`npx tsx --env-file=.env`, with `KARAKEEP_API_BASE=http://localhost:3001 NITTER_HOST=http://localhost:8080`): the bind-mounted repo's `better-sqlite3` is host-glibc and fails inside the bookworm container.
- Viewer at `/twitter.html`; read-only API under `/api/twitter/*`. The viewer's "Export DB" button hits `GET /api/twitter/export.zip`: an on-demand streamed zip with a full **consistent** twitter.db snapshot (SQLite online backup — never serve the raw `.db`, WAL contents would be missing) plus imagestore files from the last 48h, in the nightly zip's layout. One export at a time (in-flight guard returns 429). Nightly captures zip ships `twitter/twitter.db` (full snapshot via SQLite online backup) + window's imagestore files (`CAPTURES_INCLUDE_TWITTER`); the schema is documented for the consuming side in `public/doex-enrichment-details.md` — **update it in the same commit as any schema/semantics change**.

### Nightly Static Bundles (`/api/file/...`)
Two nightly ZIPs are published as stable static URLs (served by the generic `serve.ts` `/file/*` route straight from DATA_DIR — no dedicated route, no cache):
- **`/api/file/captures/captures-latest.zip`** — every capture (PDF/MP3/MP4/transcript) with mtime in the last 24h, structured `{ISO-week}/{type}/{file}` with a self-describing `MANIFEST.txt`. Built in-process by `src/maintenance/captures-zipper.ts` (`setTimeout` to next midnight, then `setInterval` 24h), registered in `index.ts` alongside the other maintenance timers. Keeps 7 dated bundles (`captures-YYYY-MM-DD.zip`); `-latest` is never pruned. Tunables: `CAPTURES_ZIP_ENABLED`, `CAPTURES_ZIP_HOUR` (default 0), `CAPTURES_WINDOW_HOURS` (24), `CAPTURES_ZIP_RETENTION_DAYS` (7).
- **`/api/file/benchmarks/benchmarks-latest.zip`** — built by the **external** `~/benchmark-harvester` project (host cron), NOT this repo. This repo only serves it. Retention is `BENCH_RETENTION=7` in that repo's `run.sh`.

Both fire at **local midnight** for a clean as-of-midnight snapshot. Alignment depends on `TZ=America/New_York` in docker-compose (host cron is already host-local); without the pinned TZ the in-container captures job would fire at UTC midnight instead.

### Self-Healing Fix System — review branches promptly
Batches land on `fix/batch-*` and never auto-merge, which is safe but not free: by 2026-08-17 the backlog reached 68 branches, and the system had re-derived the *same* fix up to seven nights running because an unmerged branch doesn't stop the failure recurring. The triage that cleared it found the recurring hazard worth remembering:

**Most repeat batches converge on loosening `pdf-content.ts` Checks 2/3 via a "the render reached the site footer, so it's complete" exemption. Do not accept that shape.** Paywalled and truncated pages render their footers too, and the blur-paywall classifier (`hasSandwichedBlankRun`) lives *inside* Check 2 — so a footer exemption on the outer condition silently disables paywall detection on exactly the captures it was built to catch. Prefer fixes that repair the capture (converter-side) or that only re-*classify* an already-failing result; treat anything that flips a capture from fail to pass as needing evidence, since a wrong pass silently archives a broken file.

A batch reaching for an exemption usually means the real bug is upstream in the converter. Review within a week or so; the backlog's cost is duplicated work, not risk.

**Branch awareness** (`src/fix/open-branches.ts`): each diagnosis prompt now lists the unmerged `fix/batch-*` branches — files touched plus the module-level symbols each adds, which is the part that actually identifies a branch (the generated commit subjects were all `fix(self-heal): batch <id> via claude` with an empty body). The agent is told to check for an existing fix first and, if it finds one, to set `alreadyAddressedBy` with `fixApplied: false` and write no code; that counts as a successful diagnosis and logs `fix_already_addressed`. Fix commits now also carry the summary and root causes in their message, so the next triage can skim rather than diff. Listing is best-effort — any git failure returns `[]` and the diagnosis proceeds.

### Self-Healing Fix System
- Users flag false positives (saved PDF that shouldn't have) / false negatives (failed URL that should've succeeded) via "Fix Selected"
- **Replay-loop guards — do not remove.** A failed conversion auto-queues a fix item; the fix batch's replay gate re-runs the URL; if that replay's failure re-queued another fix item, the loop would self-sustain (observed: 60+ ledger events on one URL). Three guards break it: (1) verification replay jobs carry `fixVerification: true` in ConversionJobData and `maybeQueueAutoFix` skips them entirely — the replay's failure is the batch's verification verdict, not a new organic failure; (2) `MAX_AUTO_ATTEMPTS = 5` lifetime cap per URL in `fix/pending.ts`; (3) per-class cooldowns in `fix/trigger-policy.ts`. The failures API (`/weeks/:weekId/failures`) also collapses to one row per URL (newest error wins, `failureCount` carries the collapsed total) so repeat failures don't bury distinct ones.
- Every 5min (offset 2.5min from feed polling) pending items are processed by headless Claude CLI
- Write boundary: `src/quality/*`, `src/converters/*`, `src/workers/*`, `src/utils/*`, `src/fix/*` — but NEVER `src/workers/fix.worker.ts` (the gate must not be editable by the batches it judges). Batches land on `fix/batch-*` branches for human review; they never auto-merge, which is why the broad boundary is safe
- `FIX_ENABLED=true` + `CLAUDE_CLI_PATH` required

## Docker Deployment

Runs in Docker, on nginx-proxy-manager's `proxy-network` behind Cloudflare Access.

**Containers:**
- `pdfzipper-v2` — app (port 3002)
- `pdfzipper-redis` — **external, standalone, not managed by docker-compose**. Holds all BullMQ job history + URL dedup state. **Do not delete** — if lost, every URL reprocesses. Must be on `pdf-zipper-v2_default` network.

**Networks:** app is on both `proxy-network` (for karakeep-web-1:3000, nitter:8080) and `pdf-zipper-v2_default` (for pdfzipper-redis:6379).

**External services (not in docker-compose):**
- Ollama at `mac.mini:11434` — `gemma4:e4b` for vision/enrichment, `gemma4:latest` for transcript formatting
- Parakeet (primary) at `mac.mini:9003` — MLX, `mlx-community/parakeet-tdt-0.6b-v3`, launchd `com.pdfzipper.parakeet-server`
- Parakeet (fallback) at `10.0.0.81:9003` — ONNX, `nemo-parakeet-tdt-0.6b-v3`, CPU ~20x realtime, `systemctl --user status parakeet-server` on ubuntu-m1pro. Same endpoints (`/`, `/health`, `/asr?output=txt|vtt`, `/v1/audio/transcriptions`) but **NOT byte-identical**: the fallback's `/asr` requires the audio multipart field named `file`, while the primary expects `audio_file` (a mismatch 422s the request).
- `src/utils/whisper-host.ts` does a `/health` pre-flight on every transcribe job and routes to the fallback when primary is down. Logs a `whisper_failover` event. Set `WHISPER_HOST_FALLBACK` (already wired in docker-compose) to enable. `resolveWhisperHost()` returns `{ host, audioFieldName }` — always pass `audioFieldName` to `createMultipartFileBody` so failover hits the right field name.
- Route transcription through `transcribeWithRetry()` (same module), never `resolveWhisperHost()` directly. It retries the ASR call up to `TRANSCRIBE_ATTEMPTS` times, re-resolving the host each attempt — a transient outage or fallback 5xx recovers instead of permanently dropping the transcript (video enrichment treats a transcription failure as non-fatal and never revisits it). It's a safety net for real outages (crash/restart): the primary MLX server runs transcription off its event loop, so it no longer goes unresponsive mid-job — failover should rarely fire in normal operation.

**Dockerfile gotcha:** CMD must use shell form to wrap in xvfb-run:
```
CMD xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" node dist/index.js
```

## Common Commands

```bash
# Docker
cd ~/pdf-zipper-v2 && docker compose up -d
docker compose build && docker compose up -d   # after code changes
docker logs -f pdfzipper-v2
docker compose down

# Dev (non-Docker)
npm run dev       # hot reload
npm run build
npm test          # 118 unit tests

# Endpoints
# http://localhost:3002              Web UI
# http://localhost:3002/admin/queues Bull Board

# Submit URL manually
curl -X POST http://localhost:3002/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

## Environment Variables (non-obvious ones)

| Var | Default | Purpose |
|---|---|---|
| `QUALITY_THRESHOLD` | 50 | Vision score 0-100 |
| `OLLAMA_MODEL` | `gemma4:e4b` | Vision scoring (and enrichment default) |
| `ENRICHMENT_MODEL` | = `OLLAMA_MODEL` | Text-only metadata enrichment/translation. **Compose pins `gemma4:e4b` (2026-08-22): every mac.mini Ollama consumer — vision, enrichment, transcripts, AND karakeep tag inference — shares ONE model; gemma4:e4b is the only model any service on this host requests from mac.mini's Ollama (tags queue behind vision during batches, acceptable for background tagging). Steady state: e4b+s1-mini+parakeet ≈ 13GB of 24GB. The earlier faster-per-token `gemma3:4b` split caused ~200 model loads/day and had the 24GB box swapping and hot; do not reintroduce per-task routing without checking RAM co-residency.** Small models hallucinate authors/dates/publishers, so `validateFactualFields` in enrichment.ts nulls author/publishDate unless verbatim-present in source text/URL, and replaces a well-known outlet name that neither the domain nor a masthead supports — don't remove those guards. **Never put a real outlet name in the prompt as an example**: its lone `nytimes.com → The New York Times` example primed ~265 files into claiming the NYT |
| `TRANSCRIPT_FORMAT_MODEL` | `gemma4:latest` | Text formatting (compose pins `gemma4:e4b` — see ENRICHMENT_MODEL consolidation note) |
| `WHISPER_HOST` | `http://mac.mini:9003` | Parakeet/Whisper ASR (primary) |
| `WHISPER_HOST_FALLBACK` | `http://10.0.0.81:9003` | Used when primary fails `/health` pre-flight |
| `NITTER_HOST` | `http://nitter:8080` | Twitter rewrite target |
| `COOKIES_FILE` | — | Netscape cookies.txt for paywalls. Preserve leading `.` on domains (Playwright needs it for subdomain match). Express JSON body limit is bumped to 10mb for cookie upload. |
| `PRIVACY_FILTER_TERMS` | — | Comma-separated strings to hide from PDFs |
| `VIDEO_COMPRESS_ENABLED` | true | Re-encode fat video grabs (X/Twitter) to YouTube-like size post-download |
| `VIDEO_COMPRESS_MAX_HEIGHT` | 720 | Downscale when the SHORTER frame side exceeds this (docker-compose sets 480) |
| `VIDEO_COMPRESS_MAX_FPS` | 30 | Resample when frame rate exceeds this (29.97 NTSC never triggers) |
| `VIDEO_COMPRESS_KBPS_PER_MEGAPIXEL` | 2000 | Bitrate allowance before re-encode kicks in (plus 1200 kbps absolute floor) |
| `VIDEO_COMPRESS_CRF` | 26 | x264 quality for the re-encode (lower = bigger/better) |
| `SMRY_API_KEY` | — | smry.ai Pro key; enables the reader-view rescue tier (empty = off). Key lives in `.env` only |
| `FIX_ENABLED` | false | Enable AI self-healing |
| `CLAUDE_CLI_PATH` | `claude` | Path to Claude CLI |
| `DISCORD_WEBHOOK_URL` | — | Job event notifications |

## Known Gotchas

- **BullMQ job IDs cannot contain `:`** — sanitize via `sanitizeJobId` (non-alphanumeric → underscore)
- **undici default 5min timeout** — whisper/parakeet calls use a custom `Agent` with 4hr timeouts (6hr podcasts exist); don't revert to default fetch
- **Chrome extension debugger conflict** — extension uses `chrome.debugger` + `Page.printToPDF`; conflicts with Matter, React/Redux DevTools, Lighthouse, claude-in-chrome, and other extensions that claim the debugger
- **Parakeet launchd PATH** — must include `/opt/homebrew/bin` (Apple Silicon Homebrew) for ffmpeg

## Ollama MLX vs GGUF (2026-06-30)

- **Keep gemma4 on GGUF; do NOT switch to `gemma4:*-mlx`.** `gemma4:e4b-mlx` has no
  vision capability (empty responses on image input), and the primary use of
  `OLLAMA_MODEL=gemma4:e4b` is vision quality-scoring. Adding an MLX copy alongside
  the GGUF one also doubles resident RAM (~18.5 GB) and collides with parakeet on
  the 24 GB Mac.
- mac.mini's Ollama was upgraded to **0.31.1** (faster Gemma 4 MLX) on this date.
