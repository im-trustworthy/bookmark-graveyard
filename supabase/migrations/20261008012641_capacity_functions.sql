-- Capacity awareness: how full this instance is, so the app can warn and prune
-- old podcast audio before the Supabase plan limits break uploads. Both read
-- things the REST API can't reach (storage.objects, pg_database_size), hence
-- security definer with a locked search_path; only the server's service role
-- may call them.
create or replace function public.storage_usage_bytes(p_user_id uuid default null)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)
  from storage.objects o
  where o.bucket_id = 'episodes'
    and (p_user_id is null or o.name like p_user_id::text || '/%');
$$;

create or replace function public.database_size_bytes()
returns bigint
language sql
security definer
set search_path = ''
as $$
  select pg_catalog.pg_database_size(pg_catalog.current_database());
$$;

revoke execute on function public.storage_usage_bytes(uuid) from public, anon, authenticated;
revoke execute on function public.database_size_bytes() from public, anon, authenticated;
grant execute on function public.storage_usage_bytes(uuid) to service_role;
grant execute on function public.database_size_bytes() to service_role;

-- Audio removed to free space: the brief's markdown stays, and the row keeps
-- the moment it happened so the UI can say so instead of showing a dead player.
alter table public.episodes add column if not exists audio_pruned_at timestamptz;
