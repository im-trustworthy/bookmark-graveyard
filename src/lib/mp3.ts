/**
 * Minimal MPEG-1/2 Layer III frame walker — just enough to clean up TTS output.
 *
 * ElevenLabs returns each clip as a complete MP3 file: an ID3v2 tag, a Xing/Info
 * header frame describing *that clip*, then fixed-format CBR audio frames.
 * Byte-concatenating clips leaves dozens of those headers mid-stream. Players
 * that trust the first Info header (Safari, every iOS browser) then read the
 * whole episode as one clip long, so the scrubber maps to the wrong place;
 * decoders also hit "header missing" garbage at every boundary. Stripping the
 * tags and header frames leaves pure CBR audio frames, which every player
 * measures and seeks by byte offset.
 */

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

type Frame = { offset: number; length: number; samples: number; sampleRate: number; isInfo: boolean };

/** Byte length of an ID3v2 tag starting at `i`, or 0 if there isn't one. */
function id3v2Length(buf: Buffer, i: number): number {
  if (i + 10 > buf.length || buf[i] !== 0x49 || buf[i + 1] !== 0x44 || buf[i + 2] !== 0x33) return 0; // "ID3"
  const major = buf[i + 3];
  if (major < 2 || major > 4) return 0;
  const footer = buf[i + 5] & 0x10 ? 10 : 0;
  const size =
    ((buf[i + 6] & 0x7f) << 21) | ((buf[i + 7] & 0x7f) << 14) | ((buf[i + 8] & 0x7f) << 7) | (buf[i + 9] & 0x7f);
  return 10 + size + footer;
}

function parseFrame(buf: Buffer, i: number): Frame | null {
  if (i + 4 > buf.length) return null;
  const h = buf.readUInt32BE(i);
  if (h >>> 21 !== 0x7ff) return null; // 11-bit frame sync
  const version = (h >>> 19) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = reserved
  const layer = (h >>> 17) & 3; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = (h >>> 12) & 0xf;
  const sampleRateIndex = (h >>> 10) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 0xf || sampleRateIndex === 3) return null;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate) / sampleRate) + ((h >>> 9) & 1);
  if (i + length > buf.length) return null; // truncated tail: treat as garbage
  // The Xing/Info tag follows the side info (9–32 bytes); scanning the first 40 covers every layout.
  const head = buf.subarray(i + 4, i + Math.min(length, 44));
  const isInfo = head.includes("Xing") || head.includes("Info");
  return { offset: i, length, samples, sampleRate, isInfo };
}

function* frames(buf: Buffer): Generator<Frame> {
  const hasId3v1 = buf.length >= 128 && buf.subarray(buf.length - 128, buf.length - 125).toString("latin1") === "TAG";
  const end = hasId3v1 ? buf.length - 128 : buf.length;
  let i = 0;
  while (i < end) {
    const tag = id3v2Length(buf, i);
    if (tag) {
      i += tag;
      continue;
    }
    const frame = parseFrame(buf, i);
    if (!frame) {
      i++; // resync byte by byte through anything that isn't a frame
      continue;
    }
    yield frame;
    i += frame.length;
  }
}

/**
 * Returns only the audio frames of `buf`: ID3v1/v2 tags and Xing/Info header
 * frames are dropped. Idempotent; returns the same Buffer when nothing changes.
 */
export function stripMp3Headers(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let total = 0;
  for (const f of frames(buf)) {
    if (f.isInfo) continue;
    parts.push(buf.subarray(f.offset, f.offset + f.length));
    total += f.length;
  }
  return total === buf.length ? buf : Buffer.concat(parts, total);
}

/** Playback length from the audio frames actually present (tags and Info frames excluded). */
export function mp3DurationSeconds(buf: Buffer): number {
  let seconds = 0;
  for (const f of frames(buf)) if (!f.isInfo) seconds += f.samples / f.sampleRate;
  return seconds;
}
