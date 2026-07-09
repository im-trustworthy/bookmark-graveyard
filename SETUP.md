# Bookmark Brief — Setup Guide

Everything is built and the database is provisioned. You need to fill in **5 secrets** in
[.env.local](.env.local) (about 20–30 minutes, one-time). Work through the steps in order.

## 1. Supabase service role key (2 min)

The project `bookmark-brief` is already created with the full schema.

1. Open https://supabase.com/dashboard/project/your-project-ref/settings/api-keys
2. Reveal the **service_role / secret** key and paste it into `.env.local` as
   `SUPABASE_SERVICE_ROLE_KEY`. (This key stays server-side only — never commit `.env.local`.)

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

## 4. ElevenLabs (5 min)

1. Go to https://elevenlabs.io → your profile → **API Keys** → create a key.
2. Paste it into `.env.local` as `ELEVENLABS_API_KEY`.
3. Pick two host voices: open **Voices → Explore/My Voices**, choose one conversational
   female + one male voice (the premade **Rachel** and **Adam** are a good pair), click each
   voice → **ID** to copy its voice ID. Paste them as `ELEVENLABS_VOICE_HOST_A` (Alex, the
   curious host) and `ELEVENLABS_VOICE_HOST_B` (Blake, the analyst).

**Quota note**: your Creator plan (~100k credits/mo) renders roughly 3–4 hours of audio with
the turbo model this app uses by default. A weekly ~20-minute brief fits comfortably.

## 5. Run it

```bash
npm run dev
```

Open http://localhost:3000 → **Sign in with X** (bookmarks sync automatically on first login) →
set filters → **Create my brief**. First sync pulls up to your 800 most recent bookmarks (an X API
limit); after that, **Re-sync** keeps growing your library beyond 800.

## Optional: Community Notes fact-check job

Bookmarks are cross-checked against X's public Community Notes dataset (there is no API for
reading notes on arbitrary posts). A daily GitHub Actions job does the matching:

1. Push this repo to GitHub.
2. In the repo → **Settings → Secrets and variables → Actions**, add:
   - `SUPABASE_URL` = `https://your-project-ref.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = same key as step 1
3. The workflow (`.github/workflows/community-notes.yml`) runs daily at 06:30 UTC; you can
   also trigger it manually from the Actions tab.

Until this job runs, everything works — posts just won't carry Community-Notes flags yet.

## Optional: deploy + weekly automation (Vercel)

1. Push to GitHub → import the repo at https://vercel.com → add every variable from
   `.env.local` (update `APP_URL` to your production URL) plus a random `CRON_SECRET`.
2. Add the production callback URL to your X app (step 2.4).
3. `vercel.json` already schedules a bookmark sync every Friday; generate briefs on demand
   from the UI, then download or listen in the browser.

## Multi-user later

Set `ALLOWED_X_USER_IDS` to a comma-separated list of X user IDs to control who can log in
(empty = anyone who logs in is allowed — fine while it's just you locally).
