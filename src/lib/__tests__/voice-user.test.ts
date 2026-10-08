import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt } from "../crypto";
import { isTtsReady, VoiceConfigError } from "../voice";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { audioFrame } from "./mp3-fixtures";
import { clearVoiceEnv } from "./voice-env";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../supabase", () => ({ db: () => state.db }));

import {
  deleteUserVoiceSettings,
  describeVoiceSettings,
  getVoiceProviderForUser,
  loadUserVoiceOverrides,
  pinnedVoiceFrom,
  resolveRequestApiKey,
  resolveVoiceConfigForUser,
  saveUserVoiceSettings,
} from "../voice/user";

const USER = "user-1";
const MISSING = (name: string) =>
  `Missing ${name} on the server — paste your own key under Voices, or ask the operator to set it (see SETUP.md)`;
const ttsReadyFor = async (userId: string) => isTtsReady(await resolveVoiceConfigForUser(userId));

let fake: FakeDb;

beforeEach(() => {
  fake = createFakeDb({ user_voice_settings: [] });
  state.db = fake;
  clearVoiceEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function seed(provider: string, apiKey: string | null, voiceA = "va", voiceB = "vb", userId = USER) {
  fake.tables.user_voice_settings.push({
    user_id: userId,
    provider,
    api_key_enc: apiKey ? encrypt(apiKey) : null,
    voice_a: voiceA,
    voice_b: voiceB,
  });
}
const storedRow = () => fake.tables.user_voice_settings.find((row) => row.user_id === USER);
const storedKey = () => {
  const enc = storedRow()?.api_key_enc as string | null;
  return enc ? decrypt(enc) : null;
};

describe("loadUserVoiceOverrides", () => {
  it("returns the row as overrides, with the stored key decrypted", async () => {
    seed("grok", "xai-user-key");
    expect(await loadUserVoiceOverrides(USER)).toEqual({
      provider: "grok",
      voiceA: "va",
      voiceB: "vb",
      apiKey: "xai-user-key",
    });
  });

  it("omits apiKey when the row uses the instance key, and is null without a row", async () => {
    seed("elevenlabs", null);
    expect(await loadUserVoiceOverrides(USER)).not.toHaveProperty("apiKey");
    expect(await loadUserVoiceOverrides("someone-else")).toBeNull();
  });

  it("reports an unreadable stored key as a config error the user can fix", async () => {
    fake.tables.user_voice_settings.push({ user_id: USER, provider: "grok", api_key_enc: "AAAA.BBBB.CCCC", voice_a: "a", voice_b: "b" });
    const failure = loadUserVoiceOverrides(USER);
    await expect(failure).rejects.toThrow("Your saved voice API key can't be read — enter it again under Voices");
    await expect(failure).rejects.toBeInstanceOf(VoiceConfigError);
  });
});

describe("saveUserVoiceSettings", () => {
  it("stores a new key encrypted (trimmed), with the voices and updated_at", async () => {
    await saveUserVoiceSettings(USER, { provider: "grok", apiKey: "  xai-new-key ", voiceA: "ara", voiceB: "eve" });
    expect(storedRow()).toMatchObject({ provider: "grok", voice_a: "ara", voice_b: "eve" });
    expect(storedRow()?.api_key_enc).not.toContain("xai-new-key");
    expect(storedKey()).toBe("xai-new-key");
    expect(new Date(storedRow()?.updated_at as string).getTime()).toBeGreaterThan(0);
  });

  it("keeps the stored key when apiKey is undefined or blank and the provider is unchanged", async () => {
    seed("grok", "xai-kept-key");
    await saveUserVoiceSettings(USER, { provider: "grok", apiKey: undefined, voiceA: "x", voiceB: "y" });
    expect(storedKey()).toBe("xai-kept-key");
    await saveUserVoiceSettings(USER, { provider: "grok", apiKey: "   ", voiceA: "x", voiceB: "z" });
    expect(storedKey()).toBe("xai-kept-key");
    expect(storedRow()?.voice_b).toBe("z");
    expect(fake.tables.user_voice_settings).toHaveLength(1);
  });

  it("drops a kept key when the provider changes, and clears it on null", async () => {
    seed("grok", "xai-kept-key");
    await saveUserVoiceSettings(USER, { provider: "elevenlabs", apiKey: undefined, voiceA: "x", voiceB: "y" });
    expect(storedRow()?.api_key_enc).toBeNull();

    seed("grok", "xai-other-key", "a", "b", "user-2");
    await saveUserVoiceSettings("user-2", { provider: "grok", apiKey: null, voiceA: "a", voiceB: "b" });
    expect(fake.tables.user_voice_settings.find((row) => row.user_id === "user-2")?.api_key_enc).toBeNull();
  });
});

describe("deleteUserVoiceSettings", () => {
  it("removes only this user's row", async () => {
    seed("grok", null);
    seed("grok", null, "a", "b", "user-2");
    await deleteUserVoiceSettings(USER);
    expect(fake.tables.user_voice_settings.map((row) => row.user_id)).toEqual(["user-2"]);
  });
});

describe("describeVoiceSettings", () => {
  it("source user: own key shown only by its last 4 characters", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    seed("grok", "xai-secret-key-WXYZ");
    const view = await describeVoiceSettings(USER);
    expect(view).toEqual({
      provider: "grok",
      source: "user",
      voiceA: "va",
      voiceB: "vb",
      ownKey: true,
      keyHint: "WXYZ",
      instance: { grok: true, elevenlabs: false, provider: "grok" },
    });
    expect(JSON.stringify(view)).not.toContain("xai-secret-key");
  });

  it("source user on the instance key", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "el-instance-key");
    seed("elevenlabs", null);
    expect(await describeVoiceSettings(USER)).toMatchObject({ source: "user", ownKey: false, keyHint: null });
  });

  it("source instance: the env defaults", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    expect(await describeVoiceSettings(USER)).toEqual({
      provider: "grok",
      source: "instance",
      voiceA: "ara",
      voiceB: "helios",
      ownKey: false,
      keyHint: null,
      instance: { grok: true, elevenlabs: false, provider: "grok" },
    });
  });

  it("instance.elevenlabs means the key is present; unset instance voices read as null", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "el-instance-key");
    expect(await describeVoiceSettings(USER)).toMatchObject({
      provider: "elevenlabs",
      source: "instance",
      voiceA: null,
      voiceB: null,
      instance: { grok: false, elevenlabs: true, provider: "elevenlabs" },
    });
  });

  it("source none when nothing is configured", async () => {
    expect(await describeVoiceSettings(USER)).toEqual({
      provider: null,
      source: "none",
      voiceA: null,
      voiceB: null,
      ownKey: false,
      keyHint: null,
      instance: { grok: false, elevenlabs: false, provider: null },
    });
  });

  it("a corrupt instance key doesn't count as available", async () => {
    vi.stubEnv("XAI_API_KEY", "xai instance key");
    expect(await describeVoiceSettings(USER)).toMatchObject({
      source: "none",
      instance: { grok: false, elevenlabs: false, provider: null },
    });
  });

  it("never throws on a broken instance config", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    vi.stubEnv("VOICE_PROVIDER", "bogus");
    expect(await describeVoiceSettings(USER)).toMatchObject({
      source: "none",
      instance: { grok: true, elevenlabs: false, provider: null },
    });
    seed("grok", null);
    expect(await describeVoiceSettings(USER)).toMatchObject({ source: "user", instance: { provider: null } });
  });
});

