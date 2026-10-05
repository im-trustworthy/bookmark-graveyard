import { env } from "./env";
import type { ScriptLine } from "./brain";
import { stripMp3Headers } from "./mp3";

const API = "https://api.elevenlabs.io/v1";
// Turbo = 0.5 credits/char, roughly doubles what a Creator subscription can render per month.
const MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_turbo_v2_5";

// Script lines rendered per /api/digest/render call (and per uploaded chunk file).
// Shared with the render route and the status route's resume-cursor math — keep
// them importing this instead of redeclaring the number so they can't drift.
export const LINES_PER_CALL = 12;

function voiceFor(speaker: "A" | "B"): string {
  return speaker === "A" ? env("ELEVENLABS_VOICE_HOST_A") : env("ELEVENLABS_VOICE_HOST_B");
}

async function renderLine(
  line: ScriptLine,
  previousText: string | undefined,
  nextText: string | undefined
): Promise<Buffer> {
  const res = await fetch(`${API}/text-to-speech/${voiceFor(line.speaker)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: {
      "xi-api-key": env("ELEVENLABS_API_KEY"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: line.line,
      model_id: MODEL,
      // Continuity hints improve prosody across stitched segments
      previous_text: previousText?.slice(-500),
      next_text: nextText?.slice(0, 500),
    }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Renders dialogue lines with each host's voice and stitches the segments.
 * ElevenLabs returns each clip as a complete MP3 file (ID3 tag + Xing/Info
 * header frame + fixed-format CBR audio frames). Only the audio frames are
 * kept, so the concatenation is one clean stream that every player can
 * measure and seek — see src/lib/mp3.ts for why that matters. `context`
 * carries the neighboring lines when rendering a mid-script chunk, for
 * prosody continuity.
 */
export async function renderPodcast(
  lines: ScriptLine[],
  onProgress?: (done: number, total: number) => void,
  context: { previousLine?: string; nextLine?: string } = {}
): Promise<Buffer> {
  const segments: Buffer[] = [];
  for (let i = 0; i < lines.length; i++) {
    segments.push(
      stripMp3Headers(
        await renderLine(
          lines[i],
          lines[i - 1]?.line ?? context.previousLine,
          lines[i + 1]?.line ?? context.nextLine
        )
      )
    );
    onProgress?.(i + 1, lines.length);
  }
  return Buffer.concat(segments);
}

export function estimateDurationSeconds(lines: ScriptLine[]): number {
  const words = lines.reduce((n, l) => n + l.line.split(/\s+/).filter(Boolean).length, 0);
  return Math.round((words / 150) * 60);
}
