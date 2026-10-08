import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decrypt, encrypt } from "@/lib/crypto";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { audioFrame } from "./mp3-fixtures";
import { clearVoiceEnv } from "./voice-env";

const state = vi.hoisted(() => ({ db: null as unknown, userId: "user-1" as string | null }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => state.userId }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/limits", () => ({ checkUsage: vi.fn(), UsageLimitError: class UsageLimitError extends Error {} }));

import * as settingsRoute from "@/app/api/voice/settings/route";
import { POST as voicesRoute } from "@/app/api/voice/voices/route";
import { POST as previewRoute } from "@/app/api/voice/preview/route";
import { checkUsage, UsageLimitError } from "@/lib/limits";

const USER = "user-1";
const PREVIEW_TEXT =
  "Hey, welcome back to your bookmark brief. Three of the posts you saved this week point at the same shift.";
const INSTANCE_KEY = "xai-instance-key";
const VALID_KEYS = ["xai-body-key-B0DY", "xai-stored-key-ST0R", INSTANCE_KEY, "el-body-key-E1EV"];
const OUT_OF_CREDITS_KEY = "xai-broke-key-NOCR"; // a real key whose account the vendor refuses (403)
const REFUSAL = "The voice provider refused the request — check that account's credits and permissions";

let fake: FakeDb;
let vendorCalls: { url: string; key: string | null; body: unknown }[];

/**
 * Vendor APIs that accept only VALID_KEYS and record which key every call used.
 * Rejections echo the key in their body, as xAI does with a masked fragment.
 * Each account has one custom (cloned) voice besides the shared ones.
 */
function stubVendors() {
  vendorCalls = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers.Authorization?.replace(/^Bearer /, "") ?? headers["xi-api-key"] ?? null;
    vendorCalls.push({ url, key, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (key === OUT_OF_CREDITS_KEY) return new Response(`team of ${key} has no credits left`, { status: 403 });
    if (!key || !VALID_KEYS.includes(key)) {
      return new Response(`Incorrect API key provided: ${key}`, { status: 401 });
    }
    if (url === "https://api.x.ai/v1/tts/voices") {
      return Response.json({ voices: ["ara", "helios", "eve"].map((id) => ({ voice_id: id, name: id, gender: "female" })) });
    }
    if (url === "https://api.x.ai/v1/custom-voices") {
      return Response.json({ voices: [{ voice_id: "acct-clone", name: "Account clone" }] });
    }
    if (url === "https://api.elevenlabs.io/v1/voices") {
      return Response.json({
        voices: [
          { voice_id: "rachel", name: "Rachel", category: "premade", labels: {} },
          { voice_id: "el-clone", name: "Account clone", category: "cloned", labels: {} },
        ],
      });
    }
    if (url === "https://api.x.ai/v1/tts" || url.startsWith("https://api.elevenlabs.io/v1/text-to-speech/")) {
      return new Response(new Uint8Array(audioFrame(1)), { headers: { "Content-Type": "audio/mpeg" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function request(body?: unknown, method = "POST"): NextRequest {
  return new NextRequest("http://localhost/api/voice", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function read(res: Response): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const text = await res.text();
  return { status: res.status, text, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {} };
}

function seed(provider: string, apiKeyEnc: string | null) {
  fake.tables.user_voice_settings.push({
    user_id: USER,
    provider,
    api_key_enc: apiKeyEnc,
    voice_a: "ara",
    voice_b: "helios",
  });
}
const seedKey = (provider: string, apiKey: string | null) => seed(provider, apiKey && encrypt(apiKey));
const storedRow = () => fake.tables.user_voice_settings.find((row) => row.user_id === USER);
const ids = (json: Record<string, unknown>) => (json.voices as { id: string }[]).map((v) => v.id);

beforeEach(() => {
  fake = createFakeDb({ user_voice_settings: [] });
  state.db = fake;
  state.userId = USER;
  clearVoiceEnv({ XAI_API_KEY: INSTANCE_KEY });
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {}); // apiError logs every rejection
  stubVendors();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("answers 401 without a session, before any work", async () => {
    state.userId = null;
    const responses = await Promise.all([
      settingsRoute.GET(),
      settingsRoute.PUT(request({ provider: "grok", voiceA: "ara", voiceB: "eve" }, "PUT")),
      settingsRoute.DELETE(),
      voicesRoute(request({ provider: "grok" })),
      previewRoute(request({ provider: "grok", voiceId: "eve" })),
    ]);
    expect(responses.map((res) => res.status)).toEqual([401, 401, 401, 401, 401]);
    expect(vendorCalls).toEqual([]);
    expect(checkUsage).not.toHaveBeenCalled();
  });
});

describe("GET/DELETE /api/voice/settings", () => {
  it("GET describes the effective settings without exposing the key", async () => {
    seedKey("grok", "xai-stored-key-ST0R");
    const { status, json, text } = await read(await settingsRoute.GET());
    expect(status).toBe(200);
    expect(json).toMatchObject({ provider: "grok", source: "user", ownKey: true, keyHint: "ST0R" });
    expect(text).not.toContain("xai-stored-key");
  });

  it("DELETE drops the user's row and answers with the instance defaults", async () => {
    seedKey("grok", "xai-stored-key-ST0R");
    const { status, json } = await read(await settingsRoute.DELETE());
    expect(status).toBe(200);
    expect(fake.tables.user_voice_settings).toEqual([]);
    expect(json).toMatchObject({ source: "instance", provider: "grok", voiceA: "ara", voiceB: "helios" });
  });
});

describe("PUT /api/voice/settings", () => {
  const save = (body: Record<string, unknown>) =>
    settingsRoute.PUT(request({ provider: "grok", voiceA: "ara", voiceB: "eve", ...body }, "PUT"));

  it("checks a pasted key against the vendor, then stores it encrypted", async () => {
    const { status, json, text } = await read(await save({ apiKey: "  xai-body-key-B0DY " }));
    expect(status).toBe(200);
    expect(vendorCalls.map((c) => c.key)).toEqual(["xai-body-key-B0DY", "xai-body-key-B0DY"]);
    expect(decrypt(storedRow()?.api_key_enc as string)).toBe("xai-body-key-B0DY");
    expect(json).toMatchObject({ source: "user", provider: "grok", voiceA: "ara", voiceB: "eve", ownKey: true, keyHint: "B0DY" });
    expect(text).not.toContain("xai-body-key");
    expect(checkUsage).toHaveBeenCalledWith(USER, "voice_list");
  });

  it("without a pasted key, uses the stored key for the same provider and keeps it", async () => {
    seedKey("grok", "xai-stored-key-ST0R");
    expect((await save({})).status).toBe(200);
    expect(vendorCalls[0].key).toBe("xai-stored-key-ST0R");
    expect(decrypt(storedRow()?.api_key_enc as string)).toBe("xai-stored-key-ST0R");
  });

  it("otherwise uses the instance key and saves the row without a key", async () => {
    seedKey("elevenlabs", "el-body-key-E1EV"); // a key for the other vendor is never sent to xAI
    const { status, json } = await read(await save({}));
    expect(status).toBe(200);
    expect(vendorCalls[0].key).toBe(INSTANCE_KEY);
    expect(storedRow()?.api_key_enc).toBeNull();
    expect(json).toMatchObject({ source: "user", ownKey: false, keyHint: null });
  });

  it("apiKey null checks the instance key and clears the stored one", async () => {
    seedKey("grok", "xai-stored-key-ST0R");
    expect((await save({ apiKey: null })).status).toBe(200);
    expect(vendorCalls[0].key).toBe(INSTANCE_KEY);
    expect(storedRow()?.api_key_enc).toBeNull();
  });

  it("with the instance key, the operator's custom voices can't be saved; with the user's own key they can", async () => {
    const onInstance = await read(await save({ voiceB: "acct-clone" }));
    expect(onInstance.status).toBe(400);
    expect(onInstance.json.error).toBe("Unknown voice id: acct-clone");
    expect(fake.tables.user_voice_settings).toEqual([]);

    expect((await save({ apiKey: "xai-body-key-B0DY", voiceB: "acct-clone" })).status).toBe(200);
    expect(storedRow()?.voice_b).toBe("acct-clone");
    expect((await save({ voiceA: "acct-clone" })).status).toBe(200); // now via the stored key
  });

  it("400 when there is no key at all, without spending a usage slot", async () => {
    const res = await read(
      await settingsRoute.PUT(request({ provider: "elevenlabs", voiceA: "rachel", voiceB: "rachel" }, "PUT"))
    );
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("This instance has no ElevenLabs key — paste your own");
    expect(vendorCalls).toEqual([]);
    expect(checkUsage).not.toHaveBeenCalled();
  });

  it("400 for a key the vendor rejects; nothing saved", async () => {
    const res = await read(await save({ apiKey: "xai-wrong-SECRET" }));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/^Invalid API key for Grok Voice/);
    expect(fake.tables.user_voice_settings).toEqual([]);
  });

  it("400 for a voice id the vendor doesn't list", async () => {
    const res = await read(await save({ voiceB: "nobody" }));
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Unknown voice id: nobody");
    expect(fake.tables.user_voice_settings).toEqual([]);
  });

  it("400 for a malformed body, before any vendor call", async () => {
    for (const body of [{ provider: "openai" }, { voiceA: "no spaces allowed" }, { voiceB: undefined }, { voiceA: ".." }]) {
      expect((await save(body)).status).toBe(400);
    }
    expect(vendorCalls).toEqual([]);
  });
});

describe("POST /api/voice/voices", () => {
  it("lists the vendor's voices with the resolved key, capped by voice_list", async () => {
    const { status, json } = await read(await voicesRoute(request({ provider: "elevenlabs", apiKey: "el-body-key-E1EV" })));
    expect(status).toBe(200);
    expect(json).toEqual({
      voices: [
        { id: "rachel", name: "Rachel", gender: null, kind: "builtin" },
        { id: "el-clone", name: "Account clone", gender: null, kind: "custom" },
      ],
    });
    expect(vendorCalls[0]).toMatchObject({ url: "https://api.elevenlabs.io/v1/voices", key: "el-body-key-E1EV" });
    expect(checkUsage).toHaveBeenCalledWith(USER, "voice_list");
  });

  it("hides the operator's custom voices when listing with the instance key", async () => {
    const onInstance = await read(await voicesRoute(request({ provider: "grok" })));
    expect(vendorCalls.map((c) => c.key)).toEqual([INSTANCE_KEY, INSTANCE_KEY]);
    expect(ids(onInstance.json)).toEqual(["ara", "helios", "eve"]);

    const ownKey = await read(await voicesRoute(request({ provider: "grok", apiKey: "xai-body-key-B0DY" })));
    expect(ids(ownKey.json)).toEqual(["ara", "helios", "eve", "acct-clone"]);

    vi.stubEnv("ELEVENLABS_API_KEY", "el-body-key-E1EV"); // the operator's ElevenLabs account
    const elevenOnInstance = await read(await voicesRoute(request({ provider: "elevenlabs" })));
    expect(ids(elevenOnInstance.json)).toEqual(["rachel"]);
  });

  it("400 for a rejected key", async () => {
    const res = await read(await voicesRoute(request({ provider: "elevenlabs", apiKey: "el-wrong" })));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/^Invalid API key for ElevenLabs/);
  });

  it("502 with a credits/permissions hint when the vendor refuses a valid account", async () => {
    const res = await read(await voicesRoute(request({ provider: "grok", apiKey: OUT_OF_CREDITS_KEY })));
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(new RegExp(`^${REFUSAL}`));
  });
});

describe("keys never come back in responses", () => {
  const leaky = [
    { name: "a rejected key (401)", key: "xai-leak-me-SECRET1", status: 400 },
    { name: "a refused account (403)", key: OUT_OF_CREDITS_KEY, status: 502 },
  ];

  for (const nodeEnv of ["test", "production"]) {
    it.each(leaky)(`$name, with NODE_ENV=${nodeEnv}`, async ({ key, status }) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const responses = await Promise.all([
        voicesRoute(request({ provider: "grok", apiKey: key })),
        previewRoute(request({ provider: "grok", apiKey: key, voiceId: "eve" })),
        settingsRoute.PUT(request({ provider: "grok", apiKey: key, voiceA: "ara", voiceB: "eve" }, "PUT")),
      ]);
      for (const res of responses) {
        const { status: got, text } = await read(res);
        expect(got).toBe(status);
        expect(text).not.toContain(key);
      }
      // the vendor really did echo the key: the routes kept it out
      expect(vendorCalls.length).toBeGreaterThan(0);
    });
  }
});

describe("an unreadable stored key", () => {
  it.each(["voices", "preview"])("%s: 400 naming the fix, before any usage or vendor call", async (route) => {
    seed("grok", "AAAA.BBBB.CCCC"); // e.g. APP_ENCRYPTION_KEY changed since it was saved
    const res = await read(
      route === "voices"
        ? await voicesRoute(request({ provider: "grok" }))
        : await previewRoute(request({ provider: "grok", voiceId: "eve" }))
    );
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Your saved voice API key can't be read — enter it again under Voices");
    expect(checkUsage).not.toHaveBeenCalled();
    expect(vendorCalls).toEqual([]);
  });
});

describe("POST /api/voice/preview", () => {
  it("returns the sentence as audio/mpeg in the chosen voice, capped by voice_preview", async () => {
    const res = await previewRoute(request({ provider: "grok", voiceId: "eve" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(audioFrame(1))).toBe(true);
    expect(vendorCalls[0]).toMatchObject({
      url: "https://api.x.ai/v1/tts",
      key: INSTANCE_KEY,
      body: { text: PREVIEW_TEXT, voice_id: "eve" },
    });
    expect(checkUsage).toHaveBeenCalledWith(USER, "voice_preview");
  });

  it("rejects voice ids that are too long, not [\\w.-], or only dots, before any work", async () => {
    for (const voiceId of ["../../voices", "eve?x=1", "a".repeat(101), "", ".", ".."]) {
      const res = await read(await previewRoute(request({ provider: "grok", voiceId })));
      expect(res.status, voiceId).toBe(400);
    }
    const dots = await read(await previewRoute(request({ provider: "grok", voiceId: ".." })));
    expect(dots.json.error).toBe("voiceId: voice id must contain a letter or digit");
    expect((await previewRoute(request({ provider: "grok", voiceId: "a".repeat(100) }))).status).toBe(200);
    expect(vendorCalls).toHaveLength(1);
    expect(checkUsage).toHaveBeenCalledTimes(1);
  });

  it("400 for a rejected key; 429 once the preview cap is spent", async () => {
    const rejected = await read(await previewRoute(request({ provider: "grok", apiKey: "xai-wrong", voiceId: "eve" })));
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toMatch(/^Invalid API key for Grok Voice/);

    vi.mocked(checkUsage).mockRejectedValueOnce(new UsageLimitError("Daily limit reached for voice preview (60/24h)."));
    const capped = await read(await previewRoute(request({ provider: "grok", voiceId: "eve" })));
    expect(capped.status).toBe(429);
    expect(vendorCalls).toHaveLength(1); // only the rejected-key attempt reached the vendor
  });
});
