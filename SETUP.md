# Bookmark Graveyard — Setup Guide

**Four accounts, one command.** Supabase, an X developer app and xAI are required; ElevenLabs is
optional, since audio briefs can run on your xAI key instead (step 4). Fill in `.env.local` from
steps 1–4 (about 20–25 minutes, one-time), then run `npm run setup` (step 5): it checks every value,
generates the two app secrets, and creates the database.

Start with `cp .env.example .env.local`. You can host the finished app anywhere that runs Node 22+
and takes environment variables; see the deployment sections at the end. The short, illustrated
version of this guide is the [README](README.md).

## 1. Supabase (5 min)

1. Create a free project at https://supabase.com (any name and region).
2. Open **Settings → API Keys**
   (`https://supabase.com/dashboard/project/<your-project-ref>/settings/api-keys`). Copy the project
   URL (`https://<your-project-ref>.supabase.co`; the ref is in the dashboard address) into
   `.env.local` as `NEXT_PUBLIC_SUPABASE_URL`.
3. Open the **Legacy anon, service_role API keys** tab, click **Reveal** on the `service_role` row,
   and paste it as `SUPABASE_SERVICE_ROLE_KEY`. (This key stays server-side only — never commit
   `.env.local`.)

   ![Supabase API Keys page, Legacy anon, service_role tab: reveal the service_role key](docs/screenshots/supabase-legacy-keys.jpg)

   The dashboard opens on the **Publishable and secret API keys** tab first:

   ![Supabase API Keys page, Publishable and secret tab, which also lists a secret key](docs/screenshots/supabase-api-keys.jpg)

   **Which key?** Use the legacy `service_role` key. It is a JWT, which is the format every part of
   the project sends, including the optional GitHub job below. A newer `sb_secret_...` key from the
   first tab is also accepted by `npm run setup` (it sends that key the way Supabase requires) and
   the app hands it unchanged to Supabase's JavaScript client, but not every path has been tested
   with it. If you see 401 errors with one, switch to the legacy key. Do not click "Disable JWT-based API keys"
   while you rely on the legacy key. The app never uses the anon or publishable key.
4. Optional: create a personal access token at https://supabase.com/dashboard/account/tokens and add
   it to `.env.local` as `SUPABASE_ACCESS_TOKEN` (the variable the Supabase CLI uses), so that
   `npm run setup` can create the tables for you in step 5. Only that command uses it: never set it
   on your host.

**Free tier notes.** The free plan's 1 GiB of file storage holds about 70 briefs of podcast audio
(~13.5 MB each) before the app starts pruning the oldest audio automatically (the markdown always
stays); the 500 MiB database is plenty. Free projects pause after about a week without activity,
and the app errors until you unpause the project in the Supabase dashboard. A deployed instance's
weekly sync keeps it awake.

## 2. X developer app (10–15 min)

1. Go to https://console.x.com (the X Developer Console) and sign in with your X account.
2. Open **Billing → Credits** and click **Purchase credits**. The X API is **pay-per-use** (no
   monthly plan). Bookmark reads are $0.001 per post, so **$5 buys 5,000 post reads**. Leave Auto
   Recharge off if you want a hard stop when the balance runs out. These credits only pay for X
   API calls; Grok is billed separately in step 3.

   ![X Developer Console, Billing, Credits: Purchase credits button, balance and Auto Recharge off](docs/screenshots/x-console-credits.jpg)

3. Open **Apps → Create App** (any name, e.g. "Bookmark Graveyard"). The app page should say
   *Project Access: Default Project (Pay Per Use)*.
4. On the app page click **Settings** (top right) to open **Authentication settings**, and set:
   - **App permissions**: Read
   - **Type of App**: *Web App, Automated App or Bot* (confidential client)
   - **Callback URI / Redirect URL**: `http://localhost:3000/api/auth/callback/x`
     (add your production URL later, e.g. `https://yourapp.example.com/api/auth/callback/x`. It
     must be your `APP_URL` plus `/api/auth/callback/x`, character for character, including `http`
     vs `https` and any port)
   - **Website URL**: anything valid (your X profile URL works)

   Save the page.

   ![X Developer Console app Settings page: Read permission, Web App confidential client, callback URL](docs/screenshots/x-console-auth-settings.jpg)

