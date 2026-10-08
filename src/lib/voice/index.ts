import "server-only";
import { createElevenLabsProvider, ELEVENLABS_DEFAULT_MODEL, listElevenLabsVoices } from "./elevenlabs";
import { VoiceConfigError } from "./errors";
import { createGrokProvider, listGrokVoices } from "./grok";
import type { VoiceConfig, VoiceOption, VoiceProvider, VoiceProviderId } from "./types";

export { InvalidVoiceKeyError, VoiceConfigError, VoiceVendorError } from "./errors";
export type {
  HostSpeaker,
  SynthesizeContext,
  VoiceConfig,
  VoiceOption,
  VoiceProvider,
  VoiceProviderId,
} from "./types";

/**
 * An explicit choice (override, then VOICE_PROVIDER) wins. Otherwise ElevenLabs
 * if its key is set, so existing deployments keep their voices, else Grok if
 * the xAI key the rest of the app already uses is set.
 */
function chooseProvider(override: string | undefined): VoiceProviderId | null {
  // Forgiving about case and stray whitespace ("Grok", or a trailing space pasted
  // into a hosting dashboard); a blank value counts as unset.
  const explicit = normalize(override) || normalize(process.env.VOICE_PROVIDER);
  if (explicit) {
    if (explicit === "grok" || explicit === "elevenlabs") return explicit;
    throw new VoiceConfigError(
      `Invalid VOICE_PROVIDER "${explicit}" — use "grok" or "elevenlabs" (see SETUP.md step 4)`
    );
  }
  if (process.env.ELEVENLABS_API_KEY) return "elevenlabs";
  if (process.env.XAI_API_KEY) return "grok";
  return null;
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/** The env var holding this instance's key for each vendor. */
export const ENV_API_KEY: Record<VoiceProviderId, "XAI_API_KEY" | "ELEVENLABS_API_KEY"> = {
  grok: "XAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

/**
 * This instance's key from env, or a VoiceConfigError naming the variable. A
 * key with whitespace or control characters (say, a newline pasted into a
 * hosting dashboard) is refused here, before it reaches a request header whose
 * error message would embed it.
 */
export function envApiKey(name: (typeof ENV_API_KEY)[VoiceProviderId]): string {
  const value = process.env[name];
  if (!value) {
    throw new VoiceConfigError(
      `Missing ${name} on the server — paste your own key under Voices, or ask the operator to set it (see SETUP.md)`
    );
  }
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new VoiceConfigError(`${name} contains whitespace or control characters — re-paste it`);
  }
  return value;
}

/**
 * Resolves which TTS/STT provider to use and its credentials. Returns null
 * when none is configured; throws VoiceConfigError when VOICE_PROVIDER is
 * invalid or the selected provider's env key is missing or corrupt. Env is read per call,
 * never at import, so a bad voice config only fails the requests that need it.
 *
 * ElevenLabs voices may resolve to "" — the key alone is enough for video
 * transcription; synthesize() then names the missing voice. Use isTtsReady()
 * before promising audio.
 *
 * `overrides` win field-by-field over env: the hook for per-user settings (a
 * user who connected their own ElevenLabs or Grok key). Env defaults are read
 * for whichever provider wins, so `{ provider: "grok" }` alone still gets
 * XAI_API_KEY and the GROK_VOICE_HOST_* voices. An `apiKey` override must come
 * with its `provider`: keys are vendor-specific, and env may select the other
 * vendor. Empty strings count as unset, like a blank `KEY=` line.
 */
export function resolveVoiceConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig | null {
  if (overrides.apiKey && !normalize(overrides.provider)) {
    throw new Error("apiKey override requires provider");
  }
  const provider = chooseProvider(overrides.provider);
  if (!provider) return null;
  if (provider === "grok") {
    // No model: xAI's TTS endpoint doesn't take one.
    return {
      provider,
      apiKey: overrides.apiKey || envApiKey("XAI_API_KEY"),
      voiceA: overrides.voiceA || process.env.GROK_VOICE_HOST_A || "ara",
      voiceB: overrides.voiceB || process.env.GROK_VOICE_HOST_B || "helios",
    };
  }
  return {
    provider,
    apiKey: overrides.apiKey || envApiKey("ELEVENLABS_API_KEY"),
    voiceA: overrides.voiceA || process.env.ELEVENLABS_VOICE_HOST_A || "",
    voiceB: overrides.voiceB || process.env.ELEVENLABS_VOICE_HOST_B || "",
    model: overrides.model || process.env.ELEVENLABS_MODEL || ELEVENLABS_DEFAULT_MODEL,
  };
}

/** Whether a resolved config can voice both hosts (not just transcribe). */
export function isTtsReady(config: VoiceConfig | null): config is VoiceConfig {
  return config !== null && config.voiceA !== "" && config.voiceB !== "";
}

/** The TTS/STT provider for this request; throws VoiceConfigError when none is configured. */
export function getVoiceProvider(overrides?: Partial<VoiceConfig>): VoiceProvider {
  return providerFor(resolveVoiceConfig(overrides));
}

/** Builds the provider for an already-resolved config (null = nothing configured). */
export function providerFor(config: VoiceConfig | null): VoiceProvider {
  if (!config) {
    throw new VoiceConfigError(
      "No voice provider configured — set VOICE_PROVIDER=grok (uses XAI_API_KEY) or VOICE_PROVIDER=elevenlabs (see SETUP.md step 4)"
    );
  }
  return config.provider === "grok" ? createGrokProvider(config) : createElevenLabsProvider(config);
}

/** The vendor's voice catalog for this key. A rejected key throws InvalidVoiceKeyError. */
export function listVoices(provider: VoiceProviderId, apiKey: string): Promise<VoiceOption[]> {
  return provider === "grok" ? listGrokVoices(apiKey) : listElevenLabsVoices(apiKey);
}
