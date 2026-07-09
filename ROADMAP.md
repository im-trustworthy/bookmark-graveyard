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
  (heartbeat + `generating_until` timestamp) would make it exclusive.
- **SSRF DNS-rebinding TOCTOU.** `fetchArticle` resolves + checks the host, but
  `fetch()` re-resolves a moment later, leaving a small rebinding window. Fully
  closing it needs pinning the vetted IP and connecting via a custom dispatcher
  (documented in `src/lib/ingest.ts`). Low risk on serverless; matters more on a
  VM/container with internal network reach.
- **Multi-draft resume.** Only the newest draft surfaces for resume; older
  orphaned drafts are invisible until the newer one resolves.
