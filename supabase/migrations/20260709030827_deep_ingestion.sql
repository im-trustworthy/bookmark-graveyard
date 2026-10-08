-- Quoted/replied-to context captured at sync time
alter table public.bookmarks add column referenced jsonb;
-- Ingestion checkpoint (articles/media fetched)
alter table public.bookmarks add column ingested_at timestamptz;

-- Fetched source material per bookmark: linked articles, image descriptions, video transcripts
create table public.bookmark_sources (
  user_id uuid not null,
  tweet_id text not null,
  kind text not null check (kind in ('article','image','video')),
  url text not null,
  title text,
  content text,
  status text not null default 'ok' check (status in ('ok','failed','skipped')),
  fetched_at timestamptz not null default now(),
  primary key (user_id, tweet_id, kind, url),
  foreign key (user_id, tweet_id) references public.bookmarks(user_id, tweet_id) on delete cascade
);
alter table public.bookmark_sources enable row level security;
