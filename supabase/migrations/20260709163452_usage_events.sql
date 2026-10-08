-- Per-user usage accounting for rolling-24h spend caps
create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default now()
);
create index usage_events_lookup_idx on public.usage_events (user_id, kind, created_at desc);
alter table public.usage_events enable row level security;
