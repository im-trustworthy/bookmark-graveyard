# Bookmark Brief

Turns your X bookmarks into a personal weekly briefing. It signs in with your X account, deep-reads
everything behind each bookmark — linked articles, images, video — and uses a two-tier Grok model
blend to synthesize what you saved into a digest: markdown, or markdown plus a two-host podcast.
Community Notes cross-checks and a staleness pass keep it honest and current.

**Core loop:** sign in with X → bookmarks sync automatically → ingestion & analysis fill in over a
few chunked background calls → filter by date/topic or hand-pick posts → generate a brief.

This is a personal tool (see [Project status](#project-status)), but it's written multi-user-ready.

## Features

### Sync
- OAuth 2.0 PKCE login with X, read-only scopes (`tweet.read`, `users.read`, `bookmark.read`,
  `offline.access`). Access/refresh tokens are AES-256-GCM–encrypted at rest and refreshed
  automatically (with rotation) when they expire.
- Pulls your bookmarks — X's API caps a first sync at your ~800 most recent; after that, regular
  syncs grow the library past 800 since only genuinely new `tweet_id`s get inserted.
- Sync is decoupled from analysis: bookmarks appear in the UI the moment the fetch finishes; topics
  and summaries fill in a few seconds later as background chunks land.

### Deep ingestion (`src/lib/ingest.ts`)
- **Articles** — fetches linked URLs (post + quoted post, up to 3 per post) and extracts the
  readable body with Mozilla Readability. A second Grok pass verifies the fetched article actually
  matches what the post described before it's trusted.
- **"Link in the replies" posts** — when a post promises a link it doesn't embed (matching patterns
  like "link below 👇" / "full article"), Grok's live X/web search (`x_search` + `web_search` agent
  tools) looks for the author's own self-reply link.
- **Images** — described and read by Grok vision; legible text (tables, code) is transcribed
  verbatim, not just summarized.
- **Video/GIFs** — transcribed by the configured voice provider (Grok STT or ElevenLabs Scribe)
  from the lowest-bitrate MP4 variant, capped at 25 minutes / 60MB; falls back to a thumbnail
  description if transcription fails, is skipped, or the voice provider is misconfigured.
