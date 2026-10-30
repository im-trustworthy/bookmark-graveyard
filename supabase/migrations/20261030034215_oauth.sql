-- OAuth 2.1 for web chat clients (claude.ai, ChatGPT and the like), which
-- connect through dynamic client registration and PKCE instead of a pasted
-- token. The flow ends in an ordinary api_tokens row tagged with the client.
--
-- oauth_clients: one row per registration (RFC 7591). Public clients only:
-- there is no client secret, so token_endpoint_auth_method is always 'none'.
-- Registration is open to anyone, so the app prunes registrations older than
-- 30 days that never produced a token or a pending code, and stops accepting
-- new ones past a fixed ceiling.
--
-- oauth_codes: authorization codes, five minutes, single use. Only the
-- SHA-256 hex of a code is stored, next to the PKCE challenge, the redirect
-- URI and the scopes the user approved.
--
-- api_tokens.refresh_token_hash: the SHA-256 hex of the current refresh token
-- of a token minted through OAuth (NULL for dashboard tokens). Refreshing
-- rewrites the same row with a new access token and a new refresh token, so the
-- old pair stops working and the Assistants panel keeps one entry per client.

create table if not exists public.oauth_clients (
  client_id text primary key,
  client_name text,
  redirect_uris text[] not null,
  token_endpoint_auth_method text not null default 'none',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists public.oauth_codes (
  code_hash text primary key,
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  redirect_uri text not null,
  scopes text[] not null,
  code_challenge text not null,
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.api_tokens add column if not exists refresh_token_hash text unique;

-- Deny-all RLS like every other table: only the server-side service-role
-- client ever reads or writes these; the browser has no direct database access.
alter table public.oauth_clients enable row level security;
alter table public.oauth_codes enable row level security;

-- Called on every registration: deletes registrations older than p_max_age_days
-- that have no api_tokens row and no oauth_codes row, then returns how many
-- registrations remain. One statement on the server, so the app never has to
-- send a list of client ids back and forth.
create or replace function public.prune_oauth_clients(p_max_age_days int default 30)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.oauth_clients c
   where c.created_at < now() - make_interval(days => p_max_age_days)
     and not exists (select 1 from public.api_tokens t where t.client_id = c.client_id)
     and not exists (select 1 from public.oauth_codes o where o.client_id = c.client_id);
  return (select count(*) from public.oauth_clients);
end;
$$;

revoke execute on function public.prune_oauth_clients(int) from public, anon, authenticated;
grant execute on function public.prune_oauth_clients(int) to service_role;