describe("per-user resolution", () => {
  it("prefers the user's settings over the instance default", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "el-instance-key");
    vi.stubEnv("ELEVENLABS_VOICE_HOST_A", "el-a");
    vi.stubEnv("ELEVENLABS_VOICE_HOST_B", "el-b");
    seed("grok", "xai-user-key");
    expect(await resolveVoiceConfigForUser(USER)).toEqual({
      provider: "grok",
      apiKey: "xai-user-key",
      voiceA: "va",
      voiceB: "vb",
    });
    expect((await getVoiceProviderForUser(USER)).id).toBe("grok");
    expect(await ttsReadyFor(USER)).toBe(true);
  });

  it("uses the instance key for a row without one, and the env defaults without a row", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    seed("grok", null);
    expect((await resolveVoiceConfigForUser(USER))?.apiKey).toBe("xai-instance-key");
    expect(await resolveVoiceConfigForUser("someone-else")).toMatchObject({ voiceA: "ara", voiceB: "helios" });
  });

  it("is not configured without any provider, and throws a config error for a keyless ElevenLabs row", async () => {
    expect(await ttsReadyFor(USER)).toBe(false);
    await expect(getVoiceProviderForUser(USER)).rejects.toThrow("No voice provider configured");
    seed("elevenlabs", null);
    await expect(ttsReadyFor(USER)).rejects.toThrow(MISSING("ELEVENLABS_API_KEY"));
  });

  it("an ElevenLabs instance without voices is only TTS-ready once the user picks voices", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "el-instance-key");
    expect(await ttsReadyFor(USER)).toBe(false);
    seed("elevenlabs", null, "voice-1", "voice-2");
    expect(await ttsReadyFor(USER)).toBe(true);
  });
});

