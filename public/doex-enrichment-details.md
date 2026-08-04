# doex-enrichment-details

This file ships inside every `captures-*.zip` bundle. It describes exactly what
metadata the capture system (pdf-zipper-v2) embeds in each file, so a consumer
with **no other context** — you, the Claude building a knowledge base from
these files — can reconstruct sources, timelines, and relationships without
guessing. Everything needed is shipped inside the bundle; there is no external
state to fetch.

Last updated: 2026-07-29.

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
| `Publication` | Publisher / site / posting account. Backed by the source domain, by a masthead near the top of the document, or by a curated domain→publisher map. A well-known outlet name that none of those support is replaced by the domain-derived name, so a capture is not attributed to an outlet merely quoted inside it. **Files captured before 2026-08-03 predate this guard** — roughly 265 of them name "The New York Times" on domains that are not the NYT, and `Creator` on those reads "The New York Times via pdf-zipper v2". Treat `Subject` (the source URL) as authoritative wherever the two disagree |
| `PublishDate` | Publication date. For tweets this is the **exact** timestamp lifted from the rendered DOM (ISO 8601) and overrides any LLM guess |
| `Creator` | Which pipeline made this: `pdf-zipper v2` (Playwright), `pdf-zipper-v2-archive` (archive.today snapshot), `pdf-zipper-v2-chrome-plugin-vX.Y.Z` (manual browser capture) |
| `ViaArchive` | Present when content came via an archive.today snapshot (value = snapshot URL) or an archive wrapper the user captured manually |
| `QuotedTweet` | Tweet captures only: canonical `https://x.com/{user}/status/{id}` URL of the status this tweet quotes. **Authoritative graph edge** — prefer it over parsing the rendered text |
| `InReplyTo` | Tweet captures only: canonical URL of the parent status this tweet replies to |
| `AIDetection` | Substack posts only: Pangram's AI-detection verdict as shown to readers, e.g. `Fully Human-Written`, `Mostly Human-Written`, `Partially AI-assisted text`. Also carries the reasons a scan produced no score — `Subscription required` (paywalled), `Not eligible for AI detection` (usually under ~100 words), `AI detection unavailable` (writer disabled it) |
| `AIDetectionStatus` | Machine-readable companion to `AIDetection`: `success`, `error`, `disabled`, `pending`. Percentages exist only when this is `success` |
| `AIDetectionAI` / `AIDetectionAIAssisted` / `AIDetectionHuman` | Share of the post's text in each class, as whole percentages (`67%`). They sum to ~100%. `AIDetectionAI: 0%` is a real measurement and means something different from the field being absent |
| `AIDetectionSource` / `AIDetectionCheckedAt` | Always `Pangram via Substack`, and when the scan ran (ISO 8601). The verdict is computed against the post as it stood at capture time — an edited post would score differently, so treat this as a point-in-time reading, not a durable property |
| `AIDisclosure` | The writer's own "How I make this" statement, when they published one. This is a self-report and is independent of the Pangram score; the two can disagree. Normalised whitespace, truncated past 1200 chars with `…` |
| `CaptureScope` | Manual captures: `page`, `reader`, or `selection` |
| `Markdown` / `MarkdownLength` / `MarkdownExtractedBy` | Manual captures: a clean Readability/Turndown markdown extraction of the article, embedded alongside the rendered PDF |

AI-detection caveats — these fields are evidence, not verdicts:
- **Absence means "not measured", never "human-written".** Only Substack posts
  are scanned, because Substack is the only source here that publishes a
  detection result. Everything else in the library is simply unchecked.
- Pangram is a statistical classifier with real error rates in both
  directions, and reporting on the Substack launch flagged concern about
  false positives on some writers. Do not treat a score as proof of authorship.
- `AIDisclosure` is the writer speaking; `AIDetection` is a model guessing.
  Quote them separately and attribute each.

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

## twitter/ — structured Twitter/X database (SQLite) + imagestore

New as of 2026-07-29. Every bundle carries:

- **`twitter/twitter.db`** — a FULL consistent SQLite snapshot (not
  incremental): always replace your previous copy with the newest bundle's.
  Harvested from the self-hosted Nitter render of every bookmarked
  x.com/twitter.com post at capture time.
- **`twitter/imagestore/<xx>/<sha256>.<ext>`** — images from the last 48h
  (double the bundle window, so each image appears in two consecutive
  bundles and one missed nightly pickup self-heals). The store is
  content-addressed (path = sha256 of bytes) — accumulate the union across
  bundles, overwrite-or-skip on collision (duplicates are byte-identical),
  and every image-path column (`avatar_file`, `cover_image_file`,
  `image_file`, `file`, and `poster_file`) in the DB resolves. Identical images are stored
  once regardless of how many posts/users reference them. Gap check: the
  `images` table lists every file the DB references — any listed `file`
  missing from your accumulated store means a skipped bundle older than the
  overlap; dated bundles are retained 7 days for recovery.

