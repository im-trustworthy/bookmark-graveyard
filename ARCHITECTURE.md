# Architecture

How Bookmark Graveyard works inside. For what it is and how to set it up, start with the
[README](README.md). For the step-by-step setup, see [SETUP.md](SETUP.md).

**Core loop:** sign in with X → bookmarks sync → ingestion and analysis fill in over a few chunked
background calls → filter by date and topic, or hand-pick posts → generate a brief.

It is written multi-user-ready: every table is keyed by user, and an allowlist controls who can
sign in.

## Contents

- [Stack](#stack)
- [System overview](#system-overview)
- [Features by subsystem](#features-by-subsystem)
- [Pipeline](#pipeline)
- [Data model](#data-model)
- [Grok model blend](#grok-model-blend)
- [Voice provider interface](#voice-provider-interface)
- [Capacity and pruning](#capacity-and-pruning)
- [Connector (MCP)](#connector-mcp)
- [Security measures](#security-measures)
- [Scheduled jobs](#scheduled-jobs)
- [Cost analysis](#cost-analysis)
- [Testing](#testing)

## Stack

[Next.js](https://nextjs.org) 16 (App Router), [React](https://react.dev) 19,
[TypeScript](https://www.typescriptlang.org), [Tailwind](https://tailwindcss.com) 4,
[Supabase](https://supabase.com) (Postgres and Storage), the
[`openai` SDK](https://github.com/openai/openai-node) pointed at [xAI](https://docs.x.ai)'s
OpenAI-compatible endpoint, and [Zod](https://zod.dev).

Next.js 16 has real breaking changes from what most tooling and training data assumes (async
`cookies()` and `searchParams`, the `proxy.ts` file, and more). Read [AGENTS.md](AGENTS.md) and the
guides in `node_modules/next/dist/docs/` before touching framework-level code.

## System overview

```
Browser (dashboard.tsx, a client component)
   |  fetch, same-origin, bb_session cookie (HMAC-signed)
   v
Next.js API routes  (src/app/api/**)
   |<-- AI assistants (MCP clients): POST /api/mcp, bearer token only, never a cookie
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

  Scheduler (Fridays 12:00 UTC): Render cron (render.yaml) or Vercel Cron (vercel.json)
    GET /api/cron/sync (Bearer CRON_SECRET) --> sync + ingest + enrich,
                                                 every allowed user, unattended
```

Repository map:

| Path | What lives there |
| --- | --- |
| `src/app/` | Pages, the dashboard (`dashboard.tsx`), the Voices and Assistants panels (`voice-settings.tsx`, `assistant-settings.tsx`), API routes under `api/`, OAuth sign-in for assistants under `oauth/` and `.well-known/` |
| `src/lib/` | All the logic: `x.ts` (X API), `sync.ts`, `ingest.ts`, `brain.ts` (Grok prompts), `grok.ts`, `tts.ts`, `voice/` (providers), `capacity.ts`, `limits.ts`, `crypto.ts`, `session.ts`, and for assistants `mcp/` (the tools), `api-tokens.ts`, `oauth.ts`, `jobs.ts` (background briefs) and `digest.ts` (the four brief stages) |
| `src/proxy.ts` | The optional site-wide password gate, which leaves the assistant endpoints open |
| `supabase/migrations/` | The database schema, the source of truth |
| `scripts/` | `setup.mjs` (`npm run setup`), `community-notes-sync.mjs`, plus two maintenance scripts |
| `.github/workflows/` | The daily Community Notes job |
| `render.yaml`, `vercel.json` | Deployment and cron configuration |

## Features by subsystem

### Sync

- OAuth 2.0 PKCE login with X, read-only scopes (`tweet.read`, `users.read`, `bookmark.read`,
  `offline.access`). Access and refresh tokens are AES-256-GCM encrypted at rest and refreshed
  automatically, with rotation, when they expire. Refreshes are compare-and-swap, so two parallel
  requests cannot strand a login by racing on a single-use refresh token.
- Pulls your bookmarks. X's API caps a first sync at your ~800 most recent. After that, regular
  syncs grow the library past 800, because only genuinely new `tweet_id`s get inserted.
- X does not say when you saved a bookmark, so the app can only filter by when a post was
  published. See [ROADMAP.md](ROADMAP.md) for the "saved between" idea.
- Sync is decoupled from analysis. Bookmarks appear in the UI the moment the fetch finishes. Topics
  and summaries fill in a few seconds later as background chunks land.
- The first visit with an empty library starts a sync automatically.

### Deep ingestion (`src/lib/ingest.ts`)

- **Articles.** Fetches linked URLs (post plus quoted post, up to 3 per post) and extracts the
  readable body with [Mozilla Readability](https://github.com/mozilla/readability), capped at 8,000 characters. A second Grok pass verifies
  that the fetched article matches what the post described before it is trusted.
- **"Link in the replies" posts.** When a post promises a link it does not embed (patterns like
  "link below" or "full article"), Grok's live X and web search (`x_search` and `web_search` agent
  tools) looks for the author's own self-reply link.
- **Images.** Described and read by Grok vision. Legible text (tables, code) is transcribed
  verbatim, not just summarized.
- **Video and GIFs.** Transcribed by the configured voice provider (Grok STT or ElevenLabs Scribe)
  from the lowest-bitrate MP4 variant, capped at 60 minutes and 160 MB. Falls back to a thumbnail
  description if transcription fails, is skipped, or the voice provider is misconfigured.
- Runs 3-way concurrent, capped per request so it fits inside the serverless timeout budget (see
  [Pipeline](#pipeline)).

### Enrichment and taxonomy (`src/lib/brain.ts`)

- Batches of 20 posts (3 batches concurrently) go through the FAST Grok model to tag topics, write a
  one-sentence summary, extract up to 3 key claims, and classify `content_type` (news, evergreen,
  opinion or other). The model sees the full dossier (post, quoted post, ingested article and media
  content), not just the tweet text.
- Topic tags strongly prefer reusing your existing taxonomy. A new tag is only coined when nothing
  fits, so the topic list stays navigable instead of exploding.

### Credibility and staleness

- A daily [GitHub Actions](https://docs.github.com/actions) job
  (`.github/workflows/community-notes.yml`, 06:30 UTC) streams X's public
  [Community Notes dataset](https://communitynotes.x.com/guide/en/under-the-hood/download-data)
  and matches notes against your bookmarked `tweet_id`s. There is no API for reading notes on an
  arbitrary post, so this reads the same bulk zipped TSV dumps X publishes.
- Posts with a note classified `MISINFORMED_OR_POTENTIALLY_MISLEADING` **and** currently rated
  helpful are excluded from digests entirely (listed separately, as links only). Posts with any
  other note are kept, but the digest is told to caveat them.
- At digest time (not enrich time, so it reflects the news as of now), a staleness pass asks Grok to
  judge every `news`-classified post: `keep`, `stale` (dropped), or `evolved` (kept, flagged as
  likely having moved on since it was posted). Non-news posts skip this pass entirely.

### Digest generation

- Filter by date range and topic tags, or bypass filters by hand-picking specific posts in the UI.
  Either way, individual bookmarks can be permanently hidden from all future briefs. X's read-only
  scopes mean the app cannot un-bookmark on your behalf, so "hide" is a local flag.
- Output is markdown, or markdown plus a two-host podcast.
- **Markdown.** A two-stage SMART-model synthesis. First an editorial outline (3 to 7 thematic
  sections spanning topics, strongest material first). Then full prose composed section by section
  from that outline, grounded in the full dossiers. Every idea is attributed inline as a markdown
  link to its creator. It closes with a "Worth a deeper look" pick of the 3 most substantive items.
- **Audio.** A [NotebookLM](https://notebooklm.google.com)-style two-host script (Alex, curious;
  Blake, analytical) written from the finished markdown and word-budgeted to a target runtime. The
  API supports 5 to 30 minutes. The UI currently always asks for 20. The script is rendered with the
  configured voice provider (Grok Voice or [ElevenLabs](https://elevenlabs.io)), one voice per host,
  and stitched into one MP3. Creators are credited by spoken name, never read out as raw handles.
- **Voices.** Chosen in the app: connect Grok Voice or ElevenLabs, optionally with your own key, and
  pick Host A and Host B from a live list with previews. Server env vars are just the instance
  defaults.

### Reliability and UX

- Every long-running API route caps `maxDuration` at 300 seconds (the lighter voice and capacity
  routes cap at 60, the status route at 30). Nothing that could run long (ingestion, enrichment,
  audio rendering) happens in a single request. The client drives
  each stage in bounded chunks and loops until done, so the UI shows real progress ("recording
  audio, line 14 of 82", an actual percentage bar) instead of an indefinite spinner.
- Episodes stuck mid-generation (`status: "draft"`) never show up in episode history. Only fully
  rendered (`"ready"`) ones do. A draft that was interrupted (refresh, network blip, TTS hiccup) is
  offered back as a "Resume" banner, and resumes in the voices it started with.
- Capacity awareness. See [Capacity and pruning](#capacity-and-pruning).

## Pipeline

Two independent pipelines. One keeps your bookmark library fresh. The other turns a slice of it into
a brief on demand.

**Sync → ingest → enrich** (`/api/sync`, then `/api/enrich` looped by the client):

1. **Sync** (`syncUser`). Paginates X's bookmarks endpoint (up to 10 pages of 100) and inserts only
   unseen `tweet_id`s. Tolerates X's rate limits (bounded backoff, up to 2 retries) and early
   pagination stops (keeps a partial result rather than failing the whole sync). Returns
   immediately, with no analysis yet.
2. **Ingest** (`ingestPending`). Up to 15 not-yet-ingested bookmarks per call: fetch linked
   articles, describe images, transcribe video. 3-way concurrent.
3. **Enrich** (`enrichNewBookmarks`). Up to 60 ingested-but-unanalyzed bookmarks per call, batched
   20 at a time through the FAST model for topics, summary, claims and content type.

The dashboard calls `/api/enrich` in a loop until `remaining` hits zero, updating the status line
with a live count each pass. That is why sync feels instant and tags "fill in" a few seconds later
instead of arriving as one long blocking request. Every call to X's bookmarks API and every Grok
batch happens inside a request designed to finish well under the 300-second ceiling.

**Prepare → script → render → finalize** (only when you click "Create my brief"):

1. **`/api/digest/prepare`**. Select bookmarks (filters or your hand-picked selection), run the
   staleness pass on news items, run the two-stage SMART synthesis (outline, then compose), upload
   `brief.md` to Storage and create the `episodes` row. Markdown-only requests stop here
   (`status: "ready"` immediately). Audio requests check the voice setup first, before any paid work.
2. **`/api/digest/script`**. The SMART model turns the markdown into an Alex and Blake dialogue
   script, saved onto the episode row.
3. **`/api/digest/render`**. Renders 12 script lines per call to MP3 (one TTS call per line, one
   voice per host. ElevenLabs also gets neighboring-line context for prosody), uploading each chunk
   to Storage. The client loops, advancing a cursor (`render_cursor`, forward-only), driving a real
   `cursor / totalLines` progress bar.
4. **`/api/digest/finalize`**. Downloads every chunk and concatenates them. Chunks share one CBR
   encoding (MP3, 44.1 kHz, 128 kbps) whichever provider rendered them, with per-clip ID3 and Xing
   headers stripped, so byte concatenation is valid. Uploads the final `brief.mp3`, deletes the
   chunk files, and flips the episode to `status: "ready"`. It first makes room in Storage if the
   upload would pass the capacity ceiling.

Audio rendering is the slowest and most timeout-prone step, since it makes one TTS call per line of
dialogue. So it is the one broken into the smallest chunks (12 lines) with the most granular
client-visible progress. This staged design is what makes long briefs safe to generate from a
regular HTTP request instead of needing a background job queue. The one exception is a brief an AI
assistant starts, which a small server-side runner drives through the same four stages; see
[Connector (MCP)](#connector-mcp).

## Data model

Supabase Postgres. The schema lives in `supabase/migrations/`, applied by `npm run setup` or
`supabase db push`. Every table has row-level security enabled with no policies (deny-all), so the
browser has no direct database access. Only the server's service-role client touches data.

| Table or object | What it holds |
| --- | --- |
| `users` | One row per X account: handle, encrypted access and refresh tokens, `is_allowed` flag |
| `bookmarks` | Raw synced posts (text, author, metrics, entities, media, quoted-post context, raw JSON), deduped by `(user_id, tweet_id)`, plus `hidden` and `ingested_at` |
| `bookmark_sources` | Ingested article, image and video content, one row per source, with a status of `ok`, `failed` or `skipped` |
| `bookmark_analysis` | Topics, summary, claims, `content_type`, credibility (`none`, `disputed`, `misleading`) |
| `topics` | The user's growing tag taxonomy |
| `community_notes` | Matched notes from X's public dataset (note id, tweet id, text, classification, status) |
| `episodes` | Generated briefs: title, format, filters used, storage paths, script, status (`draft`, `ready`, `failed`), `render_cursor`, `duration_seconds`, `audio_pruned_at`, and the pinned voice provider and host voices (`voice`) |
| `user_voice_settings` | Per-user voice provider, encrypted key (null means use the instance key), two host voices |
| `usage_events` | One row per spend-incurring action, and per assistant tool call (`mcp_call`), for the rolling 24-hour caps |
| `record_usage()` | Postgres function that counts and inserts atomically, under a per-user-and-kind advisory lock |
| `storage_usage_bytes()`, `database_size_bytes()` | Service-role-only functions that measure capacity |
| `api_tokens` | Assistant tokens: name, display prefix, SHA-256 `token_hash`, scopes, and for sign-in tokens a `client_id`, `refresh_token_hash` and `previous_refresh_token_hash` (the refresh token the last rotation replaced, for reuse detection), plus `last_used_at`, `expires_at` and `revoked_at` |
| `brief_jobs` | One row per assistant-started brief: validated params, status (`queued`, `running`, `done`, `failed`), stage, `episode_id`, progress counters, `heartbeat_at`, the current runner's `lease_id`, and the `token_id` that started it (no foreign key) |
| `claim_brief_job()` | Postgres function that is the job runner's lease: claims a queued job, or takes over a stale one, in one statement, stamping a fresh `lease_id` |
| `oauth_clients` | Assistants that registered themselves for sign-in: name and redirect URIs, public clients only |
| `oauth_codes` | Authorization codes: hashed, five minutes, single use, with the PKCE challenge and the token each produced |
| `prune_oauth_clients()` | Postgres function that deletes registrations unused after an hour and fully revoked ones after 30 days, and returns how many remain |
| `evict_oauth_client()` | Postgres function that deletes the oldest registration with no live token, to make room at the 1,000-client ceiling |
| Storage bucket `episodes` | The markdown and MP3 files themselves. Private, served to the browser via 24-hour signed URLs, and to assistants through stable links that mint a fresh one-hour URL on each visit |

## Grok model blend

The two-tier blend exists for token efficiency.

- The **FAST** model (`grok-4.3`, override with `XAI_MODEL_FAST`) does the high-volume,
  low-reasoning work: image descriptions, per-post categorization, article-match verification,
  staleness checks.
- The **SMART** model (`grok-4.7`, override with `XAI_MODEL_SMART`) is reserved for low-volume,
  high-value synthesis: digest outline, digest composition, podcast script, and live search.
- `XAI_REASONING_FAST` and `XAI_REASONING_SMART` set the reasoning effort per tier (`none`, `low`,
  `medium`, `high` or `xhigh`; defaults `none` and `medium`). Reasoning tokens bill as output, so
  raise them only if quality needs it. An empty value omits the parameter, for a model that rejects
  it.

List prices when the defaults were picked (2026-10-05): `grok-4.3` is $1.25 per million input tokens
and $2.50 per million output. `grok-4.7` is $2.00 per million input and $6.00 per million output.

## Voice provider interface

`src/lib/voice/` hides the two vendors behind one interface (`types.ts`):

```ts
interface VoiceProvider {
  readonly id: "grok" | "elevenlabs";
  // One dialogue line → bare CBR MP3 frames (44.1 kHz, 128 kbps), ID3/Xing already stripped.
  synthesize(text, speaker, context?): Promise<Buffer>;
  // Audio or video bytes → plain transcript text. Throws on an empty transcript.
  transcribe(media, mimeType, filename?): Promise<string>;
}
```

- **Which provider.** `VOICE_PROVIDER` (`grok` or `elevenlabs`) is the instance default. Unset, it is
  ElevenLabs when `ELEVENLABS_API_KEY` is set, otherwise Grok, since the app requires `XAI_API_KEY`
  anyway. A user can override it in the Voices panel. An invalid value fails with a message naming
  the setting.
- **Resolution order.** A user's saved settings win over the instance defaults, field by field. A
  brief pins its provider and voices when it starts (`episodes.voice`), so a resumed render finishes
  in the voices it began with.
- **Keys.** A user's own key is stored AES-256-GCM encrypted (`user_voice_settings.api_key_enc`) and
  only ever used server-side. The panel shows at most its last 4 characters. With the instance's key,
  users see only the vendor's shared voices, never the operator's own cloned or designed voices.
- **Grok Voice.** TTS and STT at `api.x.ai/v1`. Built-in voices default to `ara` (Alex) and `helios`
  (Blake), overridable with `GROK_VOICE_HOST_A` and `GROK_VOICE_HOST_B`. No neighboring-line
  continuity hints, so each line is rendered standalone.
- **ElevenLabs.** TTS with the turbo model by default (`eleven_turbo_v2_5`, override with
  `ELEVENLABS_MODEL`) and Scribe v2 for transcription. Host voice ids come from
  `ELEVENLABS_VOICE_HOST_A` and `ELEVENLABS_VOICE_HOST_B` or the Voices panel. Its `previous_text`
  and `next_text` prosody hints give smoother line-to-line delivery and are not billed.
- **Errors.** A rejected key (401, or xAI's 400 "Incorrect API key") becomes `InvalidVoiceKeyError`
  with no vendor body in the message. Missing or corrupt configuration is a `VoiceConfigError` whose
  message names the setting to fix, never a secret. Both surface to the user as a 400 with an
  actionable message.

## Capacity and pruning

The dashboard shows storage and database use ("Storage 4% · Database 3%") and warns at 80%.

- **Measuring.** Through the `storage_usage_bytes()` and `database_size_bytes()` functions on every
  call. Nothing is cached.
- **Storage** is the limit that bites: a 15-minute brief's MP3 is about 13.5 MB against the free
  tier's 1 GiB. **Database** is mostly fixed overhead, so it only ever warns. Bookmarks are your
  data and are never pruned automatically.
- **Auto-prune.** By default, when new audio would take storage past 90%, the oldest briefs' audio
  is removed first, down to 80% (minus the new file). The markdown of a pruned brief stays, and each
  person's newest four briefs are never touched. The file is deleted before the row is marked, so a
  half-finished prune cannot hide a file from later passes.
- **On demand.** The warning's "Free up space" button previews (dry run) and runs that cleanup for
  your own briefs.
- **If it cannot make room**, the finalize route answers 507 with a message naming the knobs.
  If usage cannot be measured at all (say the capacity migration is not applied), it logs and lets
  the upload proceed, since a gap in monitoring should not become the wall it guards against.

Four optional env vars tune it:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STORAGE_LIMIT_BYTES` | 1 GiB (1073741824) | Storage the warning and pruning are measured against |
| `DATABASE_LIMIT_BYTES` | 500 MiB (524288000) | Database size for the warning only |
| `AUTO_PRUNE_AUDIO` | `true` | `false` only warns, and audio uploads are then refused when storage is full |
| `KEEP_RECENT_AUDIO` | 4 | Newest briefs per person whose audio is never pruned |

A mistyped value throws instead of silently falling back to the free-tier default, which would prune
a larger instance's audio.

## Connector (MCP)

An AI assistant (Grok, Claude, ChatGPT, Cursor, or any agent with an
[MCP](https://modelcontextprotocol.io) client) can search the library, read briefs and start new ones
through one HTTP endpoint. [docs/mcp-connector.md](docs/mcp-connector.md) is the original design and
the reasoning behind it. Where it and the code differ, the code is right, and the list at the end of
that file says where. For setup, see the [README](README.md#works-with-your-ai-assistant) and
[SETUP.md](SETUP.md#connecting-an-assistant-mcp).

### Endpoint

`POST /api/mcp` (`src/app/api/mcp/route.ts`) is served by
[`mcp-handler`](https://github.com/vercel-labs/mcp-handler) 2.x on the
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 2.x, both pinned to exact
versions because they are young. It is stateless Streamable HTTP: every request stands alone, with
no session and no Redis. It speaks the 2026-07-28 revision of the protocol natively and falls back
for 2025-era clients. `maxDuration` is 300 seconds, though tool calls are short; the long work runs in
background jobs (below).

- **Bearer only, never cookies.** The route accepts `Authorization: Bearer <token>` and nothing else.
  It does not read the session cookie, so a page open in your browser cannot make it act for you and
  there is no CSRF surface. Every request looks the token up (`verifyApiToken`), so a revoked or
  expired token, or one whose owner is no longer allowed (`users.is_allowed`), stops working at once.
- **The 401 challenge.** A missing or unknown token gets a 401 with an RFC 9728 `WWW-Authenticate`
  header naming the protected resource metadata. Its address is built from `APP_URL`, never from the
  request's `Host` or `X-Forwarded-*` headers, because clients compare it with the address they
  connected to. An authenticated `GET` or `DELETE` answers 405, as a stateless server does.
- **Content is not instructions.** The server's `instructions` and every tool description tell the
  model that bookmark text, summaries, briefs, topic names and titles were written by other people
  (or by the model from their posts) and are information to report, never directions to follow.
  Topic names and episode titles are cut to 120 characters in every tool's output. The server cannot
  control what a client's model does with them, and it never acts on tool output itself.

### Tokens

`src/lib/api-tokens.ts` and the `api_tokens` table.

- A token is `bg_` plus 32 random bytes in base64url. The table keeps only its SHA-256 hex
  (`token_hash`, unique) and the first eight characters (`prefix`) for display. The token is 256 bits
  of randomness, so a fast hash is right: there is nothing to brute-force. The plaintext is returned
  once, by the create call, and never logged or put in an error message.
- **Scopes.** `read` covers search, listing, reading and status checks and the episode links.
  `write` adds `generate_brief` and `hide_bookmark`, and implies `read`. A token may expire (the
  panel offers 90 days) and is revoked by setting `revoked_at`. `last_used_at` is rewritten at most
  every five minutes, so a chatty client does not turn every call into a write. A person can hold 25
  active tokens, checked when one is created in the panel and when a sign-in mints one.
- **Management is cookie-only.** `GET` and `POST /api/tokens` and `DELETE /api/tokens/[id]` accept the
  session cookie and never a bearer token, so a leaked token cannot mint, list or revoke tokens. The
  Assistants panel on the dashboard (`src/app/assistant-settings.tsx`) is their only client. It shows
  the connector URL, the token list, the create form and the one-time reveal.
- `getUserIdFromRequest` in `src/lib/auth.ts` is the helper for routes an assistant may share with
  the browser: the session cookie first, then a bearer token with the needed scope. The MCP route
  skips it and uses the bearer alone.

### OAuth sign-in

Web chat products (claude.ai, ChatGPT, grok.com connectors) cannot be given a static header, so the
app is also a small OAuth 2.1 authorization server for its own tokens
(`src/lib/oauth.ts`, `src/app/oauth/**`, `src/app/.well-known/**`).

- **Discovery.** RFC 9728 protected resource metadata and RFC 8414 server metadata, plus the same
  server document at `/.well-known/openid-configuration` and the resource document at its
  path-insertion address, since clients try different ones. Everything is built from `APP_URL`.
- **Registration.** Dynamic client registration (RFC 7591) at `/oauth/register`, for public clients
  only: no secret is issued, and the only token endpoint auth method is `none`. It is open to anyone,
  so a flood must not lock real clients out: each registration first prunes registrations that never
  got a code or a token after an hour, and fully revoked ones after 30 days
  (`prune_oauth_clients()`). At 1,000 clients it evicts the oldest one with no live token
  (`evict_oauth_client()`, at most five per registration), and answers 503 only when every client is a
  live connection. A body declared over 64 KB is refused with 413 before it is read, here and at
  `/oauth/token`. Redirect URIs must be `https`, `http` on a loopback host, or an app scheme such as
  `cursor://`. They match exactly, except that a loopback URI may use any port.
- **Client ID Metadata Documents.** A client may skip registration and send the https URL of a JSON
  document about itself as its `client_id` (draft-ietf-oauth-client-id-metadata-document, advertised
  as `client_id_metadata_document_supported`); this is "Claude's published identity" in claude.ai.
  The authorization request fetches that document under the SSRF guard in `src/lib/ssrf.ts` (every
  resolved address must be public, no redirects, 5 seconds, 5 KB), checks it like a registration
  plus an exact `client_id` match and no client secret, and caches a valid one in memory for five
  minutes. Approving writes an `oauth_clients` row keyed by the URL, so codes, tokens, revocation and
  pruning work as for a registered client, and the token endpoint never fetches anything.
- **Authorization.** `GET /oauth/authorize` is a route handler, so it can answer with real status
  codes. It never redirects to the client before the user has acted, because anyone can register a
  client with any redirect URI and an automatic error redirect would make the app an open redirector
  (RFC 9700 section 4.11). Every invalid request gets a 400 error page in the app's own wording; when
  the client and redirect URI check out, the page offers a plain "Return to *host*" link carrying
  `error`, `error_description`, `state` and `iss` for the user to click. A missing X session goes to
  sign-in and returns. Otherwise it redirects to the consent page, `/oauth/authorize/consent`, which
  checks everything again. PKCE with `S256` is required.
- **Consent.** The page shows which client is asking (with the host that published its metadata
  document, for a URL `client_id`), the scopes, the account and where you will land, and warns when
  that is a program on this computer. Its form posts one hidden field to `/api/oauth/decision`: the validated request plus the
  user's id, sealed with an HMAC under `SESSION_SECRET` (with a purpose prefix, so it cannot pass for
  a session or gate signature) and valid for ten minutes. Editing the form cannot change what was
  approved, and the decision route checks the same-origin header, the signed-in user, the client and
  its redirect URI once more. Its two redirects, the code on approve and `access_denied` on deny, are
  the only ones to a client, both follow a click, and both carry `iss` (RFC 9207, advertised as
  `authorization_response_iss_parameter_supported`).
- **Codes and tokens.** Approve stores a single-use code (hashed, five minutes) next to the PKCE
  challenge, redirect URI and scopes. `POST /oauth/token` trades the code and its verifier for an
  ordinary `api_tokens` row (30 days, tagged with the client's id) and a rotating refresh token
  (`bgr_` plus 32 random bytes, stored hashed on the same row). The request that flips `used_at`
  wins, and a replayed code is refused and revokes the token it produced (RFC 6749 section 4.1.2:
  the code may have leaked). Before minting, the client's earlier live tokens for that user are
  revoked (one connection per client per user), and the new one must fit under the 25-active-token
  cap like a panel token. A refresh rewrites the same row with a new access token and a new refresh
  token, so the old pair dies together and the panel shows one entry per connected client, and keeps
  the replaced refresh token's hash: presenting that one again revokes the row (RFC 9700 section
  4.14.2). A refresh after 90 days without use (no API call and no refresh) is refused. Scopes may
  narrow on a refresh, never widen. Codes and tokens are never logged or echoed in errors.

### Tools

Seven tools in `src/lib/mcp/tools.ts`, each a plain function of the caller and its input, so tests
drive them without the handler. Their descriptions are the only documentation the model sees, so each
says what it costs, what its dates mean and that post text is content.

| Tool | Scope | What it does |
| --- | --- | --- |
| `search_bookmarks` | read | Every word of `query` must appear in the post text, its summary, or the author's handle or name. Filters: topics, post dates (the post's own date, as the dashboard uses), and `credibility: "flagged"`. Newest post first, post text cut to 500 characters, 1 to 50 results. Reads at most the newest 1,000 visible bookmarks. |
| `list_topics` | read | The dashboard's topic chips with counts, for an optional date range. Names cut to 120 characters. |
| `list_episodes` | read | Ready briefs, newest first, with stable `links`. Titles cut to 120 characters. |
| `get_episode` | read | One ready brief, with its markdown (cut at 60,000 characters, with a `truncated` flag) and optionally the script. |
| `get_brief_status` | read | A background job's status, stage and progress, or the newest job for an episode. With a write token it also restarts a stalled job and says so in `rescheduled`; a read-only token only gets the report, since restarting resumes paid work. |
| `generate_brief` | write | Validates like the prepare route, runs the free selection check (an empty match answers at once and spends nothing), queues a job and returns a `job_id`. |
| `hide_bookmark` | write | The same update as `POST /api/bookmarks/hide`. |

`runTool` puts one guard in front of every call: the `mcp_call` cap, then the write-scope check, then
the tool, then error mapping. Every failure becomes an MCP tool error (`isError`) with a message safe
to show, not an HTTP error, and a read-only token that calls a write tool is told how to get write
access. Results come back as JSON text and as `structuredContent`.

**The `mcp_call` cap.** Each tool call records one `mcp_call` usage event through `record_usage()`,
default 1,000 per person per rolling 24 hours (`LIMIT_MCP_CALL_PER_DAY`). It brakes a runaway client
and is not a spend cap. Paid actions keep their own caps (`digest_prepare`, `digest_script`,
`digest_render`, `sync`, `enrich`), drawn from the same per-person pool as the dashboard, so a leaked
token cannot spend more than its owner could by clicking.

### Background brief jobs

The dashboard drives generation from the browser: prepare, script, a render loop, finalize. An
assistant cannot sit in that loop, and MCP clients give up on a tool call after seconds. So the four
stages live in `src/lib/digest.ts` as plain functions (the `/api/digest/*` routes are thin wrappers
around them, with the same guards and caps), and `src/lib/jobs.ts` drives them on the server, one
`brief_jobs` row per request.

- **Queue.** `generate_brief` inserts a `queued` job and schedules the runner with `after()` from
  `next/server`, which runs a callback once the response has been sent, for up to the route's
  `maxDuration`. The tool answers within a second.
- **Lease.** The runner starts by calling the Postgres function `claim_brief_job(job, stale_seconds)`,
  which in one statement flips `queued` to `running`, or takes over a `running` job whose
  `heartbeat_at` is older than the stale window (90 seconds, `BRIEF_JOB_STALE_SECONDS`). Two runners
  racing for one job cannot both win; the loser gets no row and stops. This is the single-generation
  lease the roadmap listed as deferred, for assistant-started briefs only.
- **Fencing.** Each claim stamps a fresh `lease_id`, and every write the runner makes (stage,
  heartbeat, progress, episode, outcome) is filtered on it and checks that it matched a row. A runner
  that was slow rather than dead, and was taken over, finds its next write matching nothing and stops
  there without writing anything more, so the new lease holder's progress stands.
- **Heartbeat.** The runner bumps `heartbeat_at` at every stage change and after every rendered
  chunk, and a timer beats three times per stale window, so one long paid call, such as the writing
  pass, does not look dead. The timer's writes are fenced too, and it stops once the lease is gone.
  It dies with the process, which is what lets a cut-off run go stale.
- **Access checks.** Right after the claim and before every paid step (sync, the writing pass, the
  script, each rendered chunk, finalize), the runner checks that the token that started the job is
  still live and its owner still allowed. Otherwise the job fails with "The token that started this
  brief was revoked" or "This account can no longer use this server", so revoking a token stops the
  briefs it started too.
- **Resume from persisted state.** A re-claimed job works out where to continue from the episode,
  the way the dashboard's Resume banner does (`deriveDigestStage`). No script yet means write one.
  Some chunks rendered means continue from the last one. All chunks rendered means finalize. So it
  never pays twice for a script or a chunk that landed. A run cut off after syncing does not sync
  again, and a job whose draft was discarded fails instead of starting, and billing, a new brief.
  One window remains: a job that dies between the Grok writing pass and the episode insert pays for
  that pass again, a gap of a few hundred milliseconds.
- **Stages and status.** `syncing` (only with `sync_first`), `selecting`, `writing`, `scripting`,
  `rendering`, `publishing`, then `done` or `failed`. A failed job carries the same public message the
  `/api/digest/*` routes would show, and leaves the episode as a `draft` for the dashboard's Resume
  banner. `brief_jobs.token_id` records which token started a job and has no foreign key, so a job
  record outlives a revoked token.
- **Dashboard interplay.** A job works on its own episode row, so it never collides with a brief
  generated in a tab. A job that is mid-render shows up as a draft in the Resume banner.

**The host difference.** What one run achieves depends on the host:

| Host | What happens |
| --- | --- |
| [Render](https://render.com) or any long-lived Node process | The `after()` callback runs to the end. The whole job finishes in one run: around 3 minutes for markdown, 12 for a podcast. One status check finds it done. |
| [Vercel](https://vercel.com) or any host that ends a request's background work early | The callback is cut off at `maxDuration` (300 seconds), mid-render. The heartbeat goes stale, and the next `get_brief_status` call from a write token re-claims the job and continues from the last rendered chunk. A podcast takes a few checks. |

So on a request-bound host, polling with a write token is what keeps a job alive, and the tool
description tells the model so. [ROADMAP.md](ROADMAP.md) has the follow-up that removes that dependence.

### Stable episode links

`signEpisodeUrls` mints 24-hour signed URLs, and an assistant pastes links into chats that last
longer. `GET /api/episodes/[id]/audio` and `/markdown` authenticate with the session cookie or a bearer
token with `read` scope, check that the episode is the caller's and is `ready`, and answer 302 to a
fresh one-hour signed URL. The links in tool output are always these routes. A browser with no
session is redirected to `/` to sign in, an API caller gets a 401, and audio that was pruned to free
space is a 404 that says so. The dashboard keeps using signed URLs directly.

### What the password gate leaves open

With `GATE_PASSWORD` set, `src/proxy.ts` still lets through `/api/mcp`, `/oauth/*`,
`/api/oauth/decision` and `/api/episodes/<id>/audio|markdown`, as well as the older `/gate`,
`/api/gate`, `/api/cron/` and `/icon`. Each carries its own lock (a bearer token, the X sign-in, the
signed consent, a cron secret), and the gate was never access control. `/.well-known/…` is never
gated because the proxy matcher skips any path containing a dot. A blocked page remembers where it was
going (`/gate?next=…`), and X sign-in has its own return path (`/api/auth/login?next=…`, kept in a
cookie), so an OAuth sign-in survives a gated instance. Both accept only paths on this app
(`src/lib/return-path.ts`). [SETUP.md](SETUP.md#what-the-password-gate-leaves-open) has the table.

## Security measures

- **Login allowlist.** `ALLOWED_X_USER_IDS` gates login. Empty means personal mode (whoever
  completes X OAuth is allowed). Set it to a comma-separated list of X user IDs to lock the instance
  down. A user who signs in but is not on the list is stored with `is_allowed = false` and turned
  away.
- **Site password gate (optional).** `src/proxy.ts` puts every route, including the landing page,
  behind a shared password when `GATE_PASSWORD` is set. Unset, there is no gate, in development and
  production alike: the login allowlist above is the access control that matters, and the gate is an
  extra layer for keeping an instance unlisted. The cron path, the gate page itself and the favicon
  stay reachable, and so do the assistant connector's endpoints, each of which carries its own lock
  (see [Connector (MCP)](#connector-mcp)).
- **Session.** The cookie is HMAC-signed (`SESSION_SECRET`), httpOnly, `SameSite=Lax` and
  secure-flagged in production, with a 30-day lifetime. Signatures are checked in constant time.
- **Database access.** Supabase is only ever touched server-side with the service-role key. Row-level
  security is deny-all, so the browser has no direct access. The `episodes` bucket is private.
- **Encryption at rest.** X tokens and per-user voice keys are AES-256-GCM encrypted under
  `APP_ENCRYPTION_KEY`, in the format `iv.tag.ciphertext`. Voice keys are only used server-side and
  shown back as their last 4 characters at most.
- **OAuth hygiene.** PKCE with a single-use `state`. Redirect codes after sign-in are a fixed
  closed set, never built from an error message, so nothing sensitive reaches a URL.
- **Cron endpoint.** `/api/cron/sync` fails closed. With no `CRON_SECRET` it returns 503 rather than
  running unauthenticated, and a wrong bearer token gets 401. A deployed instance cannot be made to
  spend X or Grok credits by anyone who finds the URL.
- **SSRF hardening** (`src/lib/ingest.ts`). Article fetching only accepts `http` and `https`. It
  rejects loopback, private, link-local and unspecified addresses in IPv4 and IPv6 (including
  unique-local `fc00::/7` and IPv4-mapped forms like `::ffff:127.0.0.1`), plus `localhost`,
  `.local` and `.internal` names. For real hostnames it resolves DNS and rejects the URL if any
  returned address is private. Redirects are followed manually (at most 5, loop-checked), with the
  full check repeated on every hop, and a 15-second deadline covers the whole fetch. A small
  DNS-rebinding window remains and is tracked in [ROADMAP.md](ROADMAP.md).
- **Spend caps** (`src/lib/limits.ts`). Rolling 24-hour per-user caps on every paid action,
  enforced atomically in Postgres (`record_usage()`), so a parallel burst cannot overshoot. Defaults
  per day: `sync` 24, `enrich` 400, `digest_prepare` 12, `digest_script` 40, `digest_render` 500,
  `voice_list` 120, `voice_preview` 60, and `mcp_call` 1,000 (assistant tool calls, a brake rather
  than a spend cap). Override with `LIMIT_<KIND>_PER_DAY`, for example `LIMIT_SYNC_PER_DAY`. The scheduled cron sync is exempt: it has its own bearer secret and runs
  once per user per invocation.
- **Assistant access.** `/api/mcp` takes bearer tokens only, never the cookie. Tokens are hashed at
  rest, scoped, revocable at once and managed only with the session cookie. Sign-in uses PKCE,
  single-use codes, rotating refresh tokens with reuse detection, an HMAC-sealed consent, and no
  redirect to a client before the user acts. See
  [Connector (MCP)](#connector-mcp).
- **Input and error handling.** Voice keys and ids are validated (printable ASCII, URL-safe ids)
  and never echoed or logged. Route errors log full detail server-side and show the client only a
  generic message in production.

## Scheduled jobs

| Job | Where | Schedule | What it does |
| --- | --- | --- | --- |
| Weekly sync | [Render](https://render.com) cron (`render.yaml`) or [Vercel](https://vercel.com) Cron (`vercel.json`) | Fridays 12:00 UTC | Calls `GET /api/cron/sync` with `Authorization: Bearer $CRON_SECRET`: sync, ingest and enrich for every allowed user |
| Community Notes | [GitHub Actions](https://docs.github.com/actions) (`.github/workflows/community-notes.yml`) | Daily 06:30 UTC, or run by hand | Streams X's public notes dataset, matches your bookmarked post ids, writes matches to `community_notes` |

The Community Notes job needs two repository secrets, `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. Until it runs, everything works. Posts just do not carry Community Notes
flags yet. Its `Authorization: Bearer` header carries the service-role key, so use the legacy
`service_role` JWT for it (see [SETUP.md](SETUP.md)).

## Cost analysis

Prices as of October 2026. All numbers below were measured or taken from vendor price lists.

- **X reads.** Pay-per-use. Bookmark reads are billed at $0.001 per post. A first sync (~800 posts)
  costs under a dollar. Each later sync re-reads the whole list, because the app does not yet stop
  paginating early (a backlog item), so a sync of N bookmarks costs about N × $0.001. That is a few
  cents for a small library and at most about $0.80 for a full 800.
- **Supabase storage.** A 15-minute brief's MP3 is about 13.5 MB, so the free tier's 1 GiB holds
  roughly 70 briefs before pruning starts (see [Capacity and pruning](#capacity-and-pruning)). The
  500 MiB database is plenty.
- **Grok.** The two-tier model blend exists specifically for token efficiency (see
  [Grok model blend](#grok-model-blend)). A full sync plus a weekly digest is typically well under
  $1 in xAI usage.
- **Voice (audio briefs and video transcription).** Unlike the Grok LLM blend, there is no cheap
  tier for speech. Every character spoken is billed the same regardless of how "smart" it needs to
  be, so the provider you pick is the cost lever. Measured on real episodes (~15 minutes of audio,
  ~11,500 to 13,800 spoken characters, 31 to 43 dialogue lines; pricing as of October 2026):

  | Voice provider | Billing | Per ~15-minute episode |
  | --- | --- | --- |
  | **Grok Voice** | $15 per 1M characters, pay-as-you-go on the same xAI credits as the LLM calls (no subscription) | ~$0.20, under $1/month for a weekly brief |
  | **ElevenLabs, Creator plan** | $22/month for 121,000 credits; Turbo bills 0.5 credits per character | ~6,000 to 7,000 credits, about $1.25. A weekly brief uses roughly a quarter of the plan |
  | **ElevenLabs, usage-based** | $0.04 per 1,000 characters (Turbo) | ~$0.55 |

  Video transcription is much smaller either way, and only runs on bookmarks that contain video.
  Grok STT is $0.10/hour (REST). ElevenLabs Scribe v2 is $0.22/hour. ElevenLabs defaults to the
  turbo model (`eleven_turbo_v2_5`, override with `ELEVENLABS_MODEL`) to stretch a plan further,
  and its `previous_text` and `next_text` prosody hints are not billed. The trade-off for Grok's
  price: it has no equivalent of those continuity hints, so each line is rendered standalone, so
  listen to a sample before committing. The instance default is `VOICE_PROVIDER` (`grok` or
  `elevenlabs`; unset, it is ElevenLabs when `ELEVENLABS_API_KEY` is set, otherwise Grok, since the
  app requires `XAI_API_KEY` anyway; see [SETUP.md](SETUP.md) step 4). Users can override it in the
  app, and a user's own key is billed to their account.

## Testing

Unit tests ([Vitest](https://vitest.dev), `npm test`, files in `src/lib/__tests__/`) cover the pure library logic and the
route handlers: encryption and signing, X's PKCE and authorize URL, SSRF host checks,
article and video ingestion, MP3 header stripping and stitching, TTS chunking, voice provider
resolution, listing and error mapping, per-user voice settings, capacity and pruning arithmetic, the
prepare, render and finalize routes, episode shaping, dashboard text, and the setup script's
parsing and migration logic.

The connector has its own tests: tokens, the tools against the fake database, the OAuth endpoints, the
job runner (the lease, resuming, failures) and the proxy's open paths. One drives a real MCP
`initialize`, `tools/list` and `tools/call` through the route handler with a minted token.

Route tests run against a small in-memory stand-in for the Supabase client
(`src/lib/__tests__/fake-db.ts`) with vendors stubbed, so no test touches the network or a real
database.

One test file is skipped by default. `voice.smoke.test.ts` is a real-API round trip (two Grok
hosts to one stitched MP3, then transcripts). It only runs when `VOICE_SMOKE` is set and costs well
under a cent. The comment at the top of the file shows how to run it without leaking secrets into
your shell.

The full pipeline against real services (X sync, ingestion, Grok synthesis, rendering) is checked by
running it, not by mocks: `scripts/run-pipeline.ts` runs sync, ingest and enrich without the web
UI, and `npm run setup -- --check` verifies a live configuration.

Before opening a pull request, run `npm test`, `npx tsc --noEmit` and `npm run lint`. See
[CONTRIBUTING.md](CONTRIBUTING.md).