5. Go back to the app page (**Back to Keys**) and open the **Keys & Tokens** tab. Under
   **OAuth 2.0 Keys**, copy the **Client ID** and **Client Secret** (the eye icon reveals it;
   **Regenerate** makes a new one if you lost it). Paste them into `.env.local` as `X_CLIENT_ID` and
   `X_CLIENT_SECRET`. Ignore the Consumer Key, Bearer Token and Access Token rows: the app does not
   use them.

   ![X Developer Console, app Keys & Tokens tab: OAuth 2.0 Keys, Client ID and Client Secret](docs/screenshots/x-console-keys.jpg)

## 3. xAI (Grok) key (2 min)

1. Go to https://console.x.ai → **API Keys** → **Create API key**.
2. Paste it into `.env.local` as `XAI_API_KEY`.
3. Add a few dollars of credits (**Credits remaining → Add** on the dashboard) if the account has
   none; a full sync + weekly digest is typically well under $1.

The app uses a two-tier model blend for token efficiency (overridable in `.env.local`):
- `XAI_MODEL_FAST` (default `grok-4.3`) — per-post categorization,
  image reading (vision), staleness checks
- `XAI_MODEL_SMART` (default `grok-4.7`) — digest outline, composition, and podcast script
- `XAI_REASONING_FAST` / `XAI_REASONING_SMART` (defaults `none` / `medium`) — reasoning effort
  per tier. Reasoning tokens bill as output, so raise these only if quality needs it.

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
that, **Check X for new** keeps growing your library beyond 800.

## Optional: Community Notes fact-check job

Bookmarks are cross-checked against X's public Community Notes dataset (there is no API for
reading notes on arbitrary posts). A daily GitHub Actions job does the matching:

1. Push this repo to GitHub.
2. In the repo → **Settings → Secrets and variables → Actions**, add:
   - `SUPABASE_URL` = `https://<your-project-ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = the legacy `service_role` key from step 1 (the script sends it
     as a Bearer token)
3. The workflow (`.github/workflows/community-notes.yml`) runs daily at 06:30 UTC; you can
   also trigger it manually from the Actions tab.

Until this job runs, everything works — posts just won't carry Community-Notes flags yet.

## Connecting an assistant (MCP)

Reference for the AI assistant connector. The short version, with the steps for each assistant, is in
the [README](README.md#works-with-your-ai-assistant). How it works inside is in
[ARCHITECTURE.md](ARCHITECTURE.md#connector-mcp), and the original design is in
[docs/mcp-connector.md](docs/mcp-connector.md).

### The connector URL

The connector lives at `<APP_URL>/api/mcp`, for example `https://your-app.onrender.com/api/mcp`.
It speaks [MCP](https://modelcontextprotocol.io) over Streamable HTTP and accepts only
`Authorization: Bearer <token>`. It never reads the session cookie. There is nothing to switch on:
every instance has it. The dashboard's **Assistants** panel shows the address of the page you opened
it from, with a Copy button, so open the dashboard at your public address.

**`APP_URL` must be the exact public URL the assistant uses.** The OAuth documents under
`/.well-known/` and the `WWW-Authenticate` challenge on a 401 are built from `APP_URL`, never from the
request's `Host` header, and assistants compare them with the address they were given. Match `http`
against `https`, any `www.`, any port, and a custom domain against the host's own address (such as
`onrender.com`). A trailing slash is ignored. The connector reads `APP_URL` when the server starts,
so restart or redeploy after changing it, then reconnect the assistant.

### Making a token

1. On the dashboard, find the **Assistants** panel (below Voices) and click **Set up**. The button
   reads **Manage** once you have a token.
2. Under **Create a token**, enter a name (up to 60 characters), choose **Read only** or **Read and
   write**, optionally tick **Expires in 90 days**, and click **Create token**.
3. Copy the token. It is `bg_` followed by 43 characters, and it is shown once. The server keeps a
   SHA-256 hash and the first eight characters, which the panel shows so you can tell tokens apart.
   If you lose one, revoke it and make another.

