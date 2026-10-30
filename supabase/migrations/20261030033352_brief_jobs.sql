-- Background brief jobs: generations an assistant starts through the MCP
-- connector. One row per request. The server-side runner (src/lib/jobs.ts)
-- drives the same four stages the dashboard drives from the browser (prepare,
-- script, render loop, finalize) and records its progress here, so a status
-- call can report it and a later runner can pick the job up where it stopped.
--
-- status: queued -> running -> done | failed.
-- stage: queued, syncing, selecting, writing, scripting, rendering,
--   publishing, done, failed (what the runner is doing, for status reports).
-- heartbeat_at: bumped by the runner while it works. A running job whose
--   heartbeat is older than the stale window is presumed dead (a
--   request-bound host cut it off) and may be claimed again.
-- params: the validated request (format, from, to, topics, tweetIds,
--   targetMinutes, syncFirst).

create table if not exists public.brief_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  -- the token that started the job, if any; no foreign key so this migration
  -- stands alone and a job record outlives a revoked token
  token_id uuid,
  params jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  stage text not null default 'queued',
  episode_id uuid references public.episodes (id) on delete set null,
  rendered_lines int not null default 0,
  total_lines int not null default 0,
  error text,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists brief_jobs_user_idx on public.brief_jobs (user_id, created_at desc);

-- Deny-all RLS like every other table: only the server-side service-role
-- client ever reads or writes it; the browser has no direct database access.
alter table public.brief_jobs enable row level security;

-- The runner's lease. Flips a queued job to running, or takes over a running
-- job whose heartbeat went stale, in one statement, so two runners racing for
-- the same job cannot both win: the loser gets no row back and stops.
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

-- Like the capacity functions: only the server's service role may call it.
revoke execute on function public.claim_brief_job(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_brief_job(uuid, int) to service_role;
