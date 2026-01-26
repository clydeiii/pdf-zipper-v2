# CLAUDE.md - Project Context for AI Assistants

## Project Overview

pdf-zipper-v2 is an async URL-to-PDF conversion system with:
- **BullMQ + Redis** job queue for processing URLs from RSS feeds (Matter.com, Karakeep)
- **Playwright** with stealth plugin for PDF generation
- **Ollama vision model** (Gemma 3) for quality verification
- **Discord webhook** notifications for job completion/failure
- **Web UI** for file browsing, downloading, and management

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

## Common Commands

```bash
# Development
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
└── converters/
    └── pdf.ts        # Playwright PDF generation
```

## UI Features

- **Clickable filenames** - Open PDFs in new tab
- **Source links** - Open original URL next to each PDF for comparison
- **Clickable failure badges** - View debug PDF
- **Rerun All** - Re-capture entire week
- **Rerun Selected** - Re-capture specific items (files or failed URLs)
- **Delete Selected** - Remove files AND/OR failed items (removes from BullMQ)
- **Download Selected** - ZIP download
