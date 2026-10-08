import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getVoiceProvider,
  InvalidVoiceKeyError,
  isTtsReady,
  resolveVoiceConfig,
  VoiceConfigError,
  VoiceVendorError,
} from "../voice";
import type { VoiceConfig } from "../voice";
import { createElevenLabsProvider } from "../voice/elevenlabs";
import { createGrokProvider } from "../voice/grok";
import { audioFrame, clip, id3v2, mpeg2Frame24k } from "./mp3-fixtures";
import { clearVoiceEnv as voiceEnv } from "./voice-env";

// setup.ts pre-fills fake ELEVENLABS_* and XAI_API_KEY (and a real .env.local
// or the developer's shell may add more), so every test starts with all voice
// vars deleted and sets only what it needs. vi.unstubAllEnvs() restores them.

const ELEVENLABS_ENV = {
  ELEVENLABS_API_KEY: "el-env-key",
  ELEVENLABS_VOICE_HOST_A: "el-voice-a",
  ELEVENLABS_VOICE_HOST_B: "el-voice-b",
};
const MISSING = (name: string) =>
  `Missing ${name} on the server — paste your own key under Voices, or ask the operator to set it (see SETUP.md)`;
const ttsReady = () => isTtsReady(resolveVoiceConfig());

beforeEach(() => voiceEnv({}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveVoiceConfig", () => {
  it("returns null when neither ElevenLabs nor xAI is configured", () => {
    expect(resolveVoiceConfig()).toBeNull();
    expect(ttsReady()).toBe(false);
  });

  it("defaults to ElevenLabs when ELEVENLABS_API_KEY is set, even alongside an xAI key", () => {
    voiceEnv({ ...ELEVENLABS_ENV, XAI_API_KEY: "xai-env-key" });
    expect(resolveVoiceConfig()).toEqual({
      provider: "elevenlabs",
      apiKey: "el-env-key",
      voiceA: "el-voice-a",
      voiceB: "el-voice-b",
      model: "eleven_turbo_v2_5",
    });
    expect(ttsReady()).toBe(true);
  });

  it("uses ELEVENLABS_MODEL when set", () => {
    voiceEnv({ ...ELEVENLABS_ENV, ELEVENLABS_MODEL: "eleven_multilingual_v2" });
    expect(resolveVoiceConfig()?.model).toBe("eleven_multilingual_v2");
  });

  it("falls back to Grok with the ara/helios voices when only XAI_API_KEY is set", () => {
    voiceEnv({ XAI_API_KEY: "xai-env-key" });
    expect(resolveVoiceConfig()).toEqual({ provider: "grok", apiKey: "xai-env-key", voiceA: "ara", voiceB: "helios" });
    expect(ttsReady()).toBe(true);
  });

  it("lets GROK_VOICE_HOST_A/B replace the default Grok voices", () => {
    voiceEnv({ XAI_API_KEY: "xai-env-key", GROK_VOICE_HOST_A: "eve", GROK_VOICE_HOST_B: "leo" });
    expect(resolveVoiceConfig()).toMatchObject({ provider: "grok", voiceA: "eve", voiceB: "leo" });
  });

  it("lets an explicit VOICE_PROVIDER win over the default", () => {
    voiceEnv({ ...ELEVENLABS_ENV, XAI_API_KEY: "xai-env-key", VOICE_PROVIDER: "grok" });
    expect(resolveVoiceConfig()).toEqual({ provider: "grok", apiKey: "xai-env-key", voiceA: "ara", voiceB: "helios" });
  });

  it("treats an empty or blank VOICE_PROVIDER as unset", () => {
    voiceEnv({ XAI_API_KEY: "xai-env-key", VOICE_PROVIDER: "" });
    expect(resolveVoiceConfig()?.provider).toBe("grok");
    voiceEnv({ ...ELEVENLABS_ENV, VOICE_PROVIDER: "  " });
    expect(resolveVoiceConfig()?.provider).toBe("elevenlabs");
  });

  it("ignores case and surrounding whitespace in VOICE_PROVIDER", () => {
    voiceEnv({ ...ELEVENLABS_ENV, XAI_API_KEY: "xai-env-key", VOICE_PROVIDER: " Grok " });
    expect(resolveVoiceConfig()?.provider).toBe("grok");
    voiceEnv({ ...ELEVENLABS_ENV, XAI_API_KEY: "xai-env-key", VOICE_PROVIDER: "ElevenLabs\n" });
    expect(resolveVoiceConfig()?.provider).toBe("elevenlabs");
  });

  it("rejects an unknown VOICE_PROVIDER, naming the valid values", () => {
    voiceEnv({ ...ELEVENLABS_ENV, XAI_API_KEY: "xai-env-key", VOICE_PROVIDER: "openai" });
    const expected = 'Invalid VOICE_PROVIDER "openai" — use "grok" or "elevenlabs" (see SETUP.md step 4)';
    expect(() => resolveVoiceConfig()).toThrow(expected);
    expect(() => resolveVoiceConfig()).toThrow(VoiceConfigError);
    expect(ttsReady).toThrow(expected);
  });

  it("throws the env-style error when the selected provider's key is missing", () => {
    voiceEnv({ XAI_API_KEY: "xai-env-key", VOICE_PROVIDER: "elevenlabs" });
    expect(() => resolveVoiceConfig()).toThrow(MISSING("ELEVENLABS_API_KEY"));
    voiceEnv({ ...ELEVENLABS_ENV, VOICE_PROVIDER: "grok" });
    expect(() => resolveVoiceConfig()).toThrow(MISSING("XAI_API_KEY"));
    expect(() => resolveVoiceConfig()).toThrow(VoiceConfigError);
  });

  it("refuses an env key with whitespace or control characters, naming the variable but never the key", () => {
    for (const corrupt of ["xai-env-key\n", "xai env key", "xai-env-key\r", "\txai-env-key"]) {
      voiceEnv({ XAI_API_KEY: corrupt });
      const err = (() => {
        try {
          resolveVoiceConfig();
        } catch (e) {
          return e as Error;
        }
        throw new Error("expected resolveVoiceConfig to throw");
      })();
      expect(err).toBeInstanceOf(VoiceConfigError);
      expect(err.message).toBe("XAI_API_KEY contains whitespace or control characters — re-paste it");
    }
    voiceEnv({ ...ELEVENLABS_ENV, ELEVENLABS_API_KEY: "el-env-key " });
    expect(() => resolveVoiceConfig()).toThrow("ELEVENLABS_API_KEY contains whitespace or control characters");
    // An override (a user's own key) isn't an env key: it was validated when it was pasted.
    expect(resolveVoiceConfig({ provider: "elevenlabs", apiKey: "user-key" })?.apiKey).toBe("user-key");
  });

  it("resolves ElevenLabs without voice ids (transcription works) but isn't TTS-ready until both are set", () => {
    voiceEnv({ ELEVENLABS_API_KEY: "el-env-key" });
    expect(resolveVoiceConfig()).toEqual({
      provider: "elevenlabs",
      apiKey: "el-env-key",
      voiceA: "",
      voiceB: "",
      model: "eleven_turbo_v2_5",
    });
    expect(ttsReady()).toBe(false);
    voiceEnv({ ELEVENLABS_API_KEY: "el-env-key", ELEVENLABS_VOICE_HOST_A: "el-voice-a" });
    expect(ttsReady()).toBe(false);
    voiceEnv(ELEVENLABS_ENV);
    expect(ttsReady()).toBe(true);
  });

  it("refuses an apiKey override without its provider, so a key never reaches the other vendor", () => {
    voiceEnv({ ...ELEVENLABS_ENV, XAI_API_KEY: "xai-env-key", VOICE_PROVIDER: "grok" });
    expect(() => resolveVoiceConfig({ apiKey: "user-elevenlabs-key" })).toThrow("apiKey override requires provider");
    expect(() => getVoiceProvider({ apiKey: "user-elevenlabs-key", voiceA: "v" })).toThrow(
      "apiKey override requires provider"
    );
  });

  it("lets overrides win field by field, reading env defaults for the provider that wins", () => {
    voiceEnv({ ...ELEVENLABS_ENV, XAI_API_KEY: "xai-env-key", VOICE_PROVIDER: "elevenlabs" });
    expect(resolveVoiceConfig({ provider: "grok", apiKey: "user-xai-key", voiceA: "sal" })).toEqual({
      provider: "grok",
      apiKey: "user-xai-key",
      voiceA: "sal",
      voiceB: "helios",
    });
    expect(resolveVoiceConfig({ voiceB: "user-voice-b", model: "eleven_flash_v2_5" })).toEqual({
      provider: "elevenlabs",
      apiKey: "el-env-key",
      voiceA: "el-voice-a",
      voiceB: "user-voice-b",
      model: "eleven_flash_v2_5",
    });
  });

  it("needs no env key when the override brings its own", () => {
    expect(resolveVoiceConfig({ provider: "grok", apiKey: "user-xai-key" })).toEqual({
      provider: "grok",
      apiKey: "user-xai-key",
      voiceA: "ara",
      voiceB: "helios",
    });
    expect(
      resolveVoiceConfig({ provider: "elevenlabs", apiKey: "user-el-key", voiceA: "va", voiceB: "vb" })
    ).toEqual({ provider: "elevenlabs", apiKey: "user-el-key", voiceA: "va", voiceB: "vb", model: "eleven_turbo_v2_5" });
  });

  it("reads env lazily, so a bad config never throws at import", async () => {
    voiceEnv({ VOICE_PROVIDER: "bogus" });
    vi.resetModules();
    const voice = await import("../voice");
    await import("../tts");
    expect(() => voice.resolveVoiceConfig()).toThrow('Invalid VOICE_PROVIDER "bogus"');
  });
});

