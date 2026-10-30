-- Personal access tokens for AI assistants (the MCP connector).
--
-- A token is "bg_" plus 32 random bytes in base64url, shown to the user once
-- when it is created. Only its SHA-256 hex is stored (token_hash), plus the
-- first eight characters (prefix) so the Assistants panel can tell tokens
-- apart. Tokens are 256-bit random, so a fast hash is enough: there is nothing
-- to brute-force.
--
-- scopes: 'read' (search and read) and 'write' (also start briefs and hide
-- bookmarks; write implies read). client_id stays NULL for tokens made in the
-- dashboard; the later OAuth phase records the client that minted a token.
-- A revoked or expired token stops working on its next request.

create table if not exists public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null,
  prefix text not null,
  token_hash text not null unique,
  scopes text[] not null default '{read}',
  client_id text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  constraint api_tokens_scopes_check check (scopes <@ array['read', 'write']::text[])
);

create index if not exists api_tokens_user_idx on public.api_tokens (user_id, created_at desc);

-- Deny-all RLS like every other table: only the server-side service-role
-- client ever reads or writes it; the browser has no direct database access.
alter table public.api_tokens enable row level security;