- Runs 3-way concurrent, capped per request so it fits inside the serverless timeout budget (see
  [Pipeline](#pipeline)).

### Enrichment & taxonomy (`src/lib/brain.ts`)
- Batches of 20 posts (3 batches concurrently) through the FAST Grok model to tag topics, write a
  one-sentence summary, extract up to 3 key claims, and classify `content_type` (news / evergreen /
  opinion / other) — grounded in the full dossier (post + quoted post + ingested article/media
  content), not just the tweet text.
- Topic tags strongly prefer reusing your existing taxonomy; a new tag is only coined when nothing
  fits, so the topic list stays navigable instead of exploding.

### Credibility & staleness
- A daily GitHub Actions job (`.github/workflows/community-notes.yml`, 06:30 UTC) streams X's
  public Community Notes dataset and matches notes against your bookmarked `tweet_id`s — there's no
  API for reading notes on an arbitrary post, so this reads the same bulk zipped TSV dumps X publishes.
- Posts with a note classified `MISINFORMED_OR_POTENTIALLY_MISLEADING` **and** currently rated
  helpful are excluded from digests entirely (listed separately, as links only). Posts with any
  other note are kept, but the digest is told to caveat them.
- At digest time (not enrich time, so it reflects the news as of *now*), a staleness pass asks Grok
  to judge every `news`-classified post: `keep`, `stale` (dropped), or `evolved` (kept, flagged as
  likely having moved on since it was posted). Non-news posts skip this pass entirely.

### Digest generation
- Filter by date range and/or topic tags, or bypass filters entirely by hand-picking specific posts
  in the UI. Either way, individual bookmarks can be permanently hidden from all future briefs — X's
  read-only scopes mean the app can't un-bookmark on your behalf, so "hide" is a local flag.
- Output as markdown, or markdown plus a two-host podcast.
- **Markdown** — a two-stage SMART-model synthesis: first an editorial outline (3-7 thematic
  sections spanning topics, strongest material first), then full prose composed section by section
  from that outline, grounded in the full dossiers. Every idea is attributed inline as a markdown
  link to its creator; it closes with a "Worth a deeper look" pick of the 3 most substantive items.
- **Audio** — a NotebookLM-style two-host script (Alex, curious; Blake, analytical) written from the
  finished markdown, word-budgeted to a target runtime (the API supports 5-30 minutes; the UI
  currently always asks for 20), then rendered with the configured voice provider (Grok Voice or
  ElevenLabs), one voice per host, and stitched into one MP3. Creators are credited by spoken name,
  never read out as raw handles.
- **Voices** — chosen in the app: connect Grok Voice or ElevenLabs, optionally with your own key,
  and pick Host A/B from a live list with previews; server env vars are just the instance defaults.

### Reliability & UX
- Every API route caps `maxDuration` at 300 seconds, and nothing that could run long — ingestion,
  enrichment, audio rendering — happens in a single request. The client drives each stage in bounded
  chunks and loops until done, so the UI shows real progress ("recording audio — line 14 of 82", an
  actual percentage bar) instead of an indefinite spinner.
- Episodes stuck mid-generation (`status: "draft"`) never show up in episode history — only fully
  rendered (`"ready"`) ones do.

### Multi-user & security
- `ALLOWED_X_USER_IDS` gates login: empty means personal mode (whoever completes X OAuth is
  allowed); set it to a comma-separated list of X user IDs to lock the instance down.
- The session cookie is HMAC-signed, httpOnly, `SameSite=Lax` (secure-flagged in production).
  Supabase is only ever touched server-side with the service-role key — row-level security is
  deny-all, so the browser has no direct database access.
- Per-user voice-provider keys (pasted in the Voices panel) are AES-256-GCM–encrypted at rest like
  the X tokens, only ever used server-side, and shown back as their last 4 characters at most.
- The Vercel cron endpoint (`/api/cron/sync`) fails closed: with no `CRON_SECRET` configured it
  returns 503 rather than running unauthenticated, so a deployed instance can't be triggered by
  anyone who finds the URL.

## Architecture

```
Browser (dashboard.tsx — client component)
   |  fetch, same-origin, bb_session cookie (HMAC-signed)
   v
Next.js API routes  (src/app/api/**)
   |
   |--> X API (api.x.com)              OAuth 2.0 PKCE login + bookmark reads
   |--> Supabase (Postgres + Storage)  service-role key only, RLS deny-all
   |--> xAI Grok (api.x.ai/v1)         FAST + SMART chat models, x_search/web_search
   |--> Voice provider (pick one)      xAI Grok (api.x.ai/v1/tts, /v1/stt)
                                       OR ElevenLabs (TTS + Scribe)

Unattended jobs, outside the request path:

  GitHub Actions (daily, 06:30 UTC)
    scripts/community-notes-sync.mjs --> X's public Community Notes zipped TSV dumps
                                      --> Supabase `community_notes` table

  Vercel Cron (Fridays, vercel.json)
    GET /api/cron/sync (Bearer CRON_SECRET) --> sync + ingest + enrich,
                                                 every allowed user, unattended
```

**Data model** (Supabase Postgres; the schema is in `supabase/migrations/`, applied by
`npm run setup` or `supabase db push`):
- `users` — one row per X account; encrypted tokens, allowlist flag
- `bookmarks` — raw synced posts, deduped by `tweet_id`
- `bookmark_sources` — ingested article/image/video content, one row per source
- `bookmark_analysis` — topics, summary, claims, content_type, credibility
- `topics` — the user's growing tag taxonomy
- `community_notes` — matched notes from X's public dataset
- `episodes` — generated briefs (storage paths, script, status, stats, pinned voice provider + host
  voices)
- `user_voice_settings` — per-user voice provider, encrypted key (nullable = use instance key), two
  host voices
- Storage bucket `episodes` — the markdown/MP3 files themselves, served via 24-hour signed URLs

**Stack**: Next.js 16 (App Router) + React 19 + TypeScript + Tailwind 4, Supabase (Postgres +
Storage), the `openai` SDK pointed at xAI's OpenAI-compatible endpoint, Zod. Next.js 16 has real
breaking changes from what most tooling/training data assumes (async `cookies()` / `searchParams`,
etc.) — see `AGENTS.md` before touching framework-level code.

## Quickstart

```bash
git clone https://github.com/im-trustworthy/x-bookmark.git
cd x-bookmark
npm install
cp .env.example .env.local   # optional: `npm run setup` creates it if it's missing
# fill in .env.local — SETUP.md walks through where to get every value, in order
npm run setup                # checks every value, generates the secrets, provisions the database
npm run dev
```

Open http://localhost:3000.

## Pipeline

Two independent pipelines: one keeps your bookmark library fresh, the other turns a slice of it
into a brief on demand.

**Sync → ingest → enrich** (`/api/sync`, then `/api/enrich` looped by the client):
1. **Sync** (`syncUser`) — paginates X's bookmarks endpoint, inserts only unseen `tweet_id`s.
   Tolerates X's rate limits (bounded backoff, up to 2 retries) and early pagination stops (keeps a
   partial result rather than failing the whole sync). Returns immediately — no analysis yet.
2. **Ingest** (`ingestPending`) — up to 15 not-yet-ingested bookmarks per call: fetch linked
   articles, describe images, transcribe video. 3-way concurrent.
3. **Enrich** (`enrichNewBookmarks`) — up to 60 ingested-but-unanalyzed bookmarks per call, batched
   20 at a time through the FAST model for topics/summary/claims/content_type.

The dashboard calls `/api/enrich` in a loop until `remaining` hits zero, updating the status line
with a live count each pass. That's why sync feels instant and tags "fill in" a few seconds later
instead of one long blocking request — every call to X's bookmarks API and every Grok batch happens
inside a request designed to finish well under the 300-second ceiling.

**Prepare → script → render → finalize** (only when you click "Create my brief"):
1. **`/api/digest/prepare`** — select bookmarks (filters or your hand-picked selection) → staleness
   pass on news items → two-stage SMART synthesis (outline, then compose) → upload `brief.md` to
   Storage → create the `episodes` row. Markdown-only requests stop here (`status: "ready"`
   immediately).
2. **`/api/digest/script`** — the SMART model turns the markdown into an Alex/Blake dialogue script,
   saved onto the episode row.
3. **`/api/digest/render`** — renders 12 script lines per call to MP3 (one TTS call per line, one
   voice per host; ElevenLabs also gets neighboring-line context for prosody), uploading each chunk
   to Storage. The client loops, advancing a cursor, driving a real `cursor / totalLines` progress
   bar.
4. **`/api/digest/finalize`** — downloads every chunk, concatenates them (chunks share one CBR
   encoding — MP3, 44.1 kHz, 128 kbps — whichever provider rendered them, with per-clip ID3/Xing
   headers stripped, so byte concatenation is valid), uploads the final `brief.mp3`, deletes the
   chunk files, flips the episode to `status: "ready"`.

Audio rendering is the slowest and most timeout-prone step — one TTS call per line of
dialogue — so it's the one broken into the smallest chunks (12 lines) with the most granular
client-visible progress. This staged design is what makes long briefs safe to generate from a
regular HTTP request instead of needing a background job queue.

## Cost notes

- **X reads** — pay-per-use, bookmark reads are billed at $0.001/post. A first sync (~800 posts)
  costs under a dollar; weekly incremental syncs are pennies.
- **Grok** — the two-tier model blend exists specifically for token efficiency. The FAST model
  (`grok-4.3`, override with `XAI_MODEL_FAST`) does all the high-volume,
  low-reasoning work: image descriptions, per-post categorization, article-match verification,
  staleness checks. The SMART model (`grok-4.7`, override with `XAI_MODEL_SMART`) is reserved for
  low-volume, high-value synthesis: digest outline, digest composition, podcast script, and live
  search. A full sync plus a weekly digest is typically well under $1 in xAI usage.
- **Voice (audio briefs + video transcription)** — unlike the Grok LLM blend, there's no cheap tier
  for speech: every character spoken is billed the same regardless of how "smart" it needs to be, so
  the provider you pick is the cost lever. Measured on real episodes (~15 minutes of audio,
  ~11,500–13,800 spoken characters, 31–43 dialogue lines; pricing as of October 2026):

  | Voice provider | Billing | Per ~15-minute episode |
  | --- | --- | --- |
  | **Grok Voice** | $15 per 1M characters, pay-as-you-go on the same xAI credits as the LLM calls (no subscription) | ~$0.20 — under $1/month for a weekly brief |
  | **ElevenLabs, Creator plan** | $22/month for 121,000 credits; Turbo bills 0.5 credits per character | ~6,000–7,000 credits, about $1.25 — a weekly brief uses roughly a quarter of the plan |
  | **ElevenLabs, usage-based** | $0.04 per 1,000 characters (Turbo) | ~$0.55 |

  Video transcription is much smaller either way, and only runs on bookmarks that contain video:
  Grok STT is $0.10/hour (REST), ElevenLabs Scribe v2 is $0.22/hour. ElevenLabs defaults to the
  turbo model (`eleven_turbo_v2_5`, override with `ELEVENLABS_MODEL`) to stretch a plan further, and
  its `previous_text`/`next_text` prosody hints aren't billed. The trade-off for Grok's price: it
  has no equivalent of those continuity hints, so each line is rendered standalone — listen to a
  sample before committing. The instance default is `VOICE_PROVIDER` (`grok` or `elevenlabs`; unset,
  it's ElevenLabs when `ELEVENLABS_API_KEY` is set, otherwise Grok, since the app requires
  `XAI_API_KEY` anyway — see [SETUP.md](SETUP.md) step 4), and users can override it in the app; a
  user's own key is billed to their account.

## Project status

Personal tool, built and run by [@im-trustworthy](https://github.com/im-trustworthy). The repo is
currently private and may be open-sourced later. Unit tests cover the pure library logic
(`npm test`); route handlers and the pipeline are exercised end-to-end rather than mocked.
License: TBD — treat as all-rights-reserved until one is added.

Deferred / planned work — and why some of it is blocked upstream — lives in [ROADMAP.md](ROADMAP.md).
