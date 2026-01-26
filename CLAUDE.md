# CLAUDE.md - Project Context for AI Assistants

## Project Overview

pdf-zipper-v2 is an async URL-to-PDF conversion system with:
- **BullMQ + Redis** job queue for processing URLs from RSS feeds (Matter.com, Karakeep)
- **Playwright** with stealth plugin for PDF generation
- **Ollama vision model** (Gemma 3) for quality verification
- **Discord webhook** notifications for job completion/failure
- **Web UI** for file browsing, downloading, and management
- **Podcast transcription** via Whisper ASR for Apple Podcasts URLs

## Key Architecture Decisions

### URL Handling
- **Canonical URL** (`url`): Normalized for deduplication (strips `www.`, normalizes protocol)
- **Original URL** (`originalUrl`): Preserved for archive.is links (archive.is treats `www.example.com` and `example.com` as different)
- Always pass both through the pipeline; use `originalUrl` for external links

### Quality Verification
- Screenshot is **viewport-only** (top ~800px), not full page
- Don't flag "truncated" just because article continues below viewport
- Focus on actual problems: blank pages, bot detection, paywalls, login walls
- Quality threshold is configurable via `QUALITY_THRESHOLD` env var

### Debug Artifacts
- Failed jobs save the **actual PDF** (not screenshot) to `data/debug/{jobId}.pdf`
- PDFs are more useful than screenshots for debugging issues like truncation
- Accessible via clicking failure badge in UI or `/api/debug/:jobId`

### PDF Metadata
- Source URL embedded in PDF `Subject` field using pdf-lib
- Enables "Rerun" feature to work even after jobs pruned from BullMQ
- BullMQ retains completed jobs for 14 days / 2000 jobs

### Podcast Transcription
- Apple Podcasts URLs (`podcasts.apple.com`) are automatically detected
- Metadata fetched from iTunes Lookup API (podcast name, episode title, duration, etc.)
- Audio downloaded and sent to Whisper ASR for transcription
- PDF generated with metadata header + full transcript
- Saved to weekly bins under `podcasts/` folder
- Uses separate BullMQ queue (`podcast-transcription`) with lower concurrency

## Lessons Learned (Debugging Session 2026-01-26)

### 1. Archive.is URL Preservation
**Problem:** Archive.is links weren't working because URL normalizer strips `www.`
**Solution:** Added `originalUrl` field that preserves the original URL for archive.is links
**Files:** `src/jobs/types.ts`, `src/feeds/metadata-worker.ts`, `src/api/routes/files.ts`, `public/app.js`

### 2. Dark Theme Detection
**Problem:** Nitter (dark theme) pages were flagged as "blank" by quality scorer
**Solution:** Updated quality prompt to check for text content regardless of background color
**File:** `src/quality/scorer.ts`

### 3. False Positive "Truncated" Detection
**Problem:** Quality scorer saw viewport-only screenshot and assumed content was truncated
**Solution:** Updated prompt to explain it's only seeing top ~800px and that's normal; removed "truncated" as issue type
**File:** `src/quality/scorer.ts`

### 4. Debug Screenshots vs PDFs
**Problem:** Screenshots don't show issues like actual truncation or rendering problems
**Solution:** Save the actual failed PDF to debug folder instead of screenshot
**Files:** `src/workers/conversion.worker.ts`, `src/api/routes/debug.ts`