**Read only** lets the assistant search, list topics and briefs, read briefs, check on a brief and open
the episode links. **Read and write** also lets it start briefs and hide bookmarks, and restart a
brief that stalled (see [Render, Vercel and background briefs](#render-vercel-and-background-briefs)). Starting a brief spends money (see
[Costs](README.md#costs)). A person can hold 25 active tokens (not revoked, not expired) at once. The
limit applies to tokens made in the panel and to connections made by signing in alike.

To cut an assistant off, click **Revoke** next to its token and confirm. It stops working on its next
request. Every request also checks that the token's owner is still allowed (`users.is_allowed`).
That flag is rewritten when the person signs in with X, so removing someone from
`ALLOWED_X_USER_IDS` does not cut their tokens off until it changes. To do it at once, set
`is_allowed` to false on their `users` row in Supabase, or delete their `api_tokens` rows.

### Signing in (OAuth)

For assistants that cannot take a pasted token, the instance is also a small
[OAuth 2.1](https://oauth.net/2.1/) authorization server for its own tokens. The flow:

1. The assistant reads `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-authorization-server`, then registers itself at `/oauth/register`. It gets no
   secret, and PKCE with `S256` is required.
2. It opens `/oauth/authorize` in your browser. If you are not signed in, you go through the X
   sign-in first and come back.
3. You see the consent page, `/oauth/authorize/consent`. It shows:
   - "Connect *name*?" The name is whatever the assistant called itself when it registered, and
     anyone can register under any name. Approve only requests you just started yourself.
   - What it wants to do: search and read your bookmarks and briefs. If it asked for write access, it
     adds starting briefs (which spends your daily allowance and credits) and hiding bookmarks. An
     assistant that names no scope gets read only.
   - The account you are signed in as (`@handle`), and the site you will be sent back to.
   - **Approve** and **Deny** buttons, with a reminder that you can disconnect any time in the
     Assistants panel.
4. **Approve** sends the assistant a single-use code that works for five minutes. It trades the code
   for a token that lasts 30 days, plus a refresh token it uses to renew itself. **Deny** sends it
   back with an error.
5. The connection appears in the Assistants panel under the assistant's name, tagged **Connected by
   sign-in**. Revoke it there like any token.

Connecting the same assistant again replaces its earlier connection rather than adding a second one,
and a sign-in is refused while you already hold 25 active tokens: revoke one in the panel first. A
connection that goes 90 days without being used (no tool call and no renewal) can no longer renew
itself, so the assistant asks you to sign in again. If anyone presents a refresh token the assistant
already traded in, the server takes it as stolen and revokes that connection.

If the page says "This connection request can't be completed", your instance rejected what the
assistant sent: an unknown client, a return address it never registered, or a request that is
invalid in some other way, which the page names. The page never sends you anywhere by itself. When
the assistant and its return address check out, it offers a **Return to** link that takes the error
back to the assistant if you click it. Otherwise go back to the assistant and add the connector
again. The consent form is good for ten minutes, so if it times out, start again. An assistant may
register return addresses that use `https`, `http` on localhost only, or an app scheme such as
`cursor://`. A registration that never gets as far as a sign-in is deleted after an hour.

### The `next` return path

Two walls can stand between an assistant's request and the consent page. Each one remembers where
you were going, and sends you back there:

- **X sign-in.** `/api/auth/login?next=/some/path` keeps the path in a short-lived cookie
  (`bb_next`, ten minutes), and the X callback sends you there instead of to the dashboard.
- **The password gate.** With `GATE_PASSWORD` set, a blocked page redirects to
  `/gate?next=<path and query>`, and the right password sends you back there instead of to the home
  page.

Both accept only a path on your own app, never another site. So a sign-in that starts at
`/oauth/authorize` survives both walls: the password (if the gate is on), then X, then the consent
page.

### What the password gate leaves open

With `GATE_PASSWORD` set, every page needs the gate cookie except the paths below. Each one carries
its own lock.

| Path | Why it is open |
| --- | --- |
| `/api/mcp` | An assistant outside your browser cannot pass the gate. The endpoint needs a valid bearer token. |
| `/oauth/token`, `/oauth/register` | Machine endpoints that assistants call directly. A token request needs a valid code or refresh token. Registration is open by design; unused registrations are deleted after an hour, so a flood of them can't lock real assistants out (see the security review in [docs/mcp-connector.md](docs/mcp-connector.md#security-review-2026-10-30)). |
| `/oauth/authorize`, `/oauth/authorize/consent` | The browser steps of sign-in. They require the X sign-in themselves. |
| `/api/oauth/decision` | The consent form's post. It needs your session cookie and a signed consent that belongs to you. |
| `/.well-known/…` | Public discovery documents. The gate's matcher skips any path that contains a dot, so these are never gated. |
| `/api/episodes/<id>/audio`, `/api/episodes/<id>/markdown` | The stable links an assistant shares. They need your session cookie or a read token, and send a browser without one to the sign-in page. |

`/gate`, `/api/gate`, `/api/cron/` (which has its own `CRON_SECRET`) and the favicon were already
open. Everything else stays behind the gate, including token management (`/api/tokens`).

The gate is an extra wall for keeping an instance unlisted. It was never access control: X sign-in
plus `ALLOWED_X_USER_IDS` is. Because these paths keep their own locks, leaving them open does not
weaken that. A visitor without the password can learn that a connector exists, read the public
discovery documents and register an OAuth client, and none of that exposes your data.

### Trying it on your own computer

Assistants call the connector from the internet, so `http://localhost:3000/api/mcp` works only for
programs on your computer, such as Claude Code, Cursor or the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) (`npx @modelcontextprotocol/inspector`).
Web assistants cannot reach it, and Grok refuses `localhost` and private addresses outright. xAI's
[tunneling guide](https://docs.x.ai/grok/connectors/custom-mcp-tunneling) explains why and shows how
to expose your local server with [ngrok](https://ngrok.com) (`ngrok http 3000`) or a
[Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(`cloudflared tunnel --url http://localhost:3000`). Quick tunnels work with this connector, which
uses Streamable HTTP. Then:

1. Set `APP_URL` in `.env.local` to the tunnel's `https://…` address and restart the app.
2. Add `<tunnel address>/api/auth/callback/x` to the callback URIs in your X app (step 2.4), because
   X sign-in now comes back through the tunnel.
3. Open the dashboard at the tunnel address, not `localhost`, so the session cookie, the panel's
   connector URL and sign-in all agree. Create your token there.
4. `npm run dev` blocks other hostnames from its development-only resources. If the dashboard does
   not finish loading through the tunnel, add the tunnel's hostname to `allowedDevOrigins` in
   `next.config.ts` ([Next.js docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins)),
   or run `npm run build && npm start` instead.

Free tunnel addresses usually change each time you restart the tunnel. When yours does, update
`APP_URL` and the X callback, and add the connector to the assistant again.

### Render, Vercel and background briefs

A brief an assistant starts is written by a background runner on your server, not by a browser tab.
How far one run gets depends on the host:

| Host | What happens |
| --- | --- |
| [Render](https://render.com) or any always-on Node host | The runner finishes the whole brief in one go: about 3 minutes for markdown, about 12 for a podcast. The assistant's next status check finds it done. |
| [Vercel](https://vercel.com) or any host that ends a request's background work early | The runner is cut off after the route's 300 seconds. The assistant's next status check notices, restarts the runner, and it carries on from the last piece that finished. A podcast takes a few checks. |

On the second kind, a podcast finishes only while the assistant keeps checking in, and the assistant
is told to. Only a check made with a **Read and write** token restarts a stalled brief, since
restarting spends money; a read-only token just reports where it stands. A markdown brief usually
fits inside the limit. Briefs you start from the dashboard are not affected. If a run fails partway,
the unfinished brief stays as a draft that the dashboard's **Resume** button can finish. Revoking the
token that started a brief, or taking its owner off the allowlist, stops the brief before its next
paid step.

### Optional settings

| Variable | Default | What it does |
| --- | --- | --- |
| `LIMIT_MCP_CALL_PER_DAY` | 1000 | Assistant tool calls allowed per person in any rolling 24 hours, across all their assistants. It is a brake on a runaway client, not a spend cap: paid actions keep their own limits. |
| `BRIEF_JOB_STALE_SECONDS` | 90 | How long a running brief job may go without a heartbeat before the next status check (with a write token) takes it over. It matters only on hosts that end background work early. |

Set them in `.env.local` or your host's environment settings, as the other optional values (see
`.env.example`). A value that is not a positive number is ignored. Raise `BRIEF_JOB_STALE_SECONDS` if
jobs get taken over while still working. A very low value risks paying for the same step twice.

### Database changes

The connector adds four migrations to `supabase/migrations/`:

- `20261030032116_api_tokens.sql`: the `api_tokens` table.
- `20261030033352_brief_jobs.sql`: the `brief_jobs` table and the `claim_brief_job()` function.
- `20261030034215_oauth.sql`: the `oauth_clients` and `oauth_codes` tables, a refresh-token column
  on `api_tokens`, and the `prune_oauth_clients()` function.
- `20261030042448_connector_hardening.sql`: the security review's changes. It replaces
  `prune_oauth_clients()` and `claim_brief_job()`, adds `evict_oauth_client()`, and adds
  `api_tokens.previous_refresh_token_hash` and `brief_jobs.lease_id`. The code needs it: apply it
  before (or with) the deploy that ships it.

On a fresh install, `npm run setup` (step 5) creates them with everything else. On an existing
install, update the code and run `npm run setup` again with `SUPABASE_ACCESS_TOKEN` set: it applies
only the pending migrations, after a y/N prompt (`--yes` skips the prompt). Without that token,
setup cannot see what your project already has. Paste the four files, in order, into the Supabase
SQL editor instead; they are safe to run twice. Until they are applied, the Assistants panel and
`/api/mcp` return errors.

## Deploying (any host)

Bookmark Graveyard runs on any host that supports Node.js 22+ and takes environment variables:
`npm ci && npm run build`, then `npm start`. Render is what the author uses (below); Vercel works
too (the next section). Neither is required.

The app ships with an optional site-wide password wall (`src/proxy.ts`). Set `GATE_PASSWORD` and
every visitor gets a password prompt before anything — even the landing page — is served, except a
few endpoints that carry their own lock (see [What the password gate leaves
open](#what-the-password-gate-leaves-open)); leave it unset and there is no wall, locally or
deployed. The real access control is X sign-in plus
`ALLOWED_X_USER_IDS`: **set that on any deployed instance**, or anyone who completes X sign-in can
use it and your API keys. Your X user ID is shown next to **Log out** once you sign in.

### Deploy on Render

Run `npm run setup -- --check` locally first. On Render the migrations are already applied to your
Supabase project (step 5), so nothing runs there.

1. Push this repo to GitHub, then in the [Render dashboard](https://dashboard.render.com):
   **New + → Blueprint** → pick this repo. `render.yaml` creates the web service plus the
   weekly Friday sync cron.
2. Render prompts for the env vars: paste every value from `.env.local` (except
   `SUPABASE_ACCESS_TOKEN`, which only `npm run setup` uses), plus
   - `GATE_PASSWORD` — optional and not in the blueprint. If you want a site-wide password wall,
     add it later in the service's **Environment** tab and share it with whoever should get in
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
   domain) as a callback URI in your X app (step 2.4 above), alongside the localhost one.
5. Set `ALLOWED_X_USER_IDS` to your own X user ID (shown next to **Log out** once you sign in), so
   only you can sign in. Without it, anyone who completes X sign-in can use your instance.

### Deploy on Vercel

1. Push to GitHub → import the repo at https://vercel.com → add every variable from
   `.env.local` except `SUPABASE_ACCESS_TOKEN` (update `APP_URL` to your production URL) plus a
   random `CRON_SECRET` and, optionally, `GATE_PASSWORD`.
2. Add the production callback URL to your X app (step 2.4).
3. `vercel.json` already schedules a bookmark sync every Friday; generate briefs on demand
   from the UI, then download or listen in the browser. A podcast an AI assistant starts finishes
   only while the assistant keeps checking in; see [Render, Vercel and background
   briefs](#render-vercel-and-background-briefs).

### Fully local, with no Supabase account

Supabase runs on your own machine with Docker. Install the
[Supabase CLI](https://supabase.com/docs/guides/local-development), then in this repo run
`supabase init` once (the repo ships migrations but no `config.toml`) and `supabase start`. That
applies the same `supabase/migrations/` and prints a local API URL and keys (`supabase status`
shows them again). Put the URL in `NEXT_PUBLIC_SUPABASE_URL` and the service-role key in
`SUPABASE_SERVICE_ROLE_KEY`, then continue from step 2. The X app, the xAI key and the voice
provider are still cloud services.

## Multi-user later

Set `ALLOWED_X_USER_IDS` to a comma-separated list of X user IDs to control who can log in
(empty = anyone who logs in is allowed — fine while it's just you locally).
