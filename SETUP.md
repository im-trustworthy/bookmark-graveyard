# Bookmark Brief — Setup Guide

**Four accounts, one command.** Supabase, an X developer app and xAI are required; ElevenLabs is
optional, since audio briefs can run on your xAI key instead (step 4). Fill in
[.env.local](.env.local) from steps 1–4 (about 20–25 minutes, one-time), then run `npm run setup`
(step 5): it checks every value, generates the two app secrets, and creates the database.

## 1. Supabase (5 min)

1. Create a free project at https://supabase.com (any name and region).
2. Open **Settings → API Keys**
   (`https://supabase.com/dashboard/project/<your-project-ref>/settings/api-keys`). Copy the project
   URL (`https://<your-project-ref>.supabase.co`; the ref is in the dashboard address) into
   `.env.local` as `NEXT_PUBLIC_SUPABASE_URL`, then reveal the **service_role / secret** key and
   paste it as `SUPABASE_SERVICE_ROLE_KEY`. (This key stays server-side only — never commit
   `.env.local`.)
3. Optional: create a personal access token at https://supabase.com/dashboard/account/tokens and add
   it to `.env.local` as `SUPABASE_ACCESS_TOKEN` (the variable the Supabase CLI uses), so that
   `npm run setup` can create the tables for you in step 5. Only that command uses it: never set it
   on your host.

## 2. X developer app (10–15 min)

1. Go to https://developer.x.com and sign in with your X account.
2. Sign up for **pay-per-use** access (the default for new developers) and add a small credit
   balance — bookmark reads are $0.001/post, so **$5 covers months** of weekly syncs.
3. Create a **Project + App** (any names, e.g. "Bookmark Brief").
4. In the app's **User authentication settings**, click **Set up** and configure:
   - **App permissions**: Read
   - **Type of App**: *Web App, Automated App or Bot* (confidential client)
   - **Callback URI**: `http://localhost:3000/api/auth/callback/x`
     (add your production URL later, e.g. `https://yourapp.vercel.app/api/auth/callback/x`)
   - **Website URL**: anything valid (your X profile URL works)
5. Save — you'll be shown the **OAuth 2.0 Client ID and Client Secret**. Paste them into
   `.env.local` as `X_CLIENT_ID` and `X_CLIENT_SECRET`.

## 3. xAI (Grok) key (2 min)

1. Go to https://console.x.ai → **API keys** → create a key.
2. Paste it into `.env.local` as `XAI_API_KEY`.
3. Your existing credits cover this; a full sync + weekly digest is typically well under $1.

The app uses a two-tier model blend for token efficiency (overridable in `.env.local`):
- `XAI_MODEL_FAST` (default `grok-4.20-0309-non-reasoning`) — per-post categorization,
  image reading (vision), staleness checks
- `XAI_MODEL_SMART` (default `grok-4.5`) — digest outline, composition, and podcast script

## 4. Choose a voice provider (audio briefs and video transcription)

Audio briefs (the two-host podcast) and video transcription need a voice provider; markdown briefs
work without one. The server-side settings below are the **instance defaults (optional)**: every
user gets them until they pick their own in the app (see "Or connect in the app" below), and
per-user settings override them. Pick **one** default provider with `VOICE_PROVIDER=grok` or
`VOICE_PROVIDER=elevenlabs` in `.env.local`. If `VOICE_PROVIDER` is unset, ElevenLabs is used when
`ELEVENLABS_API_KEY` is set, otherwise Grok (`XAI_API_KEY` is required by the app anyway). If the
chosen provider is misconfigured, audio briefs are rejected with a message naming the variable to
fix, and videos fall back to a thumbnail description instead of a transcript.

**Option A — Grok Voice (recommended default).** Nothing extra to set up: it reuses the
`XAI_API_KEY` from step 3 and bills pay-as-you-go on the same xAI credits — no second account, no
subscription. A ~15-minute episode costs about $0.20 (Grok TTS is $15 per million characters), so
under $1/month for a weekly brief; video transcription is $0.10/hour.

