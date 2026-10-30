# Roadmap

Deferred work with the context needed to pick it up later. Ordered roughly by
when it's likely to become worthwhile.

---

## Filter by bookmark folder — BLOCKED on the X API (deferred 2026-07-09)

**What we want:** X lets people organize bookmarks into named folders. The ask
was to surface those folder names in the dashboard filter row as selectable
chips (alongside topic tags, "All" by default), so a brief can be generated
from a single folder — the same way hand-picking posts works.

**Why it's blocked (not a bug on our side — a hard X API limitation):**

We verified the current behavior directly, calling the API with a real stored
user token on 2026-07-09:

- `GET /2/users/:id/bookmarks/folders` (list folders) returns **200 OK** for our
  OAuth app + `bookmark.read` scope on the pay-per-use tier — so access/scope is
  *not* the blocker. It lists folder id + name, but is hard-capped at 20 folders
  with no pagination (fine for names; almost nobody has >20 folders).
- **The dealbreakers:**
  1. `GET /2/users/:id/bookmarks` — the endpoint our entire sync is built on —
     does **not** return a `folder_id` per post. So we cannot attribute folders
     using the full-library data we already sync; folder membership is only
     available from the per-folder endpoint below.
  2. `GET /2/users/:id/bookmarks/folders/:folder_id` (posts in a folder) is
     **hard-capped at 20 posts and rejects `max_results`/`pagination_token`.**
     A folder with 200 bookmarks only ever exposes 20 through the API, with no
     way to know what's missing.

**Consequence:** a folder filter would silently show ≤20 posts per folder,
populated by a *different* mechanism than the (complete) "All" view — so a post
could appear in All but not under its own folder. Shipping that without a loud
caveat would misrepresent coverage, which is why we held.

