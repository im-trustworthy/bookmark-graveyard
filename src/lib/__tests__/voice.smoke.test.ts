import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { mp3DurationSeconds, stripMp3Headers } from "../mp3";
import { renderPodcast } from "../tts";
import { getVoiceProvider } from "../voice";
import type { ScriptLine } from "../brain";

// Real-API round trip: two Grok hosts → one stitched MP3 → transcripts from
// Grok STT and, when an ElevenLabs key is set, Scribe. Skipped unless
// VOICE_SMOKE is set; costs well under a cent. The subshell keeps the secrets
// out of your interactive shell (and out of later `npm test` runs):
//   ( set -a; . ./.env.local; set +a; VOICE_SMOKE=1 [VOICE_SMOKE_OUT=/path/out.mp3] npx vitest run voice.smoke --reporter=verbose )
// (--reporter=verbose prints the transcripts even where vitest auto-picks its quiet agent reporter.)

/** True for a real key in env, not one of setup.ts's "test-…" placeholders. */
const hasRealKey = (name: string) => !!process.env[name] && !process.env[name]?.startsWith("test-");

describe.skipIf(!process.env.VOICE_SMOKE)("voice providers (real API)", () => {
  const lines: ScriptLine[] = [
    { speaker: "A", line: "Hey, welcome back to your bookmark brief." },
    { speaker: "B", line: "Three of the posts you saved this week point at the same shift." },
  ];
  let mp3: Buffer;

  beforeAll(async () => {
    // Pass the provider explicitly: the default would follow env, which may pick ElevenLabs.
    mp3 = await renderPodcast(lines, undefined, {}, getVoiceProvider({ provider: "grok" }));
    if (process.env.VOICE_SMOKE_OUT) writeFileSync(process.env.VOICE_SMOKE_OUT, mp3);
  }, 120_000);

  it("Grok renders both hosts into one header-free MP3", () => {
    // Starts on a frame sync (the same 11-bit check src/lib/mp3.ts uses) ...
    const header = mp3.readUInt32BE(0);
    expect(header >>> 21).toBe(0x7ff);
    // ... in the one format every chunk shares: MPEG-1 Layer III, 128 kbps, 44.1 kHz.
    expect({
      version: (header >>> 19) & 3,
      layer: (header >>> 17) & 3,
      bitrateIndex: (header >>> 12) & 0xf,
      sampleRateIndex: (header >>> 10) & 3,
    }).toEqual({ version: 3, layer: 1, bitrateIndex: 9, sampleRateIndex: 0 });
    // Nothing but audio frames: no ID3 tag, Xing/Info header frame or stray bytes for the parser to drop.
    expect(stripMp3Headers(mp3).equals(mp3)).toBe(true);
    const seconds = mp3DurationSeconds(mp3);
    expect(seconds).toBeGreaterThan(2);
    // Constant bitrate throughout: 128 kbps is 16,000 bytes per second of audio.
    expect(Math.abs(mp3.length / seconds - 16_000)).toBeLessThan(100);
    const out = process.env.VOICE_SMOKE_OUT;
    console.log(
      `grok render: ${mp3.length} bytes, ${seconds.toFixed(2)} s, first header ${mp3.subarray(0, 4).toString("hex")}` +
        (out ? `, written to ${out}` : "")
    );
  });

  it("Grok STT transcribes it back", { timeout: 120_000 }, async () => {
    const transcript = await getVoiceProvider({ provider: "grok" }).transcribe(mp3, "audio/mpeg", "brief.mp3");
    console.log(`grok transcript: ${transcript}`);
    expect(transcript.toLowerCase()).toContain("bookmark");
  });

  it.skipIf(!hasRealKey("ELEVENLABS_API_KEY"))(
    "ElevenLabs Scribe transcribes the same render",
    { timeout: 120_000 },
    async () => {
      const transcript = await getVoiceProvider({ provider: "elevenlabs" }).transcribe(mp3, "audio/mpeg", "brief.mp3");
      console.log(`scribe transcript: ${transcript}`);
      expect(transcript.toLowerCase()).toContain("bookmark");
    }
  );
});