1. Leave `VOICE_PROVIDER` unset, or set `VOICE_PROVIDER=grok`. (Set it explicitly if `.env.local`
   also has an `ELEVENLABS_API_KEY` — ElevenLabs wins when the provider is left on auto.)
2. Optional: pick different host voices with `GROK_VOICE_HOST_A` (Alex, the curious host; default
   `ara`) and `GROK_VOICE_HOST_B` (Blake, the analyst; default `helios`). The built-in list is
   `GET https://api.x.ai/v1/tts/voices` — 28 voices:
   - female: ara, aurora, carina, celeste, eve, iris, liora, luna, ursa
   - male: altair, atlas, castor, cosmo, helios, helix, kepler, leo, lumen, lux, naksh, orion,
     perseus, rex, rigel, sal, sirius, zagan, zenith
3. Optional: want your own voice? xAI clones one from a reference clip of up to 120 seconds (90
   seconds or more recommended) for free (up to 30 per team; US only, except Illinois) via
   `POST https://api.x.ai/v1/custom-voices` (the app's voice list shows custom voices only when
   you're on your own key).

**Heads-up**: Grok has no equivalent of ElevenLabs' neighboring-line continuity hints, so each
line is rendered standalone — generate one short brief and listen before committing.

**Option B — ElevenLabs (5 min).** Its own account and billing.

1. Go to https://elevenlabs.io → your profile → **API Keys** → create a key.
2. Paste it into `.env.local` as `ELEVENLABS_API_KEY`.
3. Pick two host voices: open **Voices → Explore/My Voices**, choose one conversational
   female + one male voice (the premade **Rachel** and **Adam** are a good pair), click each
   voice → **ID** to copy its voice ID. Paste them as `ELEVENLABS_VOICE_HOST_A` (Alex, the
   curious host) and `ELEVENLABS_VOICE_HOST_B` (Blake, the analyst).
4. Set `VOICE_PROVIDER=elevenlabs` to be explicit (with `ELEVENLABS_API_KEY` set and
   `VOICE_PROVIDER` unset, ElevenLabs is picked automatically). The two voice IDs are required
   only for rendering audio; video transcription (ElevenLabs Scribe v2) needs just the API key.

**Quota note**: the Creator plan ($22/month, 121,000 credits) renders roughly 4–5 hours of
audio — 15+ episodes — with the turbo model this app uses by default (`eleven_turbo_v2_5`,
override with `ELEVENLABS_MODEL`). It bills 0.5 credits per character, so a ~15-minute episode is
~6,000–7,000 credits (about $1.25) and a weekly brief uses roughly a quarter of the plan. Prefer
pay-as-you-go? ElevenLabs' usage-based Turbo rate is $0.04 per 1,000 characters (~$0.55 per
episode); Scribe v2 transcription is $0.22/hour.

**Or connect in the app.** The dashboard's **Voices** section (under Filters) shows the current
provider and host voices; **Change** opens a panel to pick Grok Voice or ElevenLabs, optionally
paste your own API key (needed only if the server has none for that vendor), load its voice list,
preview any voice with a one-sentence sample, and save Host A / Host B. Your key is stored
AES-256-GCM-encrypted (`APP_ENCRYPTION_KEY`, like the X tokens), shown back only as its last 4
characters, and its usage is billed to you. **Use instance defaults** removes your settings.

**Hosted or multi-user instance?** Leave `ELEVENLABS_API_KEY` unset and each user who wants
ElevenLabs brings their own key ("bring your own key": billed to them, so no ElevenLabs spend for
you). Grok Voice has no key of its own to leave out: it uses your `XAI_API_KEY`, which the Grok LLM
work needs anyway, so it is billed to your xAI account unless the user pastes their own xAI key in
the panel.

## 5. Create the database and check everything (1 min)

```bash
npm run setup                # safe to re-run, e.g. after an update
npm run setup -- --yes       # same, but applies pending migrations without asking
npm run setup -- --check     # read-only: writes no files, applies nothing
```

