// Synthetic MP3 building blocks shared by the mp3 and voice-provider tests.

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono, no padding → 417-byte frames
const HEADER = Buffer.from([0xff, 0xfb, 0x90, 0xc0]);
export const FRAME_LEN = 417;
export const audioFrame = (fill: number) => Buffer.concat([HEADER, Buffer.alloc(FRAME_LEN - 4, fill)]);
export function infoFrame(): Buffer {
  const body = Buffer.alloc(FRAME_LEN - 4, 0);
  body.write("Info", 17, "latin1"); // right after the 17-byte mono side info, where encoders put it
  return Buffer.concat([HEADER, body]);
}
export function id3v2(payloadLen: number): Buffer {
  const head = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, payloadLen]); // "ID3", v2.3, syncsafe size
  return Buffer.concat([head, Buffer.alloc(payloadLen, 0x41)]);
}
/** What one ElevenLabs clip looks like: tag, Info frame, then n audio frames. */
export const clip = (n: number, fill: number) =>
  Buffer.concat([id3v2(35), infoFrame(), ...Array.from({ length: n }, () => audioFrame(fill))]);
/** A valid frame in the wrong format: MPEG-2 Layer III, 128 kbps, 24 kHz (384 bytes). */
export const mpeg2Frame24k = () => Buffer.concat([Buffer.from([0xff, 0xf3, 0xc4, 0xc0]), Buffer.alloc(380, 7)]);
/** MPEG-1 Layer III at the right bitrate but 48 kHz (384 bytes). */
export const mpeg1Frame48k = () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x94, 0xc0]), Buffer.alloc(380, 7)]);
/** MPEG-1 Layer III at 44.1 kHz but 64 kbps (208 bytes). */
export const mpeg1Frame64kbps = () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x50, 0xc0]), Buffer.alloc(204, 7)]);
