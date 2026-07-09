// Vitest global setup: fake env vars so importing src/lib modules never
// throws from env.ts's `required` check or from lazily-called env() lookups
// (X_CLIENT_ID, ELEVENLABS_*, XAI_API_KEY, etc). No real secrets — values
// are shaped correctly (e.g. APP_ENCRYPTION_KEY is 64 hex chars = 32 bytes
// for AES-256-GCM) but are otherwise arbitrary fakes. Nothing here makes a
// network call.

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-supabase-service-role-key";
process.env.X_CLIENT_ID ??= "test-x-client-id";
process.env.X_CLIENT_SECRET ??= "test-x-client-secret";
// AES-256-GCM key: exactly 32 bytes, hex-encoded = 64 hex chars.
process.env.APP_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SESSION_SECRET ??= "test-session-secret";
process.env.ELEVENLABS_API_KEY ??= "test-elevenlabs-api-key";
process.env.ELEVENLABS_VOICE_HOST_A ??= "test-voice-host-a";
process.env.ELEVENLABS_VOICE_HOST_B ??= "test-voice-host-b";
process.env.XAI_API_KEY ??= "test-xai-api-key";
process.env.APP_URL ??= "http://localhost:3000";
