-- Users authenticated via X OAuth (app-managed, tokens encrypted at rest by the app)
create table public.users (
  id uuid primary key default gen_random_uuid(),
  x_user_id text unique not null,
  handle text not null,
  display_name text,
  avatar_url text,
  refresh_token_enc text,
  access_token_enc text,
  token_expires_at timestamptz,
  is_allowed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bookmarks (
  user_id uuid not null references public.users(id) on delete cascade,
  tweet_id text not null,
  author_handle text,
  author_name text,
  text text not null default '',
  tweet_created_at timestamptz,
  first_seen_at timestamptz not null default now(),
  public_metrics jsonb,
  entities jsonb,
  media jsonb,
  raw jsonb,
  primary key (user_id, tweet_id)
);
create index bookmarks_user_first_seen_idx on public.bookmarks (user_id, first_seen_at desc);
create index bookmarks_user_created_idx on public.bookmarks (user_id, tweet_created_at desc);

create table public.bookmark_analysis (
  user_id uuid not null,
  tweet_id text not null,
  topics text[] not null default '{}',
  summary text,
  claims text[] not null default '{}',
  content_type text not null default 'other'
    check (content_type in ('news','evergreen','opinion','other')),
  credibility text not null default 'none'
    check (credibility in ('none','disputed','misleading')),
  analyzed_at timestamptz not null default now(),
  primary key (user_id, tweet_id),
  foreign key (user_id, tweet_id) references public.bookmarks(user_id, tweet_id) on delete cascade
);

-- Populated by the nightly Community Notes public-dataset job
create table public.community_notes (
  note_id text primary key,
  tweet_id text not null,
  note_text text,
  classification text,
  status text,
  note_created_at timestamptz,
  fetched_at timestamptz not null default now()
);
create index community_notes_tweet_idx on public.community_notes (tweet_id);

-- Per-user living topic taxonomy
create table public.topics (
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, name)
);

create table public.episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  format text not null check (format in ('markdown','audio','both')),
  date_from timestamptz,
  date_to timestamptz,
  topics text[] not null default '{}',
  markdown_path text,
  audio_path text,
  duration_seconds integer,
  bookmark_count integer,
  script jsonb,
  created_at timestamptz not null default now()
);
create index episodes_user_idx on public.episodes (user_id, created_at desc);

-- Deny-all posture: the Next.js server uses the service role key; no anon access.
-- RLS policies can be added per-user later if we adopt Supabase Auth for multi-user.
alter table public.users enable row level security;
alter table public.bookmarks enable row level security;
alter table public.bookmark_analysis enable row level security;
alter table public.community_notes enable row level security;
alter table public.topics enable row level security;
alter table public.episodes enable row level security;

-- Private bucket for generated episode files (.md / .mp3)
insert into storage.buckets (id, name, public) values ('episodes', 'episodes', false);
