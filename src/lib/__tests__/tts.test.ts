import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateDurationSeconds, renderPodcast } from "../tts";
import type { ScriptLine } from "../brain";
import type { SynthesizeContext, VoiceProvider } from "../voice";
import { audioFrame } from "./mp3-fixtures";
import { clearVoiceEnv } from "./voice-env";

function line(speaker: ScriptLine["speaker"], text: string): ScriptLine {
  return { speaker, line: text };
}

/** Records each synthesize call (and anything else pushed to `log`); each clip is "[speaker:text]". */
function stubProvider() {
  const log: string[] = [];
  const contexts: (SynthesizeContext | undefined)[] = [];
  const provider: VoiceProvider = {
    id: "grok",
    async synthesize(text, speaker, context) {
      log.push(`${speaker}:${text}`);
      contexts.push(context);
      return Buffer.from(`[${speaker}:${text}]`);
    },
    async transcribe() {
      throw new Error("not used");
    },
  };
  return { provider, log, contexts };
}

describe("renderPodcast", () => {
  const script = [line("A", "one"), line("B", "two"), line("A", "three")];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("voices each line with its speaker and concatenates the clips in order", async () => {
    const { provider, log } = stubProvider();
    const out = await renderPodcast(script, undefined, {}, provider);
    expect(out.toString()).toBe("[A:one][B:two][A:three]");
    expect(log).toEqual(["A:one", "B:two", "A:three"]);
  });

  it("passes neighboring lines as context, using the chunk-edge lines at the boundaries", async () => {
    const { provider, contexts } = stubProvider();
    await renderPodcast(script, undefined, { previousLine: "zero", nextLine: "four" }, provider);
    expect(contexts).toEqual([
      { previousText: "zero", nextText: "two" },
      { previousText: "one", nextText: "three" },
      { previousText: "two", nextText: "four" },
    ]);
  });

  it("leaves the outer neighbors undefined when the chunk is the whole script", async () => {
    const { provider, contexts } = stubProvider();
    await renderPodcast(script, undefined, undefined, provider);
    expect(contexts[0]).toStrictEqual({ previousText: undefined, nextText: "two" });
    expect(contexts[2]).toStrictEqual({ previousText: "two", nextText: undefined });
  });

  it("reports progress (done, total) after each line", async () => {
    const { provider, log } = stubProvider();
    await renderPodcast(script, (done, total) => log.push(`${done}/${total}`), {}, provider);
    expect(log).toEqual(["A:one", "1/3", "B:two", "2/3", "A:three", "3/3"]);
  });

  it("defaults to the configured provider", async () => {
    clearVoiceEnv({ VOICE_PROVIDER: "grok", XAI_API_KEY: "xai-key" });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(audioFrame(1))));
    vi.stubGlobal("fetch", fetchMock);
    expect((await renderPodcast([line("A", "hello")])).equals(audioFrame(1))).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.x.ai/v1/tts");
  });

  it("rejects when no voice provider is configured", async () => {
    clearVoiceEnv();
    await expect(renderPodcast([line("A", "hello")])).rejects.toThrow("No voice provider configured");
  });
});

describe("estimateDurationSeconds", () => {
  it("returns 0 for no lines", () => {
    expect(estimateDurationSeconds([])).toBe(0);
  });

  it("estimates at a rate of 150 words per minute", () => {
    const words = Array(150).fill("word").join(" ");
    expect(estimateDurationSeconds([line("A", words)])).toBe(60);
  });

  it("sums word counts across multiple lines/speakers", () => {
    const lines = [line("A", Array(75).fill("word").join(" ")), line("B", Array(75).fill("word").join(" "))];
    expect(estimateDurationSeconds(lines)).toBe(60);
  });

  it("rounds to the nearest second", () => {
    // 77 words -> 77/150*60 = 30.8s -> rounds to 31
    const words = Array(77).fill("word").join(" ");
    expect(estimateDurationSeconds([line("A", words)])).toBe(31);
  });

  it("ignores leading/trailing whitespace when counting words", () => {
    // Regression test: `split(/\s+/)` yields a leading "" element for strings
    // starting with whitespace; the estimator must filter those out.
    const withLeadingSpace = estimateDurationSeconds([line("A", " hello")]);
    const withoutLeadingSpace = estimateDurationSeconds([line("A", "hello")]);
    expect(withLeadingSpace).toBe(withoutLeadingSpace);
  });

  it("counts empty lines as zero words", () => {
    const tenEmptyLines: ScriptLine[] = Array.from({ length: 10 }, () => line("A", ""));
    expect(estimateDurationSeconds(tenEmptyLines)).toBe(0);
    expect(estimateDurationSeconds([])).toBe(0);
  });
});
