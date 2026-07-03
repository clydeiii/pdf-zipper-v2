# doex-enrichment-details

This file ships inside every `captures-*.zip` bundle. It describes exactly what
metadata the capture system (pdf-zipper-v2) embeds in each file, so a consumer
with **no other context** — you, the Claude building a knowledge base from
these files — can reconstruct sources, timelines, and relationships without
guessing. Everything below is embedded *inside* the files themselves; there are
no sidecar databases and no external state to fetch.

Last updated: 2026-07-03.

## Bundle layout

```
{ISO-week}/{type}/{file}     e.g. 2026-W27/pdfs/x.com-somebody-post-123.pdf
MANIFEST.txt                 bundle self-description (window, counts, sizes)
doex-enrichment-details.md   this file
```

Types: `pdfs/` (article + tweet captures, pass-through PDFs), `videos/`
(MP4s + `.transcript.pdf` sidecars), `podcasts/` (MP3s + `.transcript.pdf`).
A bundle contains everything captured (file mtime) in the last 24h; a re-run
or re-enrichment of an older file makes it "fresh" again and re-ships it —
**later copies of the same filename supersede earlier ones.**

## PDFs — Info Dict fields

Read with any PDF metadata reader (`pdfinfo`, pypdf, pdf-lib). Custom fields:

| Field | Meaning |
|---|---|
| `Title` | Best-known title (LLM-enriched, anchored to the page's own title) |
| `Author` | Only set when verbatim-present in the source text/URL (hallucination guard nulls uncertain values) |
| `Subject` | **The source URL. Authoritative provenance for every capture.** |
| `Summary` | LLM summary of the content |
| `Tags` | Comma-separated topic tags |
| `Language` | ISO language of the source; `Translation` present when a translation was embedded |
| `Publication` | Publisher / site / posting account |
| `PublishDate` | Publication date. For tweets this is the **exact** timestamp lifted from the rendered DOM (ISO 8601) and overrides any LLM guess |
| `Creator` | Which pipeline made this: `pdf-zipper v2` (Playwright), `pdf-zipper-v2-archive` (archive.today snapshot), `pdf-zipper-v2-chrome-plugin-vX.Y.Z` (manual browser capture) |
| `ViaArchive` | Present when content came via an archive.today snapshot (value = snapshot URL) or an archive wrapper the user captured manually |
| `QuotedTweet` | Tweet captures only: canonical `https://x.com/{user}/status/{id}` URL of the status this tweet quotes. **Authoritative graph edge** — prefer it over parsing the rendered text |
| `InReplyTo` | Tweet captures only: canonical URL of the parent status this tweet replies to |
| `CaptureScope` | Manual captures: `page`, `reader`, or `selection` |
| `Markdown` / `MarkdownLength` / `MarkdownExtractedBy` | Manual captures: a clean Readability/Turndown markdown extraction of the article, embedded alongside the rendered PDF |

Tweet capture conventions:
- Filenames: `x.com-{account}-post-{statusId}.pdf` for tweets (rendered via a
  local Nitter), `...-article-...` for X Articles (rendered from x.com).
- A quote-tweet's PDF *renders* the quoted tweet inline AND carries the
  `QuotedTweet` edge; the quoted tweet may have its own capture and/or its
  video stored separately (see `also_bookmarked_as` below).

## MP4 videos — format tags

Read with `ffprobe -show_entries format_tags`. Written with
`use_metadata_tags`, so custom keys survive:

| Tag | Meaning |
|---|---|
| `source_url` | The tweet/page the video was bookmarked from. **Authoritative.** |
| `also_bookmarked_as` | `; `-separated URLs of OTHER tweets that embed this same video (e.g. a quote-tweet of the original). The capture system detects duplicate video content at download time and stores only one copy — `source_url` + `also_bookmarked_as` together are the complete set of tweets referencing this video. Filename attribution follows whichever tweet was bookmarked first; **the tags are authoritative, not the filename** |
| `title`, `artist` (creator), `album` (publisher/channel) | Standard tags |
| `summary`, `tags` | LLM enrichment (from the transcript, or from the post text for silent videos) |
| `comment` | Reader-fallback pack: summary + tags + transcript size + source URL |
| `transcript_chars` | Length of the ASR transcript; `0` for silent videos |
| `silent_video` | `true` when the clip has no audio track (common for screen-recording demos) — no transcript exists or ever will |
| `channel`, `upload_date`, `yt_description` | From yt-dlp where available (YouTube/Vimeo/X) |
| `bookmarked_at` | When the user bookmarked it |

Videos with speech also contain an **embedded subtitle track** (the transcript
as mov_text) and a `{same-basename}.transcript.pdf` sidecar carrying the full
formatted transcript with the same Info Dict fields as other PDFs
(`doc_type` distinguishes `video-transcript` vs `audio-transcript`).

## MP3 podcasts — ID3 tags

Standard ID3 (title/artist/album) plus TXXX custom frames: `SUMMARY`, `TAGS`,
`SOURCE_URL`, `AUDIO_URL`, `PODCAST_FEED`, `DURATION_MS`, `PUBLISHED_AT`.
Each has a `.transcript.pdf` sidecar (formatted, speaker-preserving).

## Reconstruction guidance

- **Provenance join key**: the source URL (`Subject` in PDFs, `source_url` in
  media). A tweet's PDF, its video, and its transcript all share it.
- **Tweet graph**: `QuotedTweet` and `InReplyTo` edges (PDFs) plus
  `also_bookmarked_as` (videos) are extracted from structured DOM/probes at
  capture time — trust them over text parsing. Edges are directional
  (quote → quoted, reply → parent); invert as needed.
- **Timeline**: for tweets use `PublishDate` (exact); for articles prefer
  `PublishDate` when present, else `bookmarked_at`/file mtime as "when seen".
- **Transcript fidelity**: transcripts are formatter-cleaned but never
  paraphrased — treat wording as ground truth from the audio. Enriched
  summaries/tags are LLM output — useful for indexing, not ground truth.
- **Duplicates across bundles**: same filename in a later bundle = fresher
  capture or richer metadata; always take the newest.
