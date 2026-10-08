import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encrypt } from "@/lib/crypto";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { audioFrame } from "./mp3-fixtures";
import { clearVoiceEnv } from "./voice-env";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => "user-1" }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/limits", () => ({ checkUsage: vi.fn(), UsageLimitError: class UsageLimitError extends Error {} }));

import { POST } from "@/app/api/digest/render/route";
import { checkUsage } from "@/lib/limits";

let fake: FakeDb;
let ttsCalls: { url: string; key: string | null; voice: string | undefined }[];

function stubTts(validKeys: string[]) {
  ttsCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const key = headers.Authorization?.replace(/^Bearer /, "") ?? headers["xi-api-key"] ?? null;
      ttsCalls.push({ url: String(input), key, voice: JSON.parse(init?.body as string).voice_id });
      if (!key || !validKeys.includes(key)) return new Response("unauthorized", { status: 401 });
      return new Response(new Uint8Array(audioFrame(1)), { headers: { "Content-Type": "audio/mpeg" } });
    })
  );
}

function episode(voice: unknown) {
  return {
    id: "ep-1",
    user_id: "user-1",
    status: "draft",
    script: [
      { speaker: "A", line: "One." },
      { speaker: "B", line: "Two." },
    ],
    markdown_path: "user-1/2026-10-07-12-00/brief.md",
    render_cursor: 0,
    voice,
  };
}

function userSettings(provider: string, apiKey: string | null) {
  return { user_id: "user-1", provider, api_key_enc: apiKey && encrypt(apiKey), voice_a: "now-a", voice_b: "now-b" };
}

async function render(): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/digest/render", {
      method: "POST",
      body: JSON.stringify({ episodeId: "ep-1", cursor: 0 }),
    })
  );
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  clearVoiceEnv();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {}); // apiError logs every rejection
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/digest/render voices", () => {
  it("finishes a pinned episode in its pinned voices after the user switched provider", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    fake = createFakeDb({
      episodes: [episode({ provider: "grok", voiceA: "pin-a", voiceB: "pin-b" })],
      user_voice_settings: [userSettings("elevenlabs", "el-user-key")],
    });
    state.db = fake;
    stubTts(["xai-instance-key"]);

    expect(await render()).toEqual({ status: 200, json: { nextCursor: 2, totalLines: 2, done: true } });
    expect(ttsCalls).toEqual([
      { url: "https://api.x.ai/v1/tts", key: "xai-instance-key", voice: "pin-a" },
      { url: "https://api.x.ai/v1/tts", key: "xai-instance-key", voice: "pin-b" },
    ]);
    expect(fake.uploads).toEqual([{ bucket: "episodes", path: "user-1/2026-10-07-12-00/chunks/00000.mp3" }]);
    expect(fake.tables.episodes[0].render_cursor).toBe(2);
  });

  it("uses the user's current settings for an episode without a pin", async () => {
    fake = createFakeDb({ episodes: [episode(null)], user_voice_settings: [userSettings("grok", "xai-user-key")] });
    state.db = fake;
    stubTts(["xai-user-key"]);

    expect((await render()).status).toBe(200);
    expect(ttsCalls.map((c) => [c.key, c.voice])).toEqual([
      ["xai-user-key", "now-a"],
      ["xai-user-key", "now-b"],
    ]);
  });

  it("resolves the voice before the usage gate: a broken config is a 400 that spends no slot", async () => {
    fake = createFakeDb({
      episodes: [episode({ provider: "grok", voiceA: "pin-a", voiceB: "pin-b" })],
      user_voice_settings: [userSettings("elevenlabs", "el-user-key")],
    });
    state.db = fake;
    stubTts([]);

    expect(await render()).toEqual({
      status: 400,
      json: {
        error:
          "Missing XAI_API_KEY on the server — paste your own key under Voices, or ask the operator to set it (see SETUP.md)",
      },
    });
    expect(checkUsage).not.toHaveBeenCalled();
    expect(ttsCalls).toEqual([]);
    expect(fake.uploads).toEqual([]);
  });

  it("an unreadable key for the other vendor doesn't block a pinned render", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-instance-key");
    const broken = { ...userSettings("elevenlabs", null), api_key_enc: "AAAA.BBBB.CCCC" };
    fake = createFakeDb({
      episodes: [episode({ provider: "grok", voiceA: "pin-a", voiceB: "pin-b" })],
      user_voice_settings: [broken],
    });
    state.db = fake;
    stubTts(["xai-instance-key"]);

    expect((await render()).status).toBe(200);
    expect(ttsCalls.map((c) => c.key)).toEqual(["xai-instance-key", "xai-instance-key"]);
  });

  it("a vendor refusal (quota/permissions) gets a hint, not a bad-key message", async () => {
    fake = createFakeDb({ episodes: [episode(null)], user_voice_settings: [userSettings("grok", "xai-user-key")] });
    state.db = fake;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("team has no credits", { status: 403 }))
    );
    const { status, json } = await render();
    expect(status).toBe(502);
    expect(json.error).toMatch(/^The voice provider refused the request — check that account's credits and permissions/);
  });

  it("reports a key the vendor rejects as the user's to fix", async () => {
    fake = createFakeDb({ episodes: [episode(null)], user_voice_settings: [userSettings("grok", "xai-revoked")] });
    state.db = fake;
    stubTts([]);

    const { status, json } = await render();
    expect(status).toBe(400);
    expect(json.error).toMatch(/^The voice provider rejected the API key — update it under Voices/);
    expect(fake.uploads).toEqual([]);
  });
});
