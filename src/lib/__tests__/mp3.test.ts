import { describe, expect, it } from "vitest";
import { mp3DurationSeconds, stripMp3Headers } from "../mp3";

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono, no padding → 417-byte frames
const HEADER = Buffer.from([0xff, 0xfb, 0x90, 0xc0]);
const FRAME_LEN = 417;
const audioFrame = (fill: number) => Buffer.concat([HEADER, Buffer.alloc(FRAME_LEN - 4, fill)]);
function infoFrame(): Buffer {
  const body = Buffer.alloc(FRAME_LEN - 4, 0);
  body.write("Info", 17, "latin1"); // right after the 17-byte mono side info, where encoders put it
  return Buffer.concat([HEADER, body]);
}
function id3v2(payloadLen: number): Buffer {
  const head = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, payloadLen]); // "ID3", v2.3, syncsafe size
  return Buffer.concat([head, Buffer.alloc(payloadLen, 0x41)]);
}
/** What one ElevenLabs clip looks like: tag, Info frame, then n audio frames. */
const clip = (n: number, fill: number) =>
  Buffer.concat([id3v2(35), infoFrame(), ...Array.from({ length: n }, () => audioFrame(fill))]);

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
