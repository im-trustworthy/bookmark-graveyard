alter table public.episodes add column status text not null default 'ready'
  check (status in ('draft','ready','failed'));
