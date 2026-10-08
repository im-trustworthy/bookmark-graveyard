-- Per-user voice provider settings ("connect your ElevenLabs / Grok Voice").
--
-- One row per user who connected a provider in the app. api_key_enc holds the
-- user's own vendor key, AES-256-GCM-encrypted with APP_ENCRYPTION_KEY exactly
-- like the X tokens in users.*_token_enc; NULL means "use this instance's key
-- from env" (XAI_API_KEY / ELEVENLABS_API_KEY). No row at all means the
-- instance defaults apply (VOICE_PROVIDER, GROK_VOICE_HOST_*, ELEVENLABS_*).

create table if not exists public.user_voice_settings (
  user_id uuid primary key references public.users (id) on delete cascade,
  provider text not null check (provider in ('grok', 'elevenlabs')),
  api_key_enc text,
  voice_a text not null,
  voice_b text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Deny-all RLS like every other table: only the server-side service-role
-- client ever reads or writes it; the browser has no direct database access.
alter table public.user_voice_settings enable row level security;
