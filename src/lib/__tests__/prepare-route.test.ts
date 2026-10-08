import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encrypt } from "@/lib/crypto";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { clearVoiceEnv } from "./voice-env";

// Only the voice guard, the format normalization and the episode's voice snapshot are under test.
// Everything that would touch the session, a paid API or real storage is
// mocked, so "no work happened" is observable.
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/session", () => ({ getSessionUserId: vi.fn(async () => "user-1") }));
vi.mock("@/lib/brain", () => ({
  selectBookmarksForDigest: vi.fn(async () => ({ included: [], excludedAsMisleading: [] })),
  stalenessPass: vi.fn(async () => new Map()),
  writeMarkdownDigest: vi.fn(async () => "# Brief"),
}));
vi.mock("@/lib/limits", () => ({ checkUsage: vi.fn(), UsageLimitError: class UsageLimitError extends Error {} }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/episodes", () => ({ signEpisodeUrls: vi.fn(async (episode: unknown) => episode) }));

import { POST } from "@/app/api/digest/prepare/route";
import { selectBookmarksForDigest } from "@/lib/brain";
import { checkUsage } from "@/lib/limits";

let fake: FakeDb;

async function prepare(format: string): Promise<{ status: number; error?: string; done?: boolean }> {
  const res = await POST(
    new NextRequest("http://localhost/api/digest/prepare", { method: "POST", body: JSON.stringify({ format }) })
  );
  const json = await res.json();
  return { status: res.status, error: json.error, done: json.done };
}

/** Makes the (mocked) selection non-empty so prepare runs through to the episode insert. */
function withOneBookmark() {
  vi.mocked(selectBookmarksForDigest).mockResolvedValueOnce({
    included: [{ tweet_id: "1" }],
    excludedAsMisleading: [],
  } as unknown as Awaited<ReturnType<typeof selectBookmarksForDigest>>);
}
const insertedVoice = () => fake.tables.episodes?.[0]?.voice;

beforeEach(() => {
  fake = createFakeDb({ user_voice_settings: [], episodes: [] });
  state.db = fake;
  clearVoiceEnv();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {}); // apiError logs every rejection
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/digest/prepare voice guard", () => {
  // "audio" is a legacy alias of "both" (old clients may still send it), so the same guard applies to each.
  it.each(["both", "audio"])("rejects a %s brief with 400 before any DB or paid work", async (format) => {
    const { status, error } = await prepare(format); // no voice provider anywhere
    expect(status).toBe(400);
    expect(error).toBe(
      "Audio briefs need a voice provider — connect Grok Voice or ElevenLabs under Voices, or set VOICE_PROVIDER on the server, or choose a markdown-only brief"
    );
    expect(selectBookmarksForDigest).not.toHaveBeenCalled();
    expect(checkUsage).not.toHaveBeenCalled();
  });

  it("reports a broken voice config with its own message, as the same 400, before any work", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    vi.stubEnv("VOICE_PROVIDER", "grokk");
    const { status, error } = await prepare("both");
    expect(status).toBe(400);
    expect(error).toBe('Invalid VOICE_PROVIDER "grokk" — use "grok" or "elevenlabs" (see SETUP.md step 4)');
    expect(selectBookmarksForDigest).not.toHaveBeenCalled();
  });

  it("an ElevenLabs instance without host voices can't do audio (it can still transcribe): a specific 400", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "el-instance-key");
    vi.stubEnv("ELEVENLABS_VOICE_HOST_A", "only-host-a");
    expect(await prepare("both")).toEqual({
      status: 400,
      error:
        "ElevenLabs voices aren't set — choose voices under Voices, or set ELEVENLABS_VOICE_HOST_A and ELEVENLABS_VOICE_HOST_B on the server",
    });
    expect(selectBookmarksForDigest).not.toHaveBeenCalled();
  });

  it("lets a markdown-only brief through without a voice provider, pinning no voice", async () => {
    withOneBookmark();
    expect((await prepare("markdown")).status).toBe(200);
    expect(fake.tables.episodes).toHaveLength(1);
    expect(insertedVoice()).toBeNull();
  });

  it("pins the instance default voices on a markdown + podcast brief", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    withOneBookmark();
    expect((await prepare("both")).status).toBe(200);
    expect(insertedVoice()).toEqual({ provider: "grok", voiceA: "ara", voiceB: "helios" });
  });

  it("pins the user's connected voices, never their key", async () => {
    fake.tables.user_voice_settings.push({
      user_id: "user-1",
      provider: "elevenlabs",
      api_key_enc: encrypt("el-user-key-1234"),
      voice_a: "rachel",
      voice_b: "adam",
    });
    withOneBookmark();
    expect((await prepare("both")).status).toBe(200);
    expect(insertedVoice()).toEqual({ provider: "elevenlabs", voiceA: "rachel", voiceB: "adam" });
    expect(JSON.stringify(fake.tables.episodes)).not.toContain("el-user-key");
  });
});

describe("POST /api/digest/prepare format", () => {
  beforeEach(() => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key"); // a voice provider, so only the format varies
  });

  const pinned = { provider: "grok", voiceA: "ara", voiceB: "helios" };

  // The server accepts all three values, but "audio" behaves as "both": the markdown is written first
  // either way, so an old client that still sends "audio" gets what the picker's "Markdown + Podcast"
  // makes. Stored as "both", a draft the client continues to the audio stages (done: false), voices
  // pinned. Anything unrecognised falls back to "both" too.
  it.each([
    { sent: "markdown", stored: "markdown", episodeStatus: "ready", done: true, voice: null },
    { sent: "both", stored: "both", episodeStatus: "draft", done: false, voice: pinned },
    { sent: "audio", stored: "both", episodeStatus: "draft", done: false, voice: pinned },
    { sent: "unknown", stored: "both", episodeStatus: "draft", done: false, voice: pinned },
  ])("format $sent is stored as $stored", async ({ sent, stored, episodeStatus, done, voice }) => {
    withOneBookmark();
    expect(await prepare(sent)).toMatchObject({ status: 200, done });
    expect(fake.tables.episodes).toHaveLength(1);
    expect(fake.tables.episodes[0]).toMatchObject({ format: stored, status: episodeStatus, voice });
  });
});