To bootstrap a consumer with no accumulated imagestore, the producer must make
one bundle with `CAPTURES_TWITTER_IMAGE_WINDOW_HOURS=0` (or `all`). That bundle
contains the full imagestore with no mtime cutoff, and `MANIFEST.txt` labels it
`FULL bootstrap store`. Normal 48-hour windowed bundles can resume afterward.

Database media paths and zip paths deliberately use different roots:
`tweets.pdf_path`, `articles.pdf_path`, `tweet_links.pdf_path`, and
`captures.pdf_path` are **DATA_DIR-relative**, so they start with
`media/{ISO-week}/{type}/{file}`. Media zip entries omit the leading `media/`.
Join them by stripping exactly one leading `media/` segment:
`media/2026-W27/pdfs/foo.pdf` → `2026-W27/pdfs/foo.pdf`.
Values under `twitter/imagestore/...`, by contrast, match zip entries verbatim.

Resolve those paths against your **accumulated** extraction of all bundles, not
a single bundle: the DB is a full snapshot referencing every capture since
inception, while each bundle carries only its own window of media. A `pdf_path`
that resolves to nothing yet means that PDF shipped in an earlier bundle (or
predates this feed) — it is not an error.

Tables (schema version in `PRAGMA user_version`; columns may grow over time —
read by name, not position):

- **tweets** — one row per post seen (subjects, ancestors, replies, quoted).
  `id` is the status id as TEXT (exceeds 2^53). Key fields: `username`,
  `content_html`/`content_text` (Nitter-rendered; line breaks are literal
  newlines — render with pre-wrap; hrefs canonicalized to absolute x.com),
  `published_at` (exact UTC from the Nitter DOM — authoritative),
  `reply_to_id`/`quoted_id`/`retweeted_by` (graph edges), `reply_to_users`
  (JSON array), stats (`replies_count`, `retweets_count`, `likes_count`,
  `views_count` + `stats_updated_at` — a snapshot, not live),
  `community_note_html`/`community_note_text` (Community Note when X showed
  one), `pdf_path` (DATA_DIR-relative weekly-bin PDF representing this post
  and its captured replies), `is_stub` (1 = row not harvested from its own
  thread page; content/media may still be present when learned from a quote
  card), `source_url`.
- **users** — `username` (PK, case-insensitive), `fullname`, `verified`,
  `avatar_file` → imagestore.
- **tweet_media** — per-post media. `position` is the authoritative ordering
  key for multi-image/mixed-media posts. Other columns: `kind`
  photo|video|gif|card-image,
  `orig_url` (original pbs.twimg.com/video.twimg.com URL), `file`
  (imagestore, full resolution), `poster_file`, `video_url` (original mp4),
  `local_video` (convenience basename; often NULL because the MP4 lands after
  harvest). For video/gif rows, fall back to the conventional zip entry
  `{ISO-week}/videos/x.com-<username>-post-<status_id>.mp4` (historic files
  may use `twitter.com-...`). Its speech transcript sidecar is
  `x.com-<username>-post-<status_id>.transcript.pdf`.
- **tweet_cards** — one link-preview row per tweet: `tweet_id`, `url`,
  `title`, `description`, and `image_file` (imagestore path).
- **tweet_polls** — ordered poll options: `tweet_id`, `option_index`, `label`,
  and `value_percent`; order by `option_index`.
- **tweet_links** — outbound links per post (and from chained article
  bodies): `position` is the authoritative source order, `url` (shorteners
  resolved when possible), `pdf_path` set when the
  link's target is itself a captured PDF in these bundles — a direct
  cross-document edge for the KB.
- **articles** — X Articles (long-form). `id` equals the announcing tweet's
  status id; `tweet_id` links the announcing post. Full `body_html`/
  `body_text`, `cover_image_file`, `pdf_path`, `harvested_from`
  ('nitter'|'x.com').
- **article_media** — inline article images → imagestore; `position` is the
  authoritative body ordering key.
- **captures** — provenance: one row per harvest (kind, subject_id,
  source_url, bookmarked_at, captured_at, pdf_path, replies_captured, origin
  worker|backfill|manual).
- **images** — the authoritative URL→imagestore-file gap-check index. Every
  non-NULL `file` should exist in the consumer's accumulated imagestore. It is
  not the preferred reconstruction source, but it must be checked for
  completeness.
- **pdf_index** — producer-side PDF source URL matching index; safe to ignore
  for reconstruction.

Precedence: for anything present in both, this DB supersedes text-parsing the
PDFs (it is extracted from structured DOM, not OCR/text heuristics). The PDFs
remain the visual/archival record. Resolve DB `pdf_path` columns by stripping
one leading `media/`; resolve videos using `local_video` when populated or the
deterministic filename convention above.

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