### 5. Twitter/X via Nitter
- Twitter URLs are rewritten to local Nitter instance (`localhost:8080`)
- Exception: Twitter Articles go directly to Twitter (Nitter can't render them)
- Nitter uses dark theme - quality scorer must handle this

### 6. URL Normalization vs Conversion (Session 2)
**Problem:** Sites like `uncoveralpha.com` require `www.` but metadata-worker was using `canonicalUrl` (normalized, www stripped) for conversion
**Solution:** Use original `url` for HTTP conversion, only use `canonicalUrl` for deduplication
**File:** `src/feeds/metadata-worker.ts`

### 7. PDF Content Analysis for Truncation
**Problem:** Screenshot-based quality check passes when top looks good (headline + hero image) but actual PDF is truncated (paywall)
**Solution:** Added `src/quality/pdf-content.ts` that extracts text from PDF and checks:
- Minimum 500 chars
- Large PDFs (>500KB) need >1000 chars (catches "big image, no article" case)
- Multi-page PDFs need >5 chars/KB text density
**Files:** `src/quality/pdf-content.ts`, `src/workers/conversion.worker.ts`

### 8. Error Page Detection
**Problem:** 404/error pages were passing quality checks if they had enough text
**Solution:** Added regex patterns to detect common error messages ("page can't be found", "404", etc.)
**File:** `src/quality/pdf-content.ts`

### 9. Footnote Tooltip Rendering
**Problem:** Sites with JavaScript footnote tooltips (darioamodei.com) rendered tooltips vertically in PDFs
**Solution:** Added CSS to hide `.footnote-tooltip` and common tooltip patterns in print
**File:** `src/converters/pdf.ts`

## Lessons Learned (Podcast Transcription Session 2026-01-26)

### 10. Apple Podcasts URL Structure
**Discovery:** Apple Podcasts URLs follow pattern: `https://podcasts.apple.com/{country}/podcast/{slug}/id{podcastId}?i={episodeId}`
- `podcastId` = collection ID for iTunes API lookup
- `episodeId` (from `?i=` param) = `trackId` in iTunes API response
**Solution:** Parse URL to extract IDs, then call iTunes Lookup API to get metadata + audio URL
**File:** `src/podcasts/apple.ts`

### 11. iTunes Lookup API for Podcast Metadata
**Discovery:** iTunes API returns RSS feed URL and direct episode audio URLs
- Call: `https://itunes.apple.com/lookup?id={podcastId}&media=podcast&entity=podcastEpisode&limit=200`
- Returns podcast info (first result) + episode list
- Episode `episodeUrl` field contains direct MP3/M4A link
- Episode `trackId` matches the `?i=` param from Apple Podcasts URL
**Limitation:** Only returns ~200 most recent episodes; very old episodes may not be found
**File:** `src/podcasts/apple.ts`

### 12. Whisper ASR Response Format
**Problem:** whisper-asr-webservice with `output=json` returned SRT format, not JSON
**Discovery:** The `output` parameter behavior varies by Whisper deployment; our instance returns SRT by default
**Solution:**
1. Request `output=text` for plain text (cleaner than parsing SRT)
2. Read response as text first, then try JSON.parse with fallback to plain text
3. Wrap plain text in `{ text: responseText }` structure
**File:** `src/podcasts/transcriber.ts`

### 13. Large Audio File Handling
**Problem:** Podcast audio files are 20-200MB; streaming downloads caused TypeScript type issues
**Solution:** Use `response.arrayBuffer()` instead of streaming - simpler and works for typical podcast sizes
**Consideration:** For very large files (>500MB), may need streaming with proper type casting
**File:** `src/podcasts/transcriber.ts`

### 14. Podcast Audio Archival
**Problem:** Initially deleted temp audio after transcription; user wanted to keep for archival
**Solution:**
1. Return audio path from transcriber (don't cleanup)
2. Worker copies audio to weekly bin alongside PDF
3. Files share same base name: `{podcast}-{episode}.pdf` + `{podcast}-{episode}.mp3`
4. API links related files via `relatedFiles` field
5. UI shows 🎧 audio link on transcript PDFs
**Files:** `src/podcasts/transcriber.ts`, `src/podcasts/podcast-worker.ts`, `src/api/routes/files.ts`, `public/app.js`

### 15. PDF Generation with pdf-lib
**Discovery:** pdf-lib can create PDFs from scratch, but text handling is manual
- Must handle text wrapping manually (measure text width, split into lines)
- Must handle pagination manually (check Y position, add new page when needed)
- StandardFonts available: Helvetica, HelveticaBold, HelveticaOblique, etc.
**File:** `src/podcasts/pdf-generator.ts`

### 16. API Route vs Feed Worker URL Detection
**Problem:** Direct API submissions (`POST /api/jobs`) bypassed metadata worker's podcast detection
**Solution:** Added podcast URL detection to both:
1. `src/feeds/metadata-worker.ts` - for feed-based URLs
2. `src/api/routes/jobs.ts` - for direct API submissions
Both use `isApplePodcastsUrl()` and route to `podcast-transcription` queue

## Docker Deployment

pdf-zipper-v2 runs in Docker, connected to nginx-proxy-manager's `proxy-network`.

### Container Architecture
- **pdfzipper-v2** - Main app container (port 3002)
- **pdfzipper-redis** - External Redis container (stores job history, deduplication state)
  - IMPORTANT: This Redis is NOT managed by docker-compose; it's a standalone container
  - Contains all BullMQ job history and URL deduplication data
  - Must be connected to `pdf-zipper-v2_default` network for the app to reach it

### Network Configuration
The app container is on two networks:
- `proxy-network` - Access to Karakeep (`karakeep-web-1:3000`), Nitter (`nitter:8080`)
- `pdf-zipper-v2_default` - Access to Redis (`pdfzipper-redis:6379`)

### Key Files
- `Dockerfile` - Node 20 + Playwright + xvfb (for headed Chrome)
- `docker-compose.yml` - App service definition (Redis is external)
- `.dockerignore` - Excludes node_modules, dist, data

### Common Commands

```bash
# Start/restart
cd ~/pdf-zipper-v2 && docker compose up -d

# Rebuild after code changes
docker compose build && docker compose up -d

# View logs
docker logs -f pdfzipper-v2

# Stop
docker compose down
```

### Lessons Learned (Docker Migration 2026-01-26)

**17. External Redis for Job History**
**Problem:** Docker compose created new Redis, causing all URLs to reprocess (no deduplication history)
**Discovery:** The `pdfzipper-redis` container (originally `pdf-zipper-redis`) was created during dev mode and contains all job history
**Solution:** Point docker-compose at external Redis container instead of creating internal one
**Important:** Never delete `pdfzipper-redis` - it has all BullMQ job history and deduplication state
**File:** `docker-compose.yml` uses `REDIS_HOST=pdfzipper-redis`

**18. Nitter Host Configuration**
**Problem:** Nitter host was hardcoded as `localhost:8080`, unreachable from Docker
**Solution:** Added `NITTER_HOST` env var, configured to `http://nitter:8080` (container name on proxy-network)
**Files:** `src/config/env.ts`, `src/converters/pdf.ts`, `docker-compose.yml`

**19. xvfb-run CMD Syntax**
**Problem:** Dockerfile CMD with exec form (`["xvfb-run", ...]`) didn't start node properly
**Solution:** Use shell form: `CMD xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" node dist/index.js`
**File:** `Dockerfile`

**20. Whisper ASR Output Format**
**Problem:** Whisper ASR returned SRT format even when requesting plain text
**Discovery:** The correct parameter is `output=txt` (not `output=text`)
**Solution:**
1. Use `output=txt` parameter for plain text transcripts
2. Set up new faster_whisper instance on port 9002 (old instance on 9000 was misconfigured)
3. Keep SRT cleanup as fallback in case of format issues
**Whisper Server:** `http://10.0.0.81:9002` (faster_whisper engine, medium.en model)
**Docs:** https://ahmetoner.com/whisper-asr-webservice/
**File:** `src/podcasts/transcriber.ts`, `src/config/env.ts`

**21. LLM Post-Processing for Podcast Transcripts**
**Problem:** Raw Whisper output has choppy paragraphs based on audio pauses, not semantic meaning
**Solution:** Added LLM post-processing step using Ollama to reformat transcripts:
1. Merges choppy sentences into coherent paragraphs (4-6 sentences each)
2. Removes filler words (um, uh, you know, like)
3. Adds paragraph breaks at natural topic transitions
4. Preserves all original content/meaning
5. Uses show notes as spelling hints for proper nouns (e.g., "Clawdbot" not "Claude Bot")
**Config:** `TRANSCRIPT_FORMAT_MODEL` env var - use larger model (gemma3:12b) for better quality
**Note:** gemma3:4b is too small to follow complex formatting + spelling instructions reliably
**Pipeline:** Whisper ASR → LLM Formatting (with show notes context) → PDF Generation
**File:** `src/podcasts/transcript-formatter.ts`, `src/podcasts/podcast-worker.ts`

**22. Show Notes with Clickable Links from RSS Feed**
**Problem:** iTunes API returns plain text descriptions without URLs
**Discovery:** RSS feed has full HTML with `<a href>` links to source articles
**Solution:**
1. Fetch RSS feed from `feedUrl` in podcast metadata
2. Parse XML to find episode by title/GUID
3. Extract links from HTML description
4. Render "Show Notes" section in PDF with clickable link annotations
**Files:** `src/podcasts/rss-parser.ts`, `src/podcasts/apple.ts`, `src/podcasts/pdf-generator.ts`

**23. Podcast URL Routing in Rerun Endpoints**
**Problem:** Rerunning podcast transcripts via web UI tried to PDF-capture the Apple Podcasts website
**Cause:** Rerun endpoints (`/weeks/:weekId/rerun`, `/rerun-selected`) always used `conversionQueue`
**Solution:** Added podcast URL detection to rerun endpoints - routes to `podcastQueue` if `isApplePodcastsUrl()`
**Files:** `src/api/routes/files.ts`, `src/podcasts/types.ts` (added 'rerun' to source type)

**24. Whisper ASR Model Selection**
**Problem:** `distil-medium.en` model truncates transcripts after ~30 seconds (bug in the model)
**Discovery:** 21-minute podcast produced only 910 chars with distil-medium.en, but 19,151 chars with medium.en
**Solution:** Use `medium.en` model instead of `distil-medium.en` for complete transcriptions
**Tradeoff:** medium.en is slower (~11 min for 21-min podcast vs ~2.5 min for distil) but produces complete output
**Whisper Server:** `http://10.0.0.81:9002` with `ASR_MODEL=medium.en`, `ASR_ENGINE=faster_whisper`

**25. Node.js Fetch (undici) Timeout for Long Requests**
**Problem:** Whisper transcription requests timing out at exactly 5 minutes
**Cause:** Node's built-in fetch uses undici with default `headersTimeout` of 300 seconds (5 min)
**Solution:** Create custom undici Agent with extended timeouts and use as dispatcher:
```typescript
import { Agent } from 'undici';
const whisperAgent = new Agent({
  headersTimeout: 30 * 60 * 1000,  // 30 minutes
  bodyTimeout: 30 * 60 * 1000,
});
await fetch(url, { dispatcher: whisperAgent });
```
**Note:** Whisper ASR webservice uses Uvicorn (not Gunicorn), so server-side timeout config is not needed - the fix is purely client-side.
**File:** `src/podcasts/transcriber.ts`

## Common Commands (Development)

```bash
# Development (non-Docker)
npm run dev          # Start with hot reload
npm run build        # TypeScript compile

# Server runs on port 3002
# Bull Board: http://localhost:3002/admin/queues
# Web UI: http://localhost:3002

# Test a URL manually
curl -X POST http://localhost:3002/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

## Environment Variables

Key optional settings:
- `DISCORD_WEBHOOK_URL` - Discord notifications for job events
- `QUALITY_THRESHOLD` - Score 0-100, default 50
- `OLLAMA_MODEL` - Vision model, default `gemma3`
- `COOKIES_FILE` - Netscape cookies.txt for paywall bypass
- `WHISPER_HOST` - Whisper ASR server URL, default `http://10.0.0.81:9000`

## File Structure

```
src/
├── api/routes/       # Express endpoints
│   ├── files.ts      # Week browsing, rerun, delete
│   ├── debug.ts      # Debug PDF serving
│   └── serve.ts      # File serving for UI
├── workers/
│   └── conversion.worker.ts  # Main job processor
├── quality/
│   └── scorer.ts     # Vision model quality check
├── notifications/
│   └── discord.ts    # Discord webhook integration
├── converters/
│   └── pdf.ts        # Playwright PDF generation
└── podcasts/         # Podcast transcription
    ├── apple.ts      # Apple Podcasts URL parsing, iTunes API
    ├── transcriber.ts    # Audio download, Whisper ASR client
    ├── pdf-generator.ts  # Transcript PDF generation
    └── podcast-worker.ts # BullMQ worker orchestration
```

## UI Features

- **Clickable filenames** - Open PDFs in new tab
- **Source links** - Open original URL next to each PDF for comparison
- **Clickable failure badges** - View debug PDF
- **Rerun All** - Re-capture entire week
- **Rerun Selected** - Re-capture specific items (files or failed URLs)
- **Delete Selected** - Remove files AND/OR failed items (removes from BullMQ)
- **Download Selected** - ZIP download