describe("getVoiceProvider", () => {
  it("throws a setup hint when no provider is configured", () => {
    expect(() => getVoiceProvider()).toThrow(
      "No voice provider configured — set VOICE_PROVIDER=grok (uses XAI_API_KEY) or VOICE_PROVIDER=elevenlabs (see SETUP.md step 4)"
    );
    expect(() => getVoiceProvider()).toThrow(VoiceConfigError);
  });

  it("builds the provider the config resolves to", () => {
    voiceEnv({ ...ELEVENLABS_ENV, XAI_API_KEY: "xai-env-key" });
    expect(getVoiceProvider().id).toBe("elevenlabs");
    expect(getVoiceProvider({ provider: "grok" }).id).toBe("grok");
  });
});

/** Stubs global fetch; `respond` builds a fresh Response per call since bodies are single-use. */
function stubFetch(respond: () => Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const mp3Response = (bytes: Buffer) =>
  new Response(new Uint8Array(bytes), { headers: { "Content-Type": "audio/mpeg" } });

function jsonBody(init: RequestInit | undefined): unknown {
  return JSON.parse(init?.body as string);
}

describe("Grok voice provider", () => {
  const config: VoiceConfig = { provider: "grok", apiKey: "xai-key", voiceA: "ara", voiceB: "helios" };

  it("posts one line to /v1/tts with the bearer key and a 44.1 kHz / 128 kbps mp3 format", async () => {
    const fetchMock = stubFetch(() => mp3Response(audioFrame(1)));
    await createGrokProvider(config).synthesize("Welcome back.", "A", { previousText: "x", nextText: "y" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/tts");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer xai-key", "Content-Type": "application/json" });
    // Exact body: the continuity context has no Grok equivalent and is not sent.
    expect(jsonBody(init)).toEqual({
      text: "Welcome back.",
      voice_id: "ara",
      language: "en",
      output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 128000 },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("voices host A with voiceA and host B with voiceB", async () => {
    const fetchMock = stubFetch(() => mp3Response(audioFrame(1)));
    const grok = createGrokProvider(config);
    await grok.synthesize("one", "A");
    await grok.synthesize("two", "B");
    expect(fetchMock.mock.calls.map(([, init]) => (jsonBody(init) as { voice_id: string }).voice_id)).toEqual([
      "ara",
      "helios",
    ]);
  });

  it("returns the audio frames with any ID3 tag stripped", async () => {
    const frames = Buffer.concat([audioFrame(0x11), audioFrame(0x22)]);
    stubFetch(() => mp3Response(Buffer.concat([id3v2(35), frames])));
    const out = await createGrokProvider(config).synthesize("Hi.", "B");
    expect(out.equals(frames)).toBe(true);
  });

  it("marks a rejected key without keeping the vendor body (it may echo the key)", async () => {
    stubFetch(() => new Response("Incorrect API key provided: xai-key", { status: 401 }));
    const failure = createGrokProvider(config).synthesize("Hi.", "A");
    await expect(failure).rejects.toThrow(/^Grok TTS rejected the API key \(401\)$/);
    await expect(failure).rejects.toBeInstanceOf(InvalidVoiceKeyError);
  });

  it("reports other failures with status and body, redacting the key if the vendor echoes it", async () => {
    stubFetch(() => new Response("upstream timeout", { status: 503 }));
    const outage = createGrokProvider(config).synthesize("Hi.", "A");
    await expect(outage).rejects.toThrow("Grok TTS failed (503): upstream timeout");
    await expect(outage).rejects.not.toBeInstanceOf(InvalidVoiceKeyError);
    stubFetch(() => new Response("team for key xai-key has no credits", { status: 403 }));
    const refused = createGrokProvider(config).synthesize("Hi.", "A");
    await expect(refused).rejects.toThrow("Grok TTS failed (403): team for key [redacted key] has no credits");
    await expect(refused).rejects.toBeInstanceOf(VoiceVendorError);
    await expect(refused).rejects.not.toBeInstanceOf(InvalidVoiceKeyError);
  });

  it("rejects a 200 whose body isn't 128 kbps / 44.1 kHz MP3, naming the content type", async () => {
    stubFetch(() => new Response(new Uint8Array(0), { headers: { "Content-Type": "audio/mpeg" } }));
    await expect(createGrokProvider(config).synthesize("Hi.", "A")).rejects.toThrow(
      "Grok TTS (content-type audio/mpeg): no MP3 audio frames (0 bytes)"
    );
    stubFetch(() => Response.json({ status: "queued" }));
    await expect(createGrokProvider(config).synthesize("Hi.", "A")).rejects.toThrow(
      "Grok TTS (content-type application/json): no MP3 audio frames"
    );
    stubFetch(() => mp3Response(mpeg2Frame24k()));
    await expect(createGrokProvider(config).synthesize("Hi.", "A")).rejects.toThrow("24000 Hz");
  });

  it("posts the media as a multipart `file` to /v1/stt and returns the trimmed text", async () => {
    const fetchMock = stubFetch(() =>
      Response.json({ text: "  hello from the video \n", language: "en", duration: 1.5, words: [] })
    );
    const media = Buffer.from("fake mp4 bytes");
    expect(await createGrokProvider(config).transcribe(media, "video/mp4", "video.mp4")).toBe(
      "hello from the video"
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/stt");
    expect(init?.method).toBe("POST");
    // No Content-Type: fetch must set the multipart boundary itself.
    expect(init?.headers).toEqual({ Authorization: "Bearer xai-key" });
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(["file"]); // no `language`, so STT auto-detects
    const file = form.get("file") as File;
    expect(file.name).toBe("video.mp4");
    expect(file.type).toBe("video/mp4");
    expect(Buffer.from(await file.arrayBuffer()).equals(media)).toBe(true);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on an empty transcript", async () => {
    stubFetch(() => Response.json({ text: "   ", language: "en", duration: 0, words: [] }));
    await expect(createGrokProvider(config).transcribe(Buffer.from("x"), "video/mp4")).rejects.toThrow(
      "Empty transcript"
    );
  });

  it("throws with the status and body when STT fails", async () => {
    stubFetch(() => new Response("unsupported media", { status: 415 }));
    await expect(createGrokProvider(config).transcribe(Buffer.from("x"), "video/mp4")).rejects.toThrow(
      "Grok STT failed (415): unsupported media"
    );
  });
});

describe("ElevenLabs voice provider", () => {
  const config: VoiceConfig = {
    provider: "elevenlabs",
    apiKey: "el-key",
    voiceA: "voice-alex",
    voiceB: "voice-blake",
    model: "eleven_turbo_v2_5",
  };

  it("posts to the host's voice with mp3_44100_128, xi-api-key, the model and clipped continuity text", async () => {
    const fetchMock = stubFetch(() => mp3Response(audioFrame(1)));
    await createElevenLabsProvider(config).synthesize("Line for Blake.", "B", {
      previousText: "#".repeat(100) + "p".repeat(500),
      nextText: "n".repeat(500) + "#".repeat(100),
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-blake?output_format=mp3_44100_128");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "xi-api-key": "el-key", "Content-Type": "application/json" });
    expect(jsonBody(init)).toEqual({
      text: "Line for Blake.",
      model_id: "eleven_turbo_v2_5",
      previous_text: "p".repeat(500), // last 500 chars
      next_text: "n".repeat(500), // first 500 chars
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("URL-encodes the voice id, since user-chosen ids end up in the path", async () => {
    const fetchMock = stubFetch(() => mp3Response(audioFrame(1)));
    await createElevenLabsProvider({ ...config, voiceA: "a/b?c#d" }).synthesize("Hi.", "A");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/a%2Fb%3Fc%23d?output_format=mp3_44100_128"
    );
  });

  it("names the missing host voice instead of calling the API", async () => {
    const fetchMock = stubFetch(() => mp3Response(audioFrame(1)));
    const noVoices = createElevenLabsProvider({ ...config, voiceA: "", voiceB: "" });
    await expect(noVoices.synthesize("Hi.", "A")).rejects.toThrow(
      "ElevenLabs voice for host A is not set — set ELEVENLABS_VOICE_HOST_A or choose voices in the app"
    );
    await expect(noVoices.synthesize("Hi.", "B")).rejects.toThrow(VoiceConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a 200 JSON body instead of returning an empty clip", async () => {
    stubFetch(() => Response.json({ detail: "something odd" }));
    await expect(createElevenLabsProvider(config).synthesize("Hi.", "A")).rejects.toThrow(
      "ElevenLabs TTS (content-type application/json): no MP3 audio frames (0 bytes)"
    );
  });

  it("uses voiceA for host A, omits absent neighbors, and defaults to the turbo model", async () => {
    const fetchMock = stubFetch(() => mp3Response(audioFrame(1)));
    await createElevenLabsProvider({ ...config, model: undefined }).synthesize("Solo line.", "A");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-alex?output_format=mp3_44100_128");
    expect(jsonBody(init)).toEqual({ text: "Solo line.", model_id: "eleven_turbo_v2_5" });
  });

  it("returns only the audio frames of each clip (ID3 tag and Info frame dropped)", async () => {
    stubFetch(() => mp3Response(clip(2, 0x33)));
    const out = await createElevenLabsProvider(config).synthesize("Hi.", "A");
    expect(out.equals(Buffer.concat([audioFrame(0x33), audioFrame(0x33)]))).toBe(true);
  });

  it("throws with the status and body when TTS fails", async () => {
    stubFetch(() => new Response("quota exceeded", { status: 429 }));
    await expect(createElevenLabsProvider(config).synthesize("Hi.", "A")).rejects.toThrow(
      "ElevenLabs TTS failed (429): quota exceeded"
    );
  });

  it("transcribes via Scribe: multipart model_id=scribe_v2 plus the file", async () => {
    const fetchMock = stubFetch(() => Response.json({ text: " scribe transcript " }));
    // ingest hands over the ArrayBuffer straight from fetch()
    const media = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(await createElevenLabsProvider(config).transcribe(media, "video/mp4", "video.mp4")).toBe(
      "scribe transcript"
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "xi-api-key": "el-key" });
    const form = init?.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    const file = form.get("file") as File;
    expect(file.name).toBe("video.mp4");
    expect(file.type).toBe("video/mp4");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws Scribe errors with the status, and on an empty transcript", async () => {
    stubFetch(() => new Response("bad file", { status: 400 }));
    await expect(createElevenLabsProvider(config).transcribe(Buffer.from("x"), "video/mp4")).rejects.toThrow(
      "Scribe failed (400): bad file"
    );
    stubFetch(() => Response.json({ text: "" }));
    await expect(createElevenLabsProvider(config).transcribe(Buffer.from("x"), "video/mp4")).rejects.toThrow(
      "Empty transcript"
    );
  });
});
