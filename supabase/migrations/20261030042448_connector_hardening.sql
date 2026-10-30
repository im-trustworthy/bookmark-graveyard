-- Connector hardening after the 2026-10-30 security review of the MCP
-- connector (docs/mcp-connector.md, "Security review"). Three changes:
--
-- 1. OAuth client registration can't be flooded into refusing new sign-ups.
--    prune_oauth_clients now drops a registration that never got as far as a
--    code after an hour, and one whose tokens were all revoked after 30 days.
--    evict_oauth_client makes room at the ceiling by removing the oldest
--    registration that has no live token.
-- 2. Refresh-token reuse detection: rotating a refresh token keeps the hash of
--    the one it replaced, so a rotated-away token presented again can be
--    recognized and the whole connection revoked (RFC 9700 section 4.14.2).
-- 3. A fenced lease for brief jobs: every claim hands out a fresh lease_id, and
--    the runner's writes only land while the row still carries its lease, so a
--    runner that was taken over can't overwrite the new runner's progress.

-- 1. Registration flood ------------------------------------------------------

-- The old one-argument prune is replaced, not overloaded, so a call can never
-- be ambiguous between the two.
drop function if exists public.prune_oauth_clients(int);

-- Called on every registration. Deletes:
--   (a) registrations older than p_unused_minutes that never produced a code
--       or a token: abandoned or flooded sign-ups;
--   (b) registrations older than p_stale_days whose tokens are all revoked
--       (or that have none) and that have no unexpired code.
-- Returns how many registrations remain.
create or replace function public.prune_oauth_clients(p_unused_minutes int default 60, p_stale_days int default 30)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.oauth_clients c
   where c.created_at < now() - make_interval(mins => p_unused_minutes)
     and not exists (select 1 from public.oauth_codes o where o.client_id = c.client_id)
     and not exists (select 1 from public.api_tokens t where t.client_id = c.client_id);

  delete from public.oauth_clients c
   where c.created_at < now() - make_interval(days => p_stale_days)
     and not exists (select 1 from public.api_tokens t where t.client_id = c.client_id and t.revoked_at is null)
     and not exists (select 1 from public.oauth_codes o where o.client_id = c.client_id and o.expires_at > now());

  return (select count(*) from public.oauth_clients);
end;
$$;

revoke execute on function public.prune_oauth_clients(int, int) from public, anon, authenticated;
grant execute on function public.prune_oauth_clients(int, int) to service_role;

-- Called by registration while the table is at its ceiling. Deletes the single
-- oldest registration with no live token (every api_tokens row revoked or
-- expired, or none at all) and no code still waiting to be exchanged, and
-- returns whether it found one. SKIP LOCKED, so two registrations evicting at
-- once pick different rows.
create or replace function public.evict_oauth_client()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  victim text;
begin
  select c.client_id into victim
    from public.oauth_clients c
   where not exists (
           select 1 from public.api_tokens t
            where t.client_id = c.client_id
              and t.revoked_at is null
              and (t.expires_at is null or t.expires_at > now()))
     and not exists (
           select 1 from public.oauth_codes o
            where o.client_id = c.client_id
              and o.used_at is null
              and o.expires_at > now())
   order by c.created_at asc
   limit 1
   for update skip locked;

  if victim is null then
    return false;
  end if;
  delete from public.oauth_clients where client_id = victim;
  return true;
end;
$$;

revoke execute on function public.evict_oauth_client() from public, anon, authenticated;
grant execute on function public.evict_oauth_client() to service_role;

-- Both functions look up tokens and codes per client.
create index if not exists api_tokens_client_idx on public.api_tokens (client_id) where client_id is not null;
create index if not exists oauth_codes_client_idx on public.oauth_codes (client_id);

-- 2. Refresh-token reuse detection --------------------------------------------

-- The SHA-256 hex of the refresh token the current one replaced. A refresh
-- that presents it is a replay of a rotated-away token: the row is revoked.
alter table public.api_tokens add column if not exists previous_refresh_token_hash text;
create index if not exists api_tokens_previous_refresh_idx
  on public.api_tokens (previous_refresh_token_hash)
  where previous_refresh_token_hash is not null;

-- 3. Fenced job lease -----------------------------------------------------------

-- Set to a fresh uuid by every claim. The runner filters each of its writes
-- on it; a write that matches no row means another runner took the job over.
alter table public.brief_jobs add column if not exists lease_id uuid;

-- Same signature and semantics as before, plus the fresh lease.
create or replace function public.claim_brief_job(p_job_id uuid, p_stale_seconds int default 90)
returns setof public.brief_jobs language sql security definer set search_path = public as $$
  update brief_jobs
     set status = 'running',
         heartbeat_at = now(),
         started_at = coalesce(started_at, now()),
         lease_id = gen_random_uuid()
   where id = p_job_id
     and (status = 'queued'
          or (status = 'running' and heartbeat_at < now() - make_interval(secs => p_stale_seconds)))
  returning *;
$$;

revoke execute on function public.claim_brief_job(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_brief_job(uuid, int) to service_role;
