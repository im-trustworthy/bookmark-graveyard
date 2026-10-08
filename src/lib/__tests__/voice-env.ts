import { vi } from "vitest";

/** Every env var the voice resolver reads. */
export const VOICE_ENV_VARS = [
  "VOICE_PROVIDER",
  "XAI_API_KEY",
  "GROK_VOICE_HOST_A",
  "GROK_VOICE_HOST_B",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_HOST_A",
  "ELEVENLABS_VOICE_HOST_B",
  "ELEVENLABS_MODEL",
] as const;
export type VoiceEnvVar = (typeof VOICE_ENV_VARS)[number];

/**
 * Deletes every voice env var for the current test, whatever put it there
 * (setup.ts's fakes, a sourced .env.local, the developer's shell), then sets
 * `vars`. vi.unstubAllEnvs() in afterEach restores the originals.
 */
export function clearVoiceEnv(vars: Partial<Record<VoiceEnvVar, string>> = {}): void {
  for (const name of VOICE_ENV_VARS) vi.stubEnv(name, vars[name]);
}
