import { describe, expect, it } from "vitest";
import { assertStitchableMp3, mp3DurationSeconds, stripMp3Headers } from "../mp3";
import { FRAME_LEN, audioFrame, clip, mpeg1Frame48k, mpeg1Frame64kbps, mpeg2Frame24k } from "./mp3-fixtures";

describe("stripMp3Headers", () => {
  it("drops every clip's ID3 tag and Info frame and keeps audio frames in order", () => {
    const out = stripMp3Headers(Buffer.concat([clip(3, 0x11), clip(2, 0x22)]));
    expect(out.length).toBe(5 * FRAME_LEN);
    expect(out.includes("ID3")).toBe(false);
    expect(out.includes("Info")).toBe(false);
    expect(out[4]).toBe(0x11);
    expect(out[3 * FRAME_LEN + 4]).toBe(0x22);
  });

  it("is idempotent and returns clean input as-is", () => {
    const clean = Buffer.concat([audioFrame(1), audioFrame(2)]);
    expect(stripMp3Headers(clean)).toBe(clean);
    const once = stripMp3Headers(clip(2, 3));
    expect(stripMp3Headers(once)).toBe(once);
  });

  it("drops an ID3v1 trailer", () => {
    const trailer = Buffer.concat([Buffer.from("TAG", "latin1"), Buffer.alloc(125, 0)]);
    expect(stripMp3Headers(Buffer.concat([audioFrame(1), trailer])).length).toBe(FRAME_LEN);
  });

  it("skips garbage between frames", () => {
    const out = stripMp3Headers(Buffer.concat([audioFrame(1), Buffer.from("junk"), audioFrame(2)]));
    expect(out.length).toBe(2 * FRAME_LEN);
  });
});

describe("mp3DurationSeconds", () => {
  it("counts only audio frames", () => {
    expect(mp3DurationSeconds(Buffer.concat([clip(3, 1), clip(2, 2)]))).toBeCloseTo((5 * 1152) / 44100, 6);
  });
});

describe("assertStitchableMp3", () => {
  const expected = "expected 128 kbps, 44.1 kHz MPEG-1 Layer III";

  it("passes MPEG-1 Layer III, 128 kbps, 44.1 kHz audio", () => {
    expect(() => assertStitchableMp3(Buffer.concat([audioFrame(1), audioFrame(2)]), "TTS")).not.toThrow();
  });

  it("rejects an empty buffer, naming the source and length", () => {
    expect(() => assertStitchableMp3(Buffer.alloc(0), "Grok TTS (content-type audio/mpeg)")).toThrow(
      `Grok TTS (content-type audio/mpeg): no MP3 audio frames (0 bytes); ${expected}`
    );
  });

  it("rejects a JSON or HTML body", () => {
    expect(() => assertStitchableMp3(Buffer.from('{"error":"busy"}'), "TTS")).toThrow("no MP3 audio frames (16 bytes)");
    expect(() => assertStitchableMp3(Buffer.from("<html>oops</html>"), "TTS")).toThrow("no MP3 audio frames");
  });

  it("rejects a valid frame in another format (24 kHz MPEG-2)", () => {
    expect(() => assertStitchableMp3(mpeg2Frame24k(), "TTS")).toThrow(
      `TTS: first frame is MPEG-2 128 kbps / 24000 Hz (384 bytes); ${expected}`
    );
  });

  it("rejects MPEG-1 at another sample rate or bitrate", () => {
    expect(() => assertStitchableMp3(mpeg1Frame48k(), "TTS")).toThrow("first frame is MPEG-1 128 kbps / 48000 Hz");
    expect(() => assertStitchableMp3(mpeg1Frame64kbps(), "TTS")).toThrow("first frame is MPEG-1 64 kbps / 44100 Hz");
  });
});
