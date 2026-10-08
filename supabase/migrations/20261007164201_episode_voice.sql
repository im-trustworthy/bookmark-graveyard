-- Pin the voice provider and host voices an episode was started with, so a
-- draft resumed after the user (or the instance) switched voices finishes in
-- the voices it began with instead of mixing two sets mid-stream.
-- Shape: {"provider": "grok" | "elevenlabs", "voiceA": "...", "voiceB": "..."}
-- NULL on episodes created before this column existed (and on markdown-only
-- briefs, which have no audio). API keys are never stored here.
alter table public.episodes add column if not exists voice jsonb;