These limits are openly filed as bugs / feature requests on X's developer forum
(search "Bookmark folder endpoint returns only 20 IDs", "Feature Request –
Bookmark Folder Retrieval and Filtering"). X has not committed to a fix.

**Unblock condition — revisit when EITHER is true:**
- the per-folder endpoint starts honoring pagination (returns `meta.next_token`
  and >20 posts), **or**
- the main `/bookmarks` endpoint starts returning `folder_id` per post.

**How to check if it's unblocked (~5 min):** re-run a folders probe against a
test account that has a folder with >20 posts (author temporarily lacked any
folders, so this was untested against real membership data). If the per-folder
call paginates past 20, it's buildable. Sketch of the build at that point:
add a nullable `folder_id` + `folder_name` to `bookmarks`, sync folders in the
`/api/sync` path, add folder chips to the dashboard filter row (mirroring the
existing topic-chip pattern in `src/app/dashboard.tsx`), and add a `folder`
filter branch to `/api/bookmarks` and `selectBookmarksForDigest`.

**Interim alternative that already works:** the per-user topic taxonomy
(`src/lib/brain.ts` enrichment) covers *all* bookmarks with no cap and no extra
API calls — it's the complete organizer today, and hand-picking posts covers
the "curated subset" use case.

---

## Known deferred hardening (from the 2026-07-09 Opus review)

Non-blocking for personal use; worth doing before a public multi-user deploy.

- **Single-generation lease.** Two tabs generating the same draft concurrently
  is currently *bounded* by the per-user render/script caps and the forward-only
  render cursor, but not fully interlocked. A short-lived per-episode lease
  (heartbeat + `generating_until` timestamp) would make it exclusive. Briefs an AI assistant starts
  now have one (`claim_brief_job`); the dashboard's path still does not.
- **SSRF DNS-rebinding TOCTOU.** `fetchArticle` resolves + checks the host, but
  `fetch()` re-resolves a moment later, leaving a small rebinding window. Fully
  closing it needs pinning the vetted IP and connecting via a custom dispatcher
  (documented in `src/lib/ingest.ts`). Low risk on serverless; matters more on a
  VM/container with internal network reach.
- **Multi-draft resume.** Only the newest draft surfaces for resume; older
  orphaned drafts are invisible until the newer one resolves.
- **Refresh tokens have no expiry of their own** (assistant connector, 2026-10-30). A sign-in
  connection that is never used again keeps a working refresh token until someone revokes it in the
  Assistants panel. Expiring one after a long idle period would close that.
- **The 25-active-token cap does not apply to sign-in tokens** (2026-10-30). It is checked when a
  token is made in the panel. An approved sign-in is never refused for it, though it counts toward
  the total.
- **Client registration is open, with a 1,000-client ceiling** (2026-10-30). Anyone can register at
  `/oauth/register`. Unused registrations are pruned after 30 days, so a flood could fill the table
  and turn real assistants away with a 503 until the pruning catches up.

---

## "Saved between" date mode — BACKLOGGED (2026-10-05)

**What we want:** a switch on the dashboard date filter, "Posted between" vs
"Saved between", so a two-week window shows what the user *bookmarked* in the
last two weeks regardless of how old the post is. "Saved" would filter on
`bookmarks.first_seen_at` (the moment a sync first saw the bookmark), because
X's API does not expose when a post was bookmarked.

**Why it's deferred:** accuracy equals sync frequency. Until an unattended
nightly sync runs, "saved" dates cluster on whichever day the user happened to
hit the sync button, which is more misleading than having no mode at all. The
cron endpoint already exists (`/api/cron/sync`, bearer-protected), but
`render.yaml` and `vercel.json` only schedule it weekly. Separately, every bookmark from before the app was first
connected shares one `first_seen_at` and would need a "saved before you
connected" bucket in the UI.

**Unblock condition:** nightly sync in place — Render env vars pasted, a daily
scheduler (e.g. a GitHub Actions cron calling the endpoint with `CRON_SECRET`),
and early-stop pagination in `fetchAllBookmarks` (X returns newest-saved first,
so stop at the first page with nothing new; a daily check then costs one page).

**Build sketch at that point:** add `mode=posted|saved` to `/api/bookmarks`
(switch the filtered column; topic counts follow the same window), a toggle
beside the pickers in `src/app/dashboard.tsx`, default to "saved", and a
one-line hint per mode.

---

## Outbound "brief ready" webhook — BACKLOG (2026-10-30)

**What we want:** when a brief finishes, the app POSTs a small JSON message (title, episode id, the
stable audio and markdown links) to a URL the user sets, so an assistant or automation hears about it
instead of polling. The first fit is a
[Grok Bot routine](https://docs.x.ai/grok-bot/skills-routines-and-automations) with a webhook
trigger, which accepts an HTTP POST carrying `Authorization: Bearer <key>` and starts a run. The hook
point already exists: the job runner's `done` transition in `src/lib/jobs.ts`.

**Why not now:** it needs a per-user place for the URL and secret (encrypted, like voice keys), a
settings panel, a retry policy, and a way to show a failed delivery. The user picks the destination,
so it must go through the same private-address checks as article fetching (`src/lib/ingest.ts`). It
is also undecided whether briefs made on the dashboard should fire it, or only assistant-started
ones. On Vercel the delivery would run inside the same `after()` window as the runner.

**Unblock:** revisit when people running routines say polling is too clumsy. Design first: where the
setting lives, the payload, and how the receiver can tell the call came from the app.

---

## Private podcast RSS feed — BACKLOG (2026-10-30)

**What we want:** one feed address per user that a podcast app can subscribe to, so each finished
podcast brief shows up on a phone like any other episode. It reuses the stable audio links from the
assistant connector (`/api/episodes/[id]/audio`), which already outlive the 24-hour signed URLs.

**Why not now:** a podcast app cannot sign in to X or send an `Authorization` header, so the feed and
its audio links need a secret inside the URL itself, the way other private feeds work. That is a
third kind of credential beside the session cookie and the assistant tokens. It needs its own table,
a way to rotate or revoke it, and a rule that it can read audio and nothing else. Anyone who gets
the address gets the episodes, so the docs would have to say so. The feed also needs each file's size
and type from storage, and its route must stay open behind the password gate like the other
self-locked paths. Markdown-only briefs have no audio, so they need a decision (leave them out, or
publish a text item). Audio pruned to free space drops out of the feed.

**Unblock:** settle the secret-in-the-URL design (a scoped feed token with rotation), then add the
feed route next to the episode link routes.

---

## Cron ticking stale brief jobs — BACKLOG (2026-10-30)

**What we want:** a scheduled call that finds brief jobs an assistant started, and restarts any that
are still `queued` or whose runner was cut off, so a podcast finishes without anyone polling.
`maybeRescheduleBriefJob` in `src/lib/jobs.ts` already does this for one job when an assistant asks
for its status. The cron route would run the same claim for every stale job.

**Why not now:** it only matters on request-bound hosts such as Vercel, where background work is cut
off after the route's 300 seconds, and only when the assistant stops polling. On Render the runner
finishes the job by itself. The schedules in `render.yaml` and `vercel.json` also run weekly, and
this needs a check every minute or two. That is a different schedule, and some hosting plans do not
allow it or charge for it. A tick on a request-bound host is cut off at `maxDuration` too, so it
moves a job forward one slice at a time.

**Unblock:** revisit when someone on Vercel has an assistant or routine that gives up before a
podcast finishes. Build sketch: a second cron entry that calls a bearer-protected route (the
`CRON_SECRET` pattern of `/api/cron/sync`), which lists `queued` and stale `running` jobs and calls
the same claim and run for each.

---

## Local, no-cloud storage (SQLite + disk) — BACKLOG (2026-10-07)

**What we want:** a way to run Bookmark Graveyard with no cloud account behind it:
the database in SQLite and the episode files on local disk, so nothing leaves
the machine except the calls to X, xAI and the voice provider.

**Why not now:** V1 is Supabase-only on purpose. The app talks to Supabase's
query builder from about 20 files, keeps episode files in Supabase Storage and
serves them through signed URLs, and enforces its spend caps in a Postgres
function (`record_usage`). Supporting SQLite would take:

- a store interface with two implementations (Supabase and SQLite) behind every
  one of those call sites;
- a local file store with authenticated serving, since a disk has no signed
  URLs;
- a port of the schema in `supabase/migrations/`, including the spend-cap
  function;
- a different deployment model: an always-on server with a persistent disk.
  That rules out Vercel and free Render, and the GitHub Actions Community Notes
  job could not reach a database on a laptop.

**Unblock / how to do it:** revisit when self-hosters repeatedly ask for a
no-cloud option. **Interim, with no new code:** Supabase runs locally with
Docker, so a fully local install already exists. Run `supabase init` once (the
repo ships migrations but no `config.toml`), then `supabase start`, which
applies the same `supabase/migrations/`, and point `NEXT_PUBLIC_SUPABASE_URL`
and `SUPABASE_SERVICE_ROLE_KEY` at the local stack (`supabase status` prints
the URL and keys).

**Note:** database-size pruning is warn-only by design (bookmarks are user
data); audio pruning is automatic.