describe("pinned episode voices", () => {
  const pinned = { provider: "grok" as const, voiceA: "pin-a", voiceB: "pin-b" };

  it("pinned provider and voices win; the user's key is used when it belongs to that provider", async () => {
    seed("grok", "xai-user-key", "now-a", "now-b");
    expect(await resolveVoiceConfigForUser(USER, pinned)).toEqual({
      provider: "grok",
      apiKey: "xai-user-key",
      voiceA: "pin-a",
      voiceB: "pin-b",
    });
  });

  it("a stored key for another provider is not used: the instance key fills in", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    seed("elevenlabs", "el-user-key", "now-a", "now-b");
    expect(await resolveVoiceConfigForUser(USER, pinned)).toMatchObject({ apiKey: "xai-instance-key", voiceA: "pin-a" });
  });

  it("an unreadable stored key for the other vendor is never decrypted, so it can't block the render", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    fake.tables.user_voice_settings.push({
      user_id: USER,
      provider: "elevenlabs",
      api_key_enc: "AAAA.BBBB.CCCC",
      voice_a: "now-a",
      voice_b: "now-b",
    });
    expect(await resolveVoiceConfigForUser(USER, pinned)).toMatchObject({ provider: "grok", apiKey: "xai-instance-key" });
    // The same unreadable key does block when it belongs to the pinned provider.
    await expect(resolveVoiceConfigForUser(USER, { ...pinned, provider: "elevenlabs" })).rejects.toThrow(
      VoiceConfigError
    );
  });

  it("without any key for the pinned provider, the usual missing-key error", async () => {
    seed("elevenlabs", "el-user-key");
    await expect(getVoiceProviderForUser(USER, pinned)).rejects.toThrow(MISSING("XAI_API_KEY"));
  });

  it("the provider it builds voices each host with the pinned voice", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(audioFrame(1))));
    vi.stubGlobal("fetch", fetchMock);
    await (await getVoiceProviderForUser(USER, pinned)).synthesize("Hello.", "B");
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).voice_id).toBe("pin-b");
  });

  it("pinnedVoiceFrom keeps only a well-formed snapshot (and never a key)", () => {
    expect(pinnedVoiceFrom({ ...pinned, apiKey: "leaked" })).toEqual(pinned);
    expect(pinnedVoiceFrom(null)).toBeUndefined();
    expect(pinnedVoiceFrom({ provider: "openai", voiceA: "a", voiceB: "b" })).toBeUndefined();
    expect(pinnedVoiceFrom({ provider: "grok", voiceA: "a" })).toBeUndefined();
  });
});

describe("resolveRequestApiKey", () => {
  it("pasted key, then the stored key for that provider, then the instance key, else null", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    seed("grok", "xai-stored-key");
    expect(await resolveRequestApiKey(USER, "grok", "  xai-pasted-key ")).toEqual({ key: "xai-pasted-key", source: "pasted" });
    expect(await resolveRequestApiKey(USER, "grok", undefined)).toEqual({ key: "xai-stored-key", source: "stored" });
    expect(await resolveRequestApiKey(USER, "grok", "   ")).toEqual({ key: "xai-stored-key", source: "stored" });
    expect(await resolveRequestApiKey(USER, "elevenlabs", undefined)).toBeNull();
    vi.stubEnv("ELEVENLABS_API_KEY", "el-instance-key");
    expect(await resolveRequestApiKey(USER, "elevenlabs", undefined)).toEqual({ key: "el-instance-key", source: "instance" });
  });

  it("null asks for the instance key, skipping the stored one", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    seed("grok", "xai-stored-key");
    expect(await resolveRequestApiKey(USER, "grok", null)).toEqual({ key: "xai-instance-key", source: "instance" });
  });

  it("a corrupt instance key is a config error naming the variable, never the key", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key\n");
    const failure = resolveRequestApiKey(USER, "grok", undefined);
    await expect(failure).rejects.toThrow(/^XAI_API_KEY contains whitespace or control characters — re-paste it$/);
    await expect(failure).rejects.toBeInstanceOf(VoiceConfigError);
  });
});
