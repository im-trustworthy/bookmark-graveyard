-- Finding 3: atomic check-and-record so a parallel burst can't overshoot the cap.
-- Serializes concurrent calls for the same (user, kind) via a txn-scoped advisory
-- lock, counts within the rolling window, and inserts only if under limit — all in
-- one transaction (each rpc call is its own implicit txn, so the lock releases at return).
create or replace function public.record_usage(
  p_user_id uuid,
  p_kind text,
  p_limit int,
  p_window_seconds int default 86400
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  used int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_kind, 0));
  select count(*) into used
    from usage_events
    where user_id = p_user_id
      and kind = p_kind
      and created_at >= now() - make_interval(secs => p_window_seconds);
  if used >= p_limit then
    return false;
  end if;
  insert into usage_events (user_id, kind) values (p_user_id, p_kind);
  return true;
end;
$$;

-- Finding 1: forward-only render high-water-mark so a draft can't be re-rendered
-- from cursor 0 indefinitely (resume may re-render only the frontier chunk).
alter table public.episodes add column render_cursor int not null default 0;