Setup creates `.env.local` from `.env.example` if needed, generates `APP_ENCRYPTION_KEY` and
`SESSION_SECRET` when blank, and flags missing required values. It provisions the database from
`supabase/migrations/`: with `SUPABASE_ACCESS_TOKEN` it applies pending migrations after a y/N
prompt; without one it writes the schema to a SQL file for a brand-new project and prints your
SQL-editor link to paste it into. Last, it verifies the tables and private `episodes` bucket, checks
the xAI/ElevenLabs keys with free calls, and prints the X callback URL to register.

## 6. Run it

```bash
npm run dev
```

Open http://localhost:3000 → **Sign in with X** (bookmarks sync automatically on first login) →
optionally pick your podcast voices in the **Voices** section under Filters (step 4) → set filters →
**Create my brief**. First sync pulls up to your 800 most recent bookmarks (an X API limit); after
that, **Re-sync** keeps growing your library beyond 800.

## Optional: Community Notes fact-check job

Bookmarks are cross-checked against X's public Community Notes dataset (there is no API for
reading notes on arbitrary posts). A daily GitHub Actions job does the matching:

1. Push this repo to GitHub.
2. In the repo → **Settings → Secrets and variables → Actions**, add:
   - `SUPABASE_URL` = `https://<your-project-ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = same key as step 1
3. The workflow (`.github/workflows/community-notes.yml`) runs daily at 06:30 UTC; you can
   also trigger it manually from the Actions tab.

Until this job runs, everything works — posts just won't carry Community-Notes flags yet.

## Deploy on Render (password-protected)

The app ships with a site-wide password wall (`src/proxy.ts`): every visitor gets a
password prompt before anything — even the landing page — is served. The X-OAuth
allowlist still protects the actual data behind it.

Run `npm run setup -- --check` locally first. On Render the migrations are already applied to your
Supabase project (step 5), so nothing runs there.

1. Push this repo to GitHub, then in the [Render dashboard](https://dashboard.render.com):
   **New + → Blueprint** → pick this repo. `render.yaml` creates the web service plus the
   weekly Friday sync cron.
2. Render prompts for the env vars: paste every value from `.env.local` (except
   `SUPABASE_ACCESS_TOKEN`, which only `npm run setup` uses), plus
   - `GATE_PASSWORD` — the site password (share it with whoever should get in)
   - `CRON_SECRET` — any long random string (protects `/api/cron/sync`)
   - `APP_URL` — the public URL, e.g. `https://your-app.onrender.com`
   - `VOICE_PROVIDER` — `grok` or `elevenlabs` (step 4). Set it explicitly on Render: left unset,
     any value in `ELEVENLABS_API_KEY` makes ElevenLabs the auto-selected provider. The optional
     `GROK_VOICE_HOST_A` / `GROK_VOICE_HOST_B` default to `ara` / `helios`, and the three
     `ELEVENLABS_*` values are only needed when ElevenLabs is the provider (set explicitly, or
     auto-selected because `ELEVENLABS_API_KEY` is present).
3. Custom domain (optional): web service → **Settings → Custom Domains** → add your domain
   (e.g. `bookmarks.example.com`), then add the CNAME Render shows you at your DNS provider.
4. Add `https://your-app.onrender.com/api/auth/callback/x` (or the same path on your custom
   domain) as a callback URI in your X app (step 2.4 above).
5. Set `ALLOWED_X_USER_IDS` to your own X user ID so the password isn't the only wall.

## Optional: deploy + weekly automation (Vercel)

1. Push to GitHub → import the repo at https://vercel.com → add every variable from
   `.env.local` except `SUPABASE_ACCESS_TOKEN` (update `APP_URL` to your production URL) plus a
   random `CRON_SECRET`.
2. Add the production callback URL to your X app (step 2.4).
3. `vercel.json` already schedules a bookmark sync every Friday; generate briefs on demand
   from the UI, then download or listen in the browser.

## Multi-user later

Set `ALLOWED_X_USER_IDS` to a comma-separated list of X user IDs to control who can log in
(empty = anyone who logs in is allowed — fine while it's just you locally).
