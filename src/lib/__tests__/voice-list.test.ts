import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidVoiceKeyError, listVoices, VoiceVendorError } from "../voice";

const GROK_VOICES = "https://api.x.ai/v1/tts/voices";
const GROK_CUSTOM = "https://api.x.ai/v1/custom-voices";
const ELEVENLABS_VOICES = "https://api.elevenlabs.io/v1/voices";

/** Stubs global fetch with one responder per URL; anything else fails the test. */
function stubFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const respond = routes[String(input)];
    if (!respond) throw new Error(`unexpected fetch ${String(input)}`);
    return respond();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The rejection of `promise`, failing the test if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: Error) => err
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("listVoices: Grok", () => {
  const builtin = [
    { voice_id: "ara", name: "Ara", language: "en", gender: "Female" },
    { voice_id: "helios", name: "Helios", language: "en", gender: "male" },
    { voice_id: "sol", name: "", gender: "neutral" },
    { name: "no id, skipped" },
  ];

  it("reads a bare array of built-in voices, sending the bearer key", async () => {
    const fetchMock = stubFetch({
      [GROK_VOICES]: () => Response.json(builtin),
      [GROK_CUSTOM]: () => new Response("not found", { status: 404 }),
    });
    expect(await listVoices("grok", "xai-key")).toEqual([
      { id: "ara", name: "Ara", gender: "female", kind: "builtin" },
      { id: "helios", name: "Helios", gender: "male", kind: "builtin" },
      { id: "sol", name: "sol", gender: null, kind: "builtin" },
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([GROK_VOICES, GROK_CUSTOM]);
    for (const [, init] of fetchMock.mock.calls) expect(init?.headers).toEqual({ Authorization: "Bearer xai-key" });
  });

  it("reads `{ voices }` and appends custom voices, by voice_id or id", async () => {
    stubFetch({
      [GROK_VOICES]: () => Response.json({ voices: builtin.slice(0, 1) }),
      [GROK_CUSTOM]: () => Response.json({ voices: [{ id: "cv_1", name: "My clone" }, { voice_id: "cv_2" }] }),
    });
    expect(await listVoices("grok", "xai-key")).toEqual([
      { id: "ara", name: "Ara", gender: "female", kind: "builtin" },
      { id: "cv_1", name: "My clone", gender: null, kind: "custom" },
      { id: "cv_2", name: "cv_2", gender: null, kind: "custom" },
    ]);
  });

  it("ignores a custom-voices call that fails outright (the feature is US-only)", async () => {
    stubFetch({
      [GROK_VOICES]: () => Response.json(builtin.slice(0, 1)),
      [GROK_CUSTOM]: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await listVoices("grok", "xai-key")).toHaveLength(1);
  });

  it("marks a rejected key (a plain 401, or xAI's 400 'Incorrect API key'), without the vendor body", async () => {
    const rejections = [
      () => new Response("unauthorized", { status: 401 }),
      () => Response.json({ error: "Incorrect API key provided: xa***yz" }, { status: 400 }),
    ];
    for (const respond of rejections) {
      stubFetch({ [GROK_VOICES]: respond });
      const err = await rejectionOf(listVoices("grok", "bad-key"));
      expect(err).toBeInstanceOf(InvalidVoiceKeyError);
      expect((err as InvalidVoiceKeyError).provider).toBe("grok");
      expect(err.message).toMatch(/^Grok voices rejected the API key \(40[01]\)$/);
    }
  });

  it("a 403, or a 400 that isn't about the key, is a vendor refusal, not a bad key", async () => {
    for (const [status, body] of [
      [403, "team has no credits"],
      [400, "invalid voice"],
    ] as const) {
      stubFetch({ [GROK_VOICES]: () => new Response(body, { status }) });
      const err = await rejectionOf(listVoices("grok", "xai-key"));
      expect(err).toBeInstanceOf(VoiceVendorError);
      expect(err).not.toBeInstanceOf(InvalidVoiceKeyError);
      expect((err as VoiceVendorError).status).toBe(status);
    }
  });

  it("reports outages and unexpected shapes as plain errors", async () => {
    stubFetch({ [GROK_VOICES]: () => new Response("boom", { status: 500 }) });
    const outage = await rejectionOf(listVoices("grok", "xai-key"));
    expect(outage).not.toBeInstanceOf(InvalidVoiceKeyError);
    expect(outage.message).toBe("Grok voices failed (500): boom");

    stubFetch({ [GROK_VOICES]: () => Response.json({ data: [] }) });
    await expect(listVoices("grok", "xai-key")).rejects.toThrow("Grok voices returned an unexpected response shape");
  });
});

describe("listVoices: ElevenLabs", () => {
  it("maps labels.gender; only premade voices are builtin, everything else is the key owner's", async () => {
    const fetchMock = stubFetch({
      [ELEVENLABS_VOICES]: () =>
        Response.json({
          voices: [
            { voice_id: "v1", name: "Rachel", category: "premade", labels: { gender: "female", accent: "american" } },
            { voice_id: "v2", name: "My clone", category: "cloned", labels: {} },
            { voice_id: "v3", name: "Designed", category: "generated", labels: { gender: "male" } },
            { voice_id: "v4", name: "Library pick", category: "professional", labels: null },
            { voice_id: "v5", name: "No category" },
            { name: "no id, skipped" },
          ],
        }),
    });
    expect(await listVoices("elevenlabs", "el-key")).toEqual([
      { id: "v1", name: "Rachel", gender: "female", kind: "builtin" },
      { id: "v2", name: "My clone", gender: null, kind: "custom" },
      { id: "v3", name: "Designed", gender: "male", kind: "custom" },
      { id: "v4", name: "Library pick", gender: null, kind: "custom" },
      { id: "v5", name: "No category", gender: null, kind: "custom" },
    ]);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ "xi-api-key": "el-key" });
  });

  it("401 invalid_api_key is a bad key; 401 quota_exceeded and 403 are vendor refusals", async () => {
    const invalid = { detail: { status: "invalid_api_key", message: "Invalid API key" } };
    stubFetch({ [ELEVENLABS_VOICES]: () => Response.json(invalid, { status: 401 }) });
    const rejected = await rejectionOf(listVoices("elevenlabs", "bad-key"));
    expect(rejected).toBeInstanceOf(InvalidVoiceKeyError);
    expect((rejected as InvalidVoiceKeyError).provider).toBe("elevenlabs");
    expect(rejected.message).toBe("ElevenLabs voices rejected the API key (401)");

    const quota = { detail: { status: "quota_exceeded", message: "This request exceeds your quota of 10000." } };
    for (const [status, body] of [
      [401, quota],
      [403, { detail: { status: "missing_permissions" } }],
    ] as const) {
      stubFetch({ [ELEVENLABS_VOICES]: () => Response.json(body, { status }) });
      const refused = await rejectionOf(listVoices("elevenlabs", "el-key"));
      expect(refused).toBeInstanceOf(VoiceVendorError);
      expect(refused).not.toBeInstanceOf(InvalidVoiceKeyError);
      expect(refused.message).toMatch(new RegExp(`^ElevenLabs voices failed \\(${status}\\): `));
    }
  });

  it("reports other failures plainly", async () => {
    stubFetch({ [ELEVENLABS_VOICES]: () => new Response("rate limited", { status: 429 }) });
    const limited = await rejectionOf(listVoices("elevenlabs", "el-key"));
    expect(limited).not.toBeInstanceOf(InvalidVoiceKeyError);
    expect(limited.message).toBe("ElevenLabs voices failed (429): rate limited");
  });
});
