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

### URL Routing (by type, before queuing)
- **Apple Podcasts** (`podcasts.apple.com`) → `podcastQueue` (iTunes API metadata + audio download + Parakeet transcription)
- **Video** (YouTube/Vimeo) → rejected in direct API; from Karakeep with enclosure → media collection (yt-dlp)
- **PDF URLs** (`.pdf`, arxiv `/abs/` `/html/` `/pdf/`) → direct fetch pass-through (skip Playwright). arxiv `/abs/` is rewritten to `/pdf/` first
- **Karakeep PDF asset** (`content.type: "asset"`, `assetType: "pdf"`) → media collection, download via `/api/assets/{id}`. Filename lives in `bookmark.assets[].fileName`, not `content.fileName`
- **Twitter/X** → rewritten to local Nitter (`NITTER_HOST`). Exception: X Articles go direct (Nitter can't render)
- Everything else → `conversionQueue` (Playwright)

Rerun endpoints must apply the same routing — both `/weeks/:weekId/rerun` and `/rerun-selected` check `isApplePodcastsUrl()` before queuing.

### Quality Pipeline
Two-layer quality check, both must pass:
1. **Vision score** (`src/quality/scorer.ts`): Ollama sees viewport-only screenshot (~800px). Don't flag "truncated" from viewport alone. Threshold configurable via `QUALITY_THRESHOLD`.
2. **PDF content analysis** (`src/quality/pdf-content.ts`): extracts text, checks char counts, char/KB ratio, error-page patterns, paywall patterns.

Tunable bypasses in pdf-content.ts — don't re-introduce false positives that were explicitly worked around:
- `SUFFICIENT_CHARS_BYPASS_RATIO = 3000` — skip ratio check on image-heavy articles
- `MIN_CHARS_PER_PAGE_BYPASS = 400` — skip ratio check on short announcement pages
- Error-page regex only runs when content < 2000 chars (real 404s don't have long bodies)
- Pass-through PDFs (arxiv, direct .pdf) skip quality checks but **do** run metadata enrichment

### Debug Artifacts
Failed jobs save the actual PDF (not screenshot) to `data/debug/{jobId}.pdf`. Viewable via failure badge or `GET /api/debug/:jobId`.

### Karpathy Knowledge Base Pattern
Every output file is self-describing with embedded metadata — a downstream Claude Code instance on another network builds a wiki from these files. Never write sidecar `.md` files; never assume the consuming side has any context beyond the file itself.

| Format | Where metadata lives |
|---|---|
| PDF | Info Dict custom fields: Title, Author, Summary, Tags, Language, Translation, Publication, PublishDate, Creator. Use helpers in `src/utils/pdf-info-dict.ts` — don't re-cast `(pdfDoc as any).getInfoDict()` |
| MP3 | ID3 standard tags + TXXX custom frames (SUMMARY, TAGS, SOURCE_URL, AUDIO_URL, PODCAST_FEED, DURATION_MS, PUBLISHED_AT) via `node-id3` |
| MP4 | ffmpeg metadata fields + embedded VTT subtitles + `.transcript.txt` sidecar |

All three PDF paths must run `analyzePdfContent` → `enrichDocumentMetadata` → embed in Info Dict:
1. Playwright conversion (`conversion.worker.ts`)
2. Pass-through download (arxiv/.pdf URLs)
3. Karakeep PDF asset download (`media/collection-worker.ts`)
4. Manual capture from Chrome extension (`api/routes/manual-capture.ts`)

Shared save pipeline is in `src/utils/save-pdf.ts` (`savePdfToWeeklyBin` + `embedPdfMetadata`, with `creatorOverride` for extension version tracking).

### Filename Conventions
- Source URL is embedded in PDF `Subject` so Rerun works after BullMQ pruning (14 days / 2000 jobs retention)
- Non-descriptive URL paths (HN `/item`, Reddit `/comments`, etc.) use the page title for filename instead of the path segment
- Twitter: `article` for X Articles (direct from X), `post` for tweets (via Nitter) — never "status"
- On rerun, if new filename differs from old, the worker deletes `oldFilePath` *after* successful save. Both rerun endpoints must thread `oldFilePath` through `ConversionJobData`.

### Transcript Formatting — Fidelity Over Aesthetics
The `formatTranscriptWithLLM` prompt (`src/podcasts/transcript-formatter.ts`) is deliberately strict: formatter, not editor. Do NOT weaken it. Known hazard: `gemma4:latest` will hallucinate "smart" substitutions (e.g., Whisper's "01" → "Gemini") if the prompt permits editing. Downstream Claude trusts the transcript as ground truth.

Video transcripts (`src/media/video-enrichment.ts`) must also run through `formatTranscriptWithLLM` with the video title as `episodeTitle` hint — don't hand raw Whisper/Parakeet output to the PDF generator.

### Privacy Filter
`PRIVACY_FILTER_TERMS` (comma-separated) runs in-page JS to hide elements containing those strings. Used to scrub the user's name/handle from sidebars.

### WinAnsi Sanitization
Podcast/transcript PDFs use pdf-lib StandardFonts (WinAnsi-only). LLM output contains invisible chars (U+2060 Word Joiner, zero-width spaces, smart quotes). `sanitizeForWinAnsi` in `src/podcasts/pdf-generator.ts` must stay — removing it breaks PDF generation on certain transcripts.

### Self-Healing Fix System
- Users flag false positives (saved PDF that shouldn't have) / false negatives (failed URL that should've succeeded) via "Fix Selected"
- Every 5min (offset 2.5min from feed polling) pending items are processed by headless Claude CLI
- Write boundary: only `src/quality/*` and `src/converters/*` — don't broaden this
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
- Parakeet (fallback) at `10.0.0.81:9003` — ONNX, `nemo-parakeet-tdt-0.6b-v3`, CPU ~20x realtime, `systemctl --user status parakeet-server` on ubuntu-m1pro. Same API shape (`/`, `/health`, `/asr?output=txt|vtt`, `/v1/audio/transcriptions`).
- `src/utils/whisper-host.ts` does a `/health` pre-flight on every transcribe job and routes to the fallback when primary is down. Logs a `whisper_failover` event. Set `WHISPER_HOST_FALLBACK` (already wired in docker-compose) to enable.

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
npm test          # 53 unit tests

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
| `OLLAMA_MODEL` | `gemma4:e4b` | Vision + enrichment |
| `TRANSCRIPT_FORMAT_MODEL` | `gemma4:latest` | Text formatting |
| `WHISPER_HOST` | `http://mac.mini:9003` | Parakeet/Whisper ASR (primary) |
| `WHISPER_HOST_FALLBACK` | `http://10.0.0.81:9003` | Used when primary fails `/health` pre-flight |
| `NITTER_HOST` | `http://nitter:8080` | Twitter rewrite target |
| `COOKIES_FILE` | — | Netscape cookies.txt for paywalls. Preserve leading `.` on domains (Playwright needs it for subdomain match). Express JSON body limit is bumped to 10mb for cookie upload. |
| `PRIVACY_FILTER_TERMS` | — | Comma-separated strings to hide from PDFs |
| `FIX_ENABLED` | false | Enable AI self-healing |
| `CLAUDE_CLI_PATH` | `claude` | Path to Claude CLI |
| `DISCORD_WEBHOOK_URL` | — | Job event notifications |

## Known Gotchas

- **BullMQ job IDs cannot contain `:`** — sanitize via `sanitizeJobId` (non-alphanumeric → underscore)
- **undici default 5min timeout** — whisper/parakeet calls use a custom `Agent` with 4hr timeouts (6hr podcasts exist); don't revert to default fetch
- **Chrome extension debugger conflict** — extension uses `chrome.debugger` + `Page.printToPDF`; conflicts with Matter, React/Redux DevTools, Lighthouse, claude-in-chrome, and other extensions that claim the debugger
- **Parakeet launchd PATH** — must include `/opt/homebrew/bin` (Apple Silicon Homebrew) for ffmpeg
