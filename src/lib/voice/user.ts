import "server-only";
import { decrypt, encrypt } from "../crypto";
import { db } from "../supabase";
import { VoiceConfigError } from "./errors";
import { ENV_API_KEY, envApiKey, providerFor, resolveVoiceConfig } from "./index";
import type { VoiceConfig, VoiceProvider, VoiceProviderId } from "./types";

// Per-user voice settings ("connect your ElevenLabs / Grok Voice") in
// user_voice_settings. No row = the instance defaults from env apply; a row
// without api_key_enc = that provider with the instance's own key.

const TABLE = "user_voice_settings";

interface SettingsRow {
  provider: VoiceProviderId;
  api_key_enc: string | null;
  voice_a: string;
  voice_b: string;
}

/** The provider and host voices an episode started with (episodes.voice). Never a key. */
export interface PinnedVoice {
  provider: VoiceProviderId;
  voiceA: string;
  voiceB: string;
}

async function loadRow(userId: string): Promise<SettingsRow | null> {
  const { data, error } = await db()
    .from(TABLE)
    .select("provider, api_key_enc, voice_a, voice_b")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Voice settings lookup failed: ${error.message}`);
  return data as SettingsRow | null;
}

function decryptKey(enc: string): string {
  try {
    return decrypt(enc);
  } catch {
    // e.g. APP_ENCRYPTION_KEY changed since it was saved: only re-entering the key fixes it.
    throw new VoiceConfigError("Your saved voice API key can't be read — enter it again under Voices");
  }
}

/**
 * The user's saved choice as resolveVoiceConfig() overrides, or null when they
 * haven't connected a provider. `apiKey` is present only when they stored their
 * own; otherwise the instance's env key fills in.
 */
export async function loadUserVoiceOverrides(userId: string): Promise<Partial<VoiceConfig> | null> {
  const row = await loadRow(userId);
  if (!row) return null;
  const overrides: Partial<VoiceConfig> = { provider: row.provider, voiceA: row.voice_a, voiceB: row.voice_b };
  if (row.api_key_enc) overrides.apiKey = decryptKey(row.api_key_enc);
  return overrides;
}

/**
 * The user's effective voice config: their saved settings over the instance
 * defaults. With `pinned` (an episode's snapshot) its provider and voices win,
 * so a resumed draft finishes in the voices it started with; the user's own key
 * is used only if it belongs to that provider (and only then decrypted, so an
 * unreadable key for the other vendor can't block the render), else the
 * instance's key. Null when nothing is configured; throws VoiceConfigError
 * when it's broken.
 */
export async function resolveVoiceConfigForUser(userId: string, pinned?: PinnedVoice): Promise<VoiceConfig | null> {
  if (!pinned) return resolveVoiceConfig((await loadUserVoiceOverrides(userId)) ?? {});
  const row = await loadRow(userId);
  const apiKey = row?.provider === pinned.provider && row.api_key_enc ? decryptKey(row.api_key_enc) : undefined;
  return resolveVoiceConfig({ provider: pinned.provider, voiceA: pinned.voiceA, voiceB: pinned.voiceB, apiKey });
}

/** The provider for this user's renders and transcriptions; throws VoiceConfigError when none is usable. */
export async function getVoiceProviderForUser(userId: string, pinned?: PinnedVoice): Promise<VoiceProvider> {
  return providerFor(await resolveVoiceConfigForUser(userId, pinned));
}

/** Reads an episodes.voice value; undefined when absent (older episodes) or malformed. */
export function pinnedVoiceFrom(value: unknown): PinnedVoice | undefined {
  const v = value as Partial<PinnedVoice> | null;
  if (!v || (v.provider !== "grok" && v.provider !== "elevenlabs")) return undefined;
  if (typeof v.voiceA !== "string" || typeof v.voiceB !== "string") return undefined;
  return { provider: v.provider, voiceA: v.voiceA, voiceB: v.voiceB };
}

/** This instance's key for `provider`, null when unset; a corrupt one throws VoiceConfigError. */
function instanceApiKey(provider: VoiceProviderId): string | null {
  return process.env[ENV_API_KEY[provider]] ? envApiKey(ENV_API_KEY[provider]) : null;
}

function hasUsableInstanceKey(provider: VoiceProviderId): boolean {
  try {
    return instanceApiKey(provider) !== null;
  } catch {
    return false; // present but corrupt: leaving the key blank would fail, so don't offer it
  }
}

/** A request's resolved vendor key, and whose it is. */
export interface RequestApiKey {
  key: string;
  /**
   * "instance" is the operator's own account: its custom voices (clones,
   * designs) must not be offered to, or saved by, other users.
   */
  source: "pasted" | "stored" | "instance";
}

/**
 * The key a settings/voices/preview request should use: the one pasted into
 * the request, else the user's stored key for that same provider, else this
 * instance's env key. `null` asks for the instance key outright (the user is
 * clearing theirs), so the stored key is skipped. Null when there is none.
 */
export async function resolveRequestApiKey(
  userId: string,
  provider: VoiceProviderId,
  requested: string | null | undefined
): Promise<RequestApiKey | null> {
  const pasted = requested?.trim();
  if (pasted) return { key: pasted, source: "pasted" };
  if (requested !== null) {
    const row = await loadRow(userId);
    if (row?.provider === provider && row.api_key_enc) return { key: decryptKey(row.api_key_enc), source: "stored" };
  }
  const instance = instanceApiKey(provider);
  return instance ? { key: instance, source: "instance" } : null;
}

export interface VoiceSettingsInput {
  provider: VoiceProviderId;
  /** A key to store; null clears it (use the instance key); undefined or blank keeps the stored one if the provider is unchanged. */
  apiKey: string | null | undefined;
  voiceA: string;
  voiceB: string;
}

export async function saveUserVoiceSettings(userId: string, input: VoiceSettingsInput): Promise<void> {
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() || undefined : input.apiKey;
  let apiKeyEnc: string | null = null;
  if (apiKey) {
    apiKeyEnc = encrypt(apiKey);
  } else if (apiKey === undefined) {
    // Keep the stored key only for the same vendor: a Grok key means nothing to ElevenLabs.
    const existing = await loadRow(userId);
    if (existing?.provider === input.provider) apiKeyEnc = existing.api_key_enc;
  }
  const { error } = await db()
    .from(TABLE)
    .upsert(
      {
        user_id: userId,
        provider: input.provider,
        api_key_enc: apiKeyEnc,
        voice_a: input.voiceA,
        voice_b: input.voiceB,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
  if (error) throw new Error(`Voice settings save failed: ${error.message}`);
}

export async function deleteUserVoiceSettings(userId: string): Promise<void> {
  const { error } = await db().from(TABLE).delete().eq("user_id", userId);
  if (error) throw new Error(`Voice settings delete failed: ${error.message}`);
}

/** The GET /api/voice/settings shape. Never carries a key, only its last 4 chars. */
export interface VoiceSettingsView {
  provider: VoiceProviderId | null;
  source: "user" | "instance" | "none";
  voiceA: string | null;
  voiceB: string | null;
  ownKey: boolean;
  keyHint: string | null;
  instance: { grok: boolean; elevenlabs: boolean; provider: VoiceProviderId | null };
}

/**
 * What the Voices panel shows: the effective choice and where it comes from,
 * plus what this instance offers. `instance.grok` / `instance.elevenlabs` mean
 * the instance has a usable key for that vendor (so the user may leave theirs
 * blank).
 * Voices are null when unset (an ElevenLabs instance without voice ids can
 * transcribe but not render audio).
 */
export async function describeVoiceSettings(userId: string): Promise<VoiceSettingsView> {
  let instanceConfig: VoiceConfig | null = null;
  try {
    instanceConfig = resolveVoiceConfig();
  } catch {
    // A broken instance config counts as unavailable; the panel stays usable.
  }
  const instance = {
    grok: hasUsableInstanceKey("grok"),
    elevenlabs: hasUsableInstanceKey("elevenlabs"),
    provider: instanceConfig?.provider ?? null,
  };

  const row = await loadRow(userId);
  if (row) {
    return {
      provider: row.provider,
      source: "user",
      voiceA: row.voice_a,
      voiceB: row.voice_b,
      ownKey: !!row.api_key_enc,
      keyHint: row.api_key_enc ? keyHint(row.api_key_enc) : null,
      instance,
    };
  }
  if (instanceConfig) {
    return {
      provider: instanceConfig.provider,
      source: "instance",
      voiceA: instanceConfig.voiceA || null,
      voiceB: instanceConfig.voiceB || null,
      ownKey: false,
      keyHint: null,
      instance,
    };
  }
  return { provider: null, source: "none", voiceA: null, voiceB: null, ownKey: false, keyHint: null, instance };
}

function keyHint(enc: string): string | null {
  try {
    return decrypt(enc).slice(-4);
  } catch {
    return null; // unreadable (see decryptKey); the panel still shows that a key is stored
  }
}
