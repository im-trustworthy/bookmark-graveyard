# MCP connector: design

Status: Built (2026-10-30); this document is the design, the code is the reference.

Bookmark Graveyard gets a Model Context Protocol (MCP) server so an AI assistant can
search your bookmarks, list and read your briefs, and start a new one. Grok is the first
target (grok.com connectors, Grok Bot routines, the xAI API's `mcp` tool), but MCP is an
open standard, so the same endpoint serves Claude, ChatGPT, Cursor, and any agent built on
any model with an MCP client library. One surface, every assistant.

Today the app has no machine auth at all: every route except `/api/cron/sync` reads the
`bb_session` cookie, generation is four cookie-authenticated stages driven by the browser,
and episode files are served through signed URLs that expire after 24 hours. Nothing an
assistant could call exists yet. This design adds the three missing pieces: personal access
tokens, a background job runner for briefs, and the MCP endpoint itself.

## Contents

- [Goals and non-goals](#goals-and-non-goals)
- [How it looks to a user](#how-it-looks-to-a-user)
- [Client compatibility](#client-compatibility)
- [Auth: personal access tokens](#auth-personal-access-tokens)
- [The MCP endpoint](#the-mcp-endpoint)
- [Tools](#tools)
- [Background brief jobs](#background-brief-jobs)
- [Stable episode links](#stable-episode-links)
- [Password gate](#password-gate)
- [Limits and safety](#limits-and-safety)
- [Phase 2: OAuth for web chat clients](#phase-2-oauth-for-web-chat-clients)
- [Schema changes](#schema-changes)
- [Code changes by file](#code-changes-by-file)
- [Tests](#tests)
- [Docs](#docs)
- [Delivery plan](#delivery-plan)
- [Open decisions](#open-decisions)
- [What changed in implementation](#what-changed-in-implementation)
- [Security review (2026-10-30)](#security-review-2026-10-30)

## Goals and non-goals

Goals:

- An assistant can answer "what did I save about X" from data the app already computed
  (topics, summaries, claims, credibility), with no new Grok spend.
- An assistant can start a brief and come back for it, so a scheduled routine ("every Friday
  at 9, make my brief") works unattended.
- Links an assistant posts in chat keep working for weeks, not 24 hours.
- Every paid action stays behind the same per-user rolling caps as the dashboard.
- A leaked token can read that one user's bookmarks and spend within their caps. Nothing more.
- Works on Render (long-lived Node) and Vercel (request-bound functions), the two documented
  deploy targets, with the difference stated honestly.

Non-goals for this design:

- Outbound webhooks (app calls the bot when a brief is ready). Separate design; the job
  runner's "done" transition is where it would hook in.
- A private podcast RSS feed. Separate design; it reuses the stable episode links below.
- Bookmarking posts on the user's behalf. The app holds read-only X scopes on purpose.
- Per-conversation memory, voice, or anything living on the assistant's side.

## How it looks to a user

1. In the dashboard, a new **Assistants** panel shows the connector URL
   (`https://your-app/api/mcp`) and a **Create token** button. The user names the token
   ("Grok"), picks what it may do (read only, or read and generate), and copies the token.
   It is shown once.
2. On grok.com, Connectors, New Connector, Custom: paste the URL, complete the
   authentication step with the token. Grok discovers the tools. In Claude Code:
   `claude mcp add --transport http graveyard https://your-app/api/mcp --header "Authorization: Bearer …"`.
3. In chat: "What did I bookmark about MCP last month?", "Make me a ten-minute brief on the
   agent stuff from this week", "Is my Friday brief ready?".
4. In a Grok Bot routine: "Every Friday at 9:00: call generate_brief for the last seven days
   as a podcast, then poll get_brief_status until done and post the title, five bullets from
   the markdown, and the audio link."

## Client compatibility

MCP is model-agnostic. What varies is the client in front of the model and the auth it can
present. Two auth shapes cover everything:

| Client | Transport | Auth it can present | Works in phase 1 (bearer token) |
| --- | --- | --- | --- |
| grok.com Connectors (web, iOS, Android) | Streamable HTTP, public URL required | "Complete any required authentication": OAuth or API key per xAI's docs; the exact form is undocumented | Verify in the spike |
| Grok Bot (routines, chat) | Connected apps | Same connector catalog as grok.com | Verify in the spike |
| xAI API `mcp` tool (Responses API, Voice Agent API) | server_url + `authorization` and `headers` params | Bearer header | Yes |
| Grok Build CLI | `grok mcp add --header` | Static header | Yes |
| Claude Code, Claude Desktop, Cursor, VS Code | `--header` or JSON config | Static header | Yes |
| claude.ai custom connectors (web) | Streamable HTTP | OAuth, or no auth | Needs phase 2 |
| ChatGPT custom connectors | Streamable HTTP | OAuth, or no auth | Needs phase 2 |
| Any model via an agent loop (OpenAI Agents SDK, Vercel AI SDK, LangChain MCP adapters, the MCP TypeScript or Python client) | Any | Whatever the code sets | Yes |

Phase 1 ships bearer tokens because every developer-facing client takes a header and it is
the smallest thing that can work. Phase 2 adds an OAuth 2.1 authorization server so the
web chat products that refuse static headers can connect. The spike at the start of the
delivery plan settles whether Grok's connector UI needs phase 2 before the Grok use case
works at all.

## Auth: personal access tokens

A token is a per-user secret with scopes, created and revoked in the dashboard, presented
as `Authorization: Bearer <token>`.

Format: `bg_` followed by 32 random bytes in base64url (43 characters). The server stores
only the SHA-256 hex of the full token in `api_tokens.token_hash` (unique index) plus the
first eight characters as `prefix` for display. Tokens are 256-bit random, so a fast hash
is correct here; there is nothing to brute-force and no need for bcrypt. The plaintext is
returned exactly once, by the create call, and never logged.

Scopes:

| Scope | Allows |
| --- | --- |
| `read` | search_bookmarks, list_topics, list_episodes, get_episode, get_brief_status, the episode link routes |
| `write` | everything in `read`, plus generate_brief and hide_bookmark |

Verification (`src/lib/api-tokens.ts`, `verifyApiToken(token)`): hash, look up, reject if
`revoked_at` is set or `expires_at` has passed, join `users` and reject unless
`is_allowed`. Returns `{ userId, tokenId, scopes }` or `null`. Updates `last_used_at` at
most once per five minutes so a chatty client does not turn every call into a write.

Minting (`mintApiToken(userId, { name, scopes, expiresInDays? })`): inserts the row,
returns the plaintext once. Revoking sets `revoked_at`; the next request fails. Token
management routes (`/api/tokens`) accept the session cookie only, never a bearer token, so
a leaked token cannot mint more tokens.

A shared helper `getUserIdFromRequest(req, { scope })` in `src/lib/auth.ts` tries the
cookie first and then the bearer header. The MCP route uses bearer only: it must never act
on an ambient cookie, so a browser cannot be tricked into calling it.

Dashboard: `src/app/assistant-settings.tsx`, a panel in the style of the Voices panel.
Shows the connector URL with a copy button, the token list (name, prefix, scopes, created,
last used), create (name, read or read and write, optional 90-day expiry), the one-time
reveal, and revoke with a confirm. Routes: `GET`/`POST /api/tokens`,
`DELETE /api/tokens/[id]`.

## The MCP endpoint

`POST /api/mcp`, one route file at `src/app/api/mcp/route.ts`, Node runtime,
`maxDuration = 300` (tool calls are short; the long work runs in jobs).

Library: `mcp-handler` 2.x from Vercel on top of `@modelcontextprotocol/server` 2.x and
`zod` 4, all compatible with this repo (Next 16, zod ^4.4, Node 22). It serves the
2026-07-28 MCP spec statelessly over Streamable HTTP, falls back for 2025-era clients,
needs no Redis, and answers `GET` and `DELETE` with 405. Pin exact versions; both packages
are young.

Shape:

```ts
// src/app/api/mcp/route.ts
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerTools } from "@/lib/mcp/tools";
import { verifyApiToken } from "@/lib/api-tokens";

const handler = createMcpHandler((server) => registerTools(server), {
  serverInfo: { name: "bookmark-graveyard", version: pkg.version },
});

const authed = withMcpAuth(
  handler,
  async (_req, bearer) => {
    const auth = bearer ? await verifyApiToken(bearer) : null;
    if (!auth) return undefined;
    return { token: bearer!, scopes: auth.scopes, clientId: auth.tokenId, extra: { userId: auth.userId } };
  },
  { required: true, resourceMetadataPath: "/.well-known/oauth-protected-resource" }
);

export { authed as GET, authed as POST };
```

`withMcpAuth` answers a missing or bad token with 401 and a token without the scope with
403, both carrying an RFC 9728 `WWW-Authenticate` challenge. Each tool reads
`ctx.http?.authInfo` for the user id and checks its own scope (write tools reject a
read-only token with an MCP error, not a thrown exception).

Tool implementations live in `src/lib/mcp/tools.ts` as plain functions
`(userId, input) => output` so they are unit-testable without the handler, with a thin
`registerTools(server)` that wires schemas and scope checks. Every tool returns
`content: [{ type: "text", text: JSON.stringify(result) }]` plus `structuredContent`
with the same object, which is what current clients read.

Errors: tool handlers map `UsageLimitError` to an MCP tool error whose text says which
daily cap was hit, and everything else to the same public messages `apiError` uses. Detail
goes to the server log, as everywhere else.

## Tools

Seven tools. Inputs are zod schemas; outputs are documented here so the implementer and the
docs agree. Text fields are truncated so a search result never floods a model's context.

### search_bookmarks (read)

Input: `query?` (free text, up to 200 chars), `topics?` (string[]), `from?`, `to?`
(YYYY-MM-DD, on the post's date, same rule as the dashboard), `credibility?`
(`"any"` default, or `"flagged"` for disputed and misleading), `limit` (1 to 50,
default 20).

Behavior: loads the user's non-hidden bookmarks with their analysis through a shared
`loadBookmarks(userId, { from, to })` extracted from `/api/bookmarks`, applies the topic
filter the same way the dashboard does, then matches `query` as case-insensitive
substrings: every whitespace-separated term must appear in the post text, the summary, or
the author handle or name. Ordered newest post first.

Output: `{ items: [...], total_matches, returned }` where each item is
`{ tweet_id, url, author_handle, author_name, posted_at, saved_at, text (≤ 500 chars),
summary, claims, topics, content_type, credibility }`. `url` comes from `postUrl`.
`saved_at` is `first_seen_at`, with the caveat (also in the tool description) that X does
not expose when a post was bookmarked.

### list_topics (read)

Input: `from?`, `to?`. Output: `{ topics: [{ name, count }], library, total }`, computed
exactly as `/api/bookmarks` computes its chips.

### list_episodes (read)

Input: `limit` (1 to 50, default 10). Output: `{ episodes: [...] }` with
`{ id, title, created_at, format, status, duration_seconds, bookmark_count, topics,
date_from, date_to, links: { markdown, audio } }`. Only `ready` episodes, newest first.
`links` are the stable routes below, not signed URLs. `audio` is null for markdown-only
briefs and for episodes whose audio was pruned (`audio_pruned_at` set).

### get_episode (read)

Input: `episode_id`, `include_markdown` (default true), `include_script` (default
false). Output: the `list_episodes` item plus `markdown` (the brief text, capped at
60,000 characters with a `truncated` flag) and, when asked, `script` (the two-host
lines). Markdown is downloaded from storage on each call; it is a few kilobytes.

### generate_brief (write)

Input: `format` (`"markdown"` or `"podcast"`, mapped to the stored `"both"`), `from?`,
`to?`, `topics?`, `tweet_ids?` (hand-picked, up to 500, overrides dates and topics as in
the prepare route), `target_minutes` (5 to 30, default 20), `sync_first` (default false:
pull new bookmarks from X and analyze them before selecting).

Behavior: validates the same way `validatePrepareBody` does, runs the free selection check
so an empty filter answers immediately with "no bookmarks match" and burns no cap, inserts
a `brief_jobs` row, schedules the runner with `after()`, and returns within a second.

Output: `{ job_id, status: "queued", estimated_minutes, poll_hint }`. `estimated_minutes`
is 3 for markdown and 12 for a podcast; `poll_hint` tells the model to call
`get_brief_status` no more often than every 60 seconds.

### get_brief_status (read)

Input: `job_id`, or `episode_id` for the newest job that produced it.

Output: `{ job_id, status: "queued" | "running" | "done" | "failed", stage, progress:
{ rendered_lines, total_lines }, episode_id, title, links, error, started_at,
finished_at }`. `stage` is one of `syncing`, `selecting`, `writing`, `scripting`,
`rendering`, `publishing`, `done`, `failed`. When the job is `queued`, or `running` with a
heartbeat older than 90 seconds, this call re-schedules the runner before answering (see
jobs below), so polling is also what keeps a job alive on request-bound hosts.

### hide_bookmark (write)

Input: `tweet_id`. Same behavior and validation as `POST /api/bookmarks/hide`. Output:
`{ ok: true }`.

Tool descriptions matter: they are the only documentation the model sees. Each one states
what it costs ("free, reads stored analysis" versus "spends your daily brief allowance and
your xAI credits"), what the date filter means, and that bookmark text is user content
rather than instructions.

## Background brief jobs

The dashboard drives generation from the browser: prepare, script, a render loop one chunk
at a time, finalize, with the resume state machine in `deriveDigestStage`. An assistant
cannot sit in that loop, and MCP clients time out tool calls after seconds, not minutes. So
the MCP path needs a server-side driver.

### Shared stage functions

First, with no behavior change, lift the bodies of the four stage routes into
`src/lib/digest.ts`:

- `prepareBrief(userId, params)` returns `{ episode, markdown, done, stats }`
- `scriptBrief(userId, episodeId, targetMinutes)` returns `{ totalLines }`
- `renderChunk(userId, episodeId, cursor)` returns `{ nextCursor, totalLines, done }`
- `finalizeBrief(userId, episodeId)` returns `{ episode }`

The routes become thin wrappers that parse the request, call the function, and map errors
with `apiError`. Every guard stays where it is (draft-only resume, forward-only render
cursor, idempotent finalize, caps checked right before each paid call). The existing route
tests keep passing because the HTTP contracts do not move.

### The job table and runner

`brief_jobs` holds one row per request (schema below). `runBriefJob(jobId)` in
`src/lib/jobs.ts`:

1. Claims the job through a `claim_brief_job(p_job_id, p_stale_seconds)` Postgres
   function that flips `queued` to `running`, or re-claims a `running` job whose
   `heartbeat_at` is older than the stale window, in one statement. Two runners racing for
   the same job cannot both win. This claim is the single-generation lease the roadmap
   lists as deferred, scoped to assistant-started briefs.
2. If `sync_first`, runs `syncUser`, `ingestPending`, `enrichNewBookmarks` (stage
   `syncing`, same calls as the cron route).
3. If the job has no `episode_id` yet, runs `prepareBrief` (stages `selecting` then
   `writing`) and records the episode id. Markdown-only jobs finish here.
4. Otherwise derives where to resume from `deriveDigestStage` on the episode, exactly as the
   dashboard does, then runs `scriptBrief` if needed, loops `renderChunk` with a heartbeat
   and `rendered_lines` update after every chunk, and calls `finalizeBrief`.
5. Marks `done` with the episode id, or `failed` with the public error message. A failed
   job leaves the episode as a `draft`, so the dashboard's existing Resume banner can
   finish it by hand.

Scheduling uses `after()` from `next/server`, which runs a callback once the response has
been sent, for up to the route's `maxDuration`. That gives two behaviors:

| Host | What happens |
| --- | --- |
| Render, or any long-lived Node process | The runner finishes the whole job in one go, around 10 to 15 minutes for a podcast. One status poll finds it done. |
| Vercel, or any request-bound function | The runner gets at most `maxDuration` (300 seconds), then is cut mid-render. Its heartbeat goes stale, and the next `get_brief_status` call re-claims the job and continues from the last rendered chunk. A podcast takes three or four polls. |

The tool description for `get_brief_status` says this, so a routine on a Vercel instance
keeps polling instead of giving up. A follow-up can let the weekly cron route tick stale
jobs too, which removes the dependence on polling entirely; it is not needed for V1.

Cost notes the runner must respect: `prepareBrief` consumes a `digest_prepare` slot per
fresh brief, so a job that dies between the Grok writing pass and the episode insert and
is re-claimed pays that pass twice. That window is a few hundred milliseconds. Script and
render resume from persisted state and are never re-billed. `sync_first` consumes a `sync`
slot like the dashboard button.

Dashboard interplay: a job runs on its own episode row, so it never collides with a brief
the user is generating in a tab. If the user opens the dashboard while a job is mid-render,
the draft shows in the Resume banner. V1 accepts that; a later polish can hide drafts that
belong to a running job.

## Stable episode links

`signEpisodeUrls` mints 24-hour signed URLs, and an assistant pastes links into chat
histories that last longer than that. Two new routes:

- `GET /api/episodes/[id]/audio`
- `GET /api/episodes/[id]/markdown`

Each authenticates with the session cookie or a `read` bearer token, checks the episode
belongs to the user and is `ready`, mints a fresh one-hour signed URL, and answers 302.
Audio answers 404 with "This episode's audio was pruned to free space" when
`audio_pruned_at` is set. Unauthenticated browser requests get a redirect to `/` so a
user who clicks from their phone lands on sign-in rather than a JSON 401.

The dashboard keeps using signed URLs directly; these routes exist for links that leave the
app.

## Password gate

`src/proxy.ts` must leave these paths open, for the same reason `/api/cron/` is open: each
carries its own lock.

- `/api/mcp` (bearer token)
- `/.well-known/…` needs no change: the proxy matcher already skips any path containing a dot, so
  the metadata routes never reach the gate. A test should pin that down.
- `/api/episodes/[id]/audio` and `/markdown` (cookie or bearer)

The gate is documented as an extra wall for people who want an unlisted instance, never a
substitute for sign-in plus the allowlist. Exempting bearer-locked routes keeps that
promise. The proxy tests gain one case per path.

## Limits and safety

- Paid actions keep the existing caps unchanged: `digest_prepare`, `digest_script`,
  `digest_render`, `sync`, `enrich`. A token spends from the same per-user pool as the
  dashboard, so a leaked token cannot exceed what the user could spend by clicking.
- A new `mcp_call` kind (default 1,000 per rolling 24 hours, env override like the
  others) is recorded at the start of every tool call, as a crude brake on a runaway
  client. `usage_events` grows by at most that many rows per user per day, which is fine
  at this scale.
- Tool output contains bookmark text written by strangers. The server cannot control what
  the client's model does with it; the tool descriptions say it is content, and the docs
  say so to users. The server itself never acts on tool output.
- The MCP route ignores cookies entirely, so there is no CSRF surface. Token routes ignore
  bearer tokens, so a token cannot escalate.
- Tokens are never logged. `apiError` already keeps detail server-side; the bearer value
  must not appear in any thrown message.
- Revocation is immediate: every call looks the token up.
- `is_allowed` is checked on every verification, so removing a user from
  `ALLOWED_X_USER_IDS` and the allowlist also cuts off their tokens.
- The endpoint is public by necessity (Grok requires it), so the responses to an
  unauthenticated request leak nothing beyond the fact that an MCP server exists.

## Phase 2: OAuth for web chat clients

claude.ai and ChatGPT custom connectors do not take a static header; they run OAuth 2.1
with dynamic client registration and PKCE, discovering the authorization server through the
protected resource metadata that `withMcpAuth` already advertises. Grok's connector UI may
be the same, which the spike will tell. When needed, the app becomes a small authorization
server for its own tokens:

- `GET /.well-known/oauth-protected-resource`: `protectedResourceHandler({ authServerUrls: [APP_URL] })`.
- `GET /.well-known/oauth-authorization-server`: issuer, the three endpoints below,
  `code_challenge_methods_supported: ["S256"]`, `scopes_supported: ["read", "write"]`,
  `grant_types_supported: ["authorization_code", "refresh_token"]`,
  `token_endpoint_auth_methods_supported: ["none"]`.
- `POST /oauth/register`: dynamic client registration; stores `client_name` and
  `redirect_uris` in `oauth_clients`; public clients only.
- `GET /oauth/authorize`: requires the X session; renders a consent page naming the client
  and the requested scopes; on approve stores a hashed code with the PKCE challenge,
  redirect URI and scopes (five-minute expiry) and redirects with `code` and `state`.
- `POST /oauth/token`: exchanges the code with the verifier for an access token that is an
  `api_tokens` row tagged with the client, plus a hashed, rotating refresh token;
  handles the `refresh_token` grant.

Tokens issued this way appear in the Assistants panel under the client's name and are
revoked the same way. Rough size: four routes, one consent page, two tables, around 400
lines plus tests.

## Schema changes

Three migrations under `supabase/migrations/`, applied through `npm run setup` on fresh
installs like the existing nine.

```sql
-- api_tokens: personal access tokens for assistants
create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  prefix text not null,
  token_hash text not null unique,
  scopes text[] not null default '{read}',
  client_id text,                 -- phase 2: the OAuth client that minted it
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  constraint api_tokens_scopes_check check (scopes <@ array['read','write']::text[])
);
create index api_tokens_user_idx on public.api_tokens (user_id, created_at desc);
alter table public.api_tokens enable row level security;

-- brief_jobs: assistant-started generations
create table public.brief_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_id uuid references public.api_tokens(id) on delete set null,
  params jsonb not null,
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  stage text not null default 'queued',
  episode_id uuid references public.episodes(id) on delete set null,
  rendered_lines int not null default 0,
  total_lines int not null default 0,
  error text,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index brief_jobs_user_idx on public.brief_jobs (user_id, created_at desc);
alter table public.brief_jobs enable row level security;

create or replace function public.claim_brief_job(p_job_id uuid, p_stale_seconds int default 90)
returns setof public.brief_jobs language sql security definer set search_path = public as $$
  update brief_jobs
     set status = 'running',
         heartbeat_at = now(),
         started_at = coalesce(started_at, now())
   where id = p_job_id
     and (status = 'queued'
          or (status = 'running' and heartbeat_at < now() - make_interval(secs => p_stale_seconds)))
  returning *;
$$;
```

Phase 2 adds `oauth_clients` and `oauth_codes`. No change to `episodes`.

## Code changes by file

New:

| File | Purpose |
| --- | --- |
| `src/lib/api-tokens.ts` | mint, verify, list, revoke; hashing; the five-minute `last_used_at` throttle |
| `src/lib/auth.ts` | `getUserIdFromRequest(req, { scope })`: cookie, then bearer |
| `src/lib/bookmarks.ts` | `loadBookmarks`, `filterByTopics`, `topicCounts`, `matchesQuery`, shared by `/api/bookmarks` and the tools |
| `src/lib/digest.ts` | the four stage functions lifted from the routes |
| `src/lib/jobs.ts` | `createBriefJob`, `runBriefJob`, `scheduleBriefJob` (the `after()` wrapper), `getJobStatus` |
| `src/lib/mcp/tools.ts` | tool functions, schemas, `registerTools` |
| `src/app/api/mcp/route.ts` | the endpoint |
| `src/app/api/tokens/route.ts`, `src/app/api/tokens/[id]/route.ts` | token management, cookie only |
| `src/app/api/episodes/[id]/audio/route.ts`, `.../markdown/route.ts` | stable links |
| `src/app/assistant-settings.tsx` | the Assistants panel |
| `supabase/migrations/…_api_tokens.sql`, `…_brief_jobs.sql` | schema |

Changed:

| File | Change |
| --- | --- |
| `src/app/api/digest/{prepare,script,render,finalize}/route.ts` | call `src/lib/digest.ts`; contracts unchanged |
| `src/app/api/bookmarks/route.ts` | call `src/lib/bookmarks.ts`; contract unchanged |
| `src/lib/limits.ts` | add `mcp_call` to `DEFAULT_LIMITS` |
| `src/proxy.ts` | two open paths |
| `src/app/dashboard.tsx` | mount the Assistants panel next to Voices |
| `package.json` | `mcp-handler`, `@modelcontextprotocol/server`, pinned |
| `scripts/setup.mjs` | nothing, if it applies every migration in the folder; confirm |

## Tests

Vitest, same fixtures as today (`fake-db.ts`, `vi.mock` of session and supabase):

- `api-tokens.test.ts`: mint returns a `bg_` token once and stores only its hash; verify
  accepts it, rejects a revoked, expired, or unknown token and a user who is no longer
  allowed; `last_used_at` throttle.
- `digest-lib.test.ts`: the lifted stage functions behave as the route tests already
  assert; the route tests themselves stay green unchanged.
- `jobs.test.ts`: claim wins once; stale heartbeat re-claims; markdown job completes
  after prepare; podcast job resumes from the right stage for each `deriveDigestStage`
  case; failure leaves the episode as a draft and records the public message.
- `mcp-tools.test.ts`: every tool against the fake db, including scope rejection on write
  tools for a read-only token, truncation, and the `mcp_call` cap.
- `mcp-route.test.ts`: a real `initialize`, `tools/list`, and one `tools/call` through
  `POST` to the route with a minted token; 401 without one; 403 on scope.
- `episode-links.test.ts`: 302 with cookie, 302 with bearer, 404 for pruned audio, redirect
  to `/` with nothing.
- `proxy.test.ts`: the two new open paths, plus a case showing `/.well-known/…` is outside the matcher.

Manual: `npx @modelcontextprotocol/inspector` against the dev server for an end-to-end
`tools/call`, then the spike's client checks below.

## Docs

- README: a "Works with your assistant" section after "Using it": what it does, the
  connector URL, token creation, one screenshot of the Assistants panel, and short
  per-client setup lines (grok.com, Grok Bot, Claude Code, Claude.ai and ChatGPT once phase
  2 lands).
- SETUP.md: the same in reference form, plus the ngrok line for local development, since
  Grok refuses localhost URLs.
- ARCHITECTURE.md: a "Connector" section covering tokens, the job runner and the host
  difference, and the tool list.
- ROADMAP.md: the outbound webhook and the podcast feed, with this document as context.
- Release notes: the host difference stated plainly.

## Delivery plan

Each step is one PR, gated on `npm test`, `tsc`, lint and build like the release work.

| Step | What | Size |
| --- | --- | --- |
| S0 spike | A throwaway `/api/mcp` with one tool and a hard-coded bearer token, exposed with ngrok, added to grok.com Connectors, Claude Code, claude.ai and ChatGPT. Record which auth each accepts. Decides whether phase 2 blocks the Grok use case. | half a day |
| PR A | Lift stage bodies into `src/lib/digest.ts` and bookmark loading into `src/lib/bookmarks.ts`. No behavior change. | small |
| PR B | `api_tokens` migration, `api-tokens.ts`, `auth.ts`, token routes, Assistants panel, proxy paths, docs stub. | medium |
| PR C | `brief_jobs` migration and RPC, `jobs.ts`, runner, `after()` scheduling, stale re-claim. | medium |
| PR D | `mcp-handler` route, the seven tools, episode link routes, inspector smoke, README, SETUP, ARCHITECTURE. | medium |
| PR E | OAuth 2.1 authorization server, only if S0 says a target client needs it. | medium |

Wall-clock guess for S0 through D: two to three working days of agent time, with the
maintainer needed for S0 (signed in to the target clients) and for trying the finished panel.

## Open decisions

1. **OAuth before launch, or after?** If S0 shows grok.com accepts a bearer token, phase 1
   covers the Grok use case and phase 2 can follow when a Claude.ai or ChatGPT user asks.
   If grok.com insists on OAuth, PR E moves ahead of PR D.
2. **Default token expiry.** Proposal: none by default, with an optional 90-day choice
   in the panel. Routines break silently when a token expires.
3. **`sync_first` as an input versus a separate `sync_bookmarks` tool.** Proposal: the
   input, to keep the tool list short. A separate tool is a five-line addition later.
4. **Cron ticking stale jobs.** Proposal: follow-up, not V1. It matters only on Vercel and
   only when a routine stops polling.
5. **Panel name.** "Assistants" is the proposal. "Connect an AI", "Integrations" and
   "API access" were considered; the first says what the user gets.

## What changed in implementation

Where the code differs from the design above, the code wins. The differences:

- **The OAuth server shipped in the same release** as the endpoint, so phase 2 is done, not a
  follow-up. Beyond the sketch above: open registration is held to 1,000 clients by pruning and
  eviction (`prune_oauth_clients()`, `evict_oauth_client()`; see the security review below);
  `oauth_codes` records the `token_id` each code produced; `api_tokens` gained `refresh_token_hash`
  and `previous_refresh_token_hash` columns; access tokens last 30 days and are renewed through a
  rotating `bgr_` refresh token; and the metadata is also served at
  `/.well-known/openid-configuration` and at the path-insertion address
  `/.well-known/oauth-protected-resource/api/mcp`.
- **`brief_jobs.token_id` has no foreign key.** The schema above shows one. The migration stands on
  its own, and a job record outlives a revoked token.
- **A replayed authorization code revokes its token.** If a code that already produced a token is
  presented again, that token is revoked (RFC 6749 section 4.1.2: the code may have leaked).
- **The password gate carries a return path.** A blocked GET goes to `/gate?next=<path and query>`
  and `/api/gate` sends the browser back there. X sign-in has its own, `/api/auth/login?next=…`, kept
  in the `bb_next` cookie. Both accept only paths on the app (`src/lib/return-path.ts`). The gate
  also leaves `/oauth/*` and `/api/oauth/decision` open, not only the paths listed under "Password
  gate".
- **The consent page lives at `/oauth/authorize/consent`**, behind a route-handler authorize step.
  `GET /oauth/authorize` validates the request and redirects, because a page cannot answer with a 400
  or a 302. The consent form posts to `/api/oauth/decision`, and what the user approved travels as a
  signed blob (HMAC, ten minutes) instead of server state.
- **`resourceUrl` is pinned to `APP_URL`** on `withMcpAuth`, so the 401 challenge's `resource_metadata`
  never comes from the request's host or a forwarded header. The OAuth documents are built from
  `APP_URL` the same way.
- **Tools read at most the newest 1,000 visible bookmarks.** The design did not mention a cap on
  `search_bookmarks` and `list_topics`; `loadBookmarkRows` limits the query to 1,000.
  `get_brief_status` also returns `rescheduled`, and its `links` appear only once the job is done.
  Only a caller with the write scope restarts a stalled job; a read-only one gets the report alone.
- **The runner also beats on a timer.** Besides a heartbeat at each stage and chunk, a timer beats
  three times per stale window, so one long paid call does not look dead. The window is
  configurable with `BRIEF_JOB_STALE_SECONDS` (default 90).
- **Token limits.** A person may hold 25 active tokens, checked when one is made in the panel and
  when a sign-in mints one. A sign-in first revokes that client's earlier tokens for the user, so one
  client keeps one connection.
- **`is_allowed` is rewritten at each X sign-in**, so removing someone from `ALLOWED_X_USER_IDS` does
  not cut off their tokens until that flag changes. The design's wording glosses over that.
- **Client ID Metadata Documents (added 2026-10-30).** Besides registering, a client may send the
  https URL of a JSON document about itself as its `client_id`
  ([draft-ietf-oauth-client-id-metadata-document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/),
  which the MCP authorization spec adopts; claude.ai calls it "Claude's published identity"). The
  server metadata says `client_id_metadata_document_supported: true`.
  - *The URL.* `https` only, already in the URL parser's canonical form (which rules out dot segments,
    a spelled-out default port, an upper-case host and a missing path, since the document's
    `client_id` must match it character for character), no fragment or user name, at most 2,000
    characters, and not a reserved name or special-use IP literal.
  - *The fetch* (`src/lib/ssrf.ts`, the approach of `ingest.ts`): every address the host resolves to
    must be public, by a list stricter than ingest's that covers all of RFC 6890 plus multicast and
    the IPv6 transition prefixes; one GET with `Accept: application/json`, `redirect: "manual"` and
    Next's cache off; only a 200 counts, so a redirect is refused, not followed; at most 5 KB read
    (the draft's recommended limit) and 5 seconds in all, DNS included.
  - *The document* is untrusted. Its `client_id` must equal the URL exactly; it may not carry
    `client_secret` or `client_secret_expires_at`; it must have a string `client_name`; and the rest
    goes through the same `parseClientMetadata` as a registration: 1 to 10 redirect URIs under the
    usual rules, `token_endpoint_auth_method` absent or `none`, only the code flow and refresh, the
    name cleaned and cut to 100 characters.
  - *Cache.* A valid document is kept in memory for five minutes (at most 500 of them), so the
    authorize route, the consent page and the decision fetch it once between them. A failure or an
    invalid document is never cached. Five minutes is both the upper and lower bound the draft lets a
    server set, so `Cache-Control` on the document is not consulted.
  - *Storage: a row per approved client, not URL ids beside the rows.* `oauth_codes.client_id`
    references `oauth_clients`, so when the user approves, the decision route upserts an
    `oauth_clients` row keyed by the URL with the document's name and redirect URIs. Everything after
    that is unchanged: the code, the token endpoint (which reads that row and never fetches), "connect
    again replaces the earlier connection" (`revokeClientTokens` by `client_id`), and pruning and
    eviction. The authorization request never reads that row: it always goes by the document, so a
    redirect URI the client drops stops working at the next sign-in. Rows are written only on an
    approval by a signed-in, allowed user, so they can't be flooded; no migration was needed.
  - *Display.* The consent page names the client with the host that published the document
    ("Connect Claude (claude.ai)?"), says the name is self-published, and warns when the redirect is a
    program on this computer, which any program can claim to be. The token is named the same way in
    the Assistants panel.
  - *Not supported:* `private_key_jwt` and other client authentication (public clients only), and
    fetching `logo_uri` or any other URL in the document.
- **The open decisions went the way the proposals suggested.** OAuth shipped with the endpoint
  (above); tokens default to no expiry, with an optional 90-day choice; `sync_first` is an input of
  `generate_brief`; cron ticking of stale jobs is an item in [ROADMAP.md](../ROADMAP.md); and the
  panel is called Assistants.

## Security review (2026-10-30)

An adversarial review of the connector after it shipped. The schema changes are in one migration,
`supabase/migrations/20261030042448_connector_hardening.sql`.

Fixed:

1. **No open redirect.** `GET /oauth/authorize` never redirects to a client: every invalid request
   gets a 400 page in our own wording, with a "Return to *host*" link carrying the error only when the
   client and redirect URI check out (RFC 9700 section 4.11).
2. **A registration flood can't lock out sign-ups.** Unused registrations are pruned after an hour
   and fully revoked ones after 30 days; at 1,000 clients the oldest client with no live token is
   evicted, with 503 only when none can be; bodies declared over 64 KB get 413 before they are read.
3. **Refresh tokens: reuse detection and idle expiry.** A rotated-away refresh token presented again
   revokes the row, and a refresh after 90 days without use is refused.
4. **Jobs stop when access ends.** The runner checks the token and `users.is_allowed` after claiming
   and before every paid step, and a read-only caller of `get_brief_status` no longer restarts paid
   work.
5. **Fenced job lease.** Each claim stamps a `lease_id` that every runner write filters on, so a
   runner that was taken over stops at its next write and overwrites nothing.
6. **OAuth tokens respect the token cap.** A code exchange revokes the client's earlier tokens for
   the user and is refused at 25 active tokens.
7. **Issuer identification (RFC 9207).** Authorization responses carry `iss`, and the metadata says
   so with `authorization_response_iss_parameter_supported`.
8. **Tool output.** `list_topics`, `list_episodes` and `get_brief_status` carry the content warning,
   and topic names and episode titles are cut to 120 characters in every tool's output.

Accepted, with the reason:

- **A replayed code racing its own exchange may not revoke.** If the replay arrives before the first
  exchange has linked its token to the code, there is no token to revoke yet. The window is
  milliseconds wide, and codes are single use and live five minutes.
- **The gated "unlisted" mode exposes the product name.** The OAuth metadata and the consent and
  error pages stay reachable behind the password gate and name Bookmark Graveyard. The gate is an
  extra layer for keeping an instance unlisted, never the lock; sign-in plus the allowlist is.
- **Any client can call itself "Claude".** Dynamic registration takes the name the client gives, and
  a client metadata document says whatever its publisher wrote. The consent page shows what can be
  checked next to the name: the host that published the document, if any, and the real destination,
  the redirect URI's host, with a warning when that is a program on this computer. It asks the user to
  approve only apps they added themselves.
- **The metadata fetch can be pointed at any public https URL, unauthenticated.** That is how the
  mechanism works: anyone can send `/oauth/authorize` a `client_id` URL. The guard keeps it off
  private and special-use addresses, one GET of at most 5 KB in 5 seconds per request, and the
  response never reaches the requester except as one of our fixed sentences. A DNS-rebinding host can
  slip between the address check and the fetch, as for article fetching (see ROADMAP.md).
- **Access tokens last 30 days.** Shorter ones would send users back through sign-in more often with
  clients that handle refresh badly, for a modest gain: revocation is immediate either way, because
  every request looks the token up.
- **Reuse detection remembers one rotation.** Only the refresh token the latest rotation replaced is
  recognized; one from two or more rotations ago is refused as unknown without revoking the row.
