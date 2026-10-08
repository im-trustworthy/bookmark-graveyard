import type { ScriptLine } from "./brain";
import { getVoiceProvider } from "./voice";
import type { VoiceProvider } from "./voice";

// Script lines rendered per /api/digest/render call (and per uploaded chunk file).
// Shared with the render route and the status route's resume-cursor math — keep
// them importing this instead of redeclaring the number so they can't drift.
export const LINES_PER_CALL = 12;

/**
 * Renders dialogue lines with each host's voice and stitches the segments.
 * Every provider returns bare CBR MP3 frames in one shared format (44.1 kHz,
 * 128 kbps, no ID3 tag or Xing/Info header frame), so plain concatenation is
 * one clean stream that every player can measure and seek — see
 * src/lib/mp3.ts for why that matters. `context` carries the neighboring
 * lines when rendering a mid-script chunk, for prosody continuity on
 * providers that support it. `provider` defaults to the configured one and
 * is injectable for tests.
 */
export async function renderPodcast(
  lines: ScriptLine[],
  onProgress?: (done: number, total: number) => void,
  context: { previousLine?: string; nextLine?: string } = {},
  provider: VoiceProvider = getVoiceProvider()
): Promise<Buffer> {
  const segments: Buffer[] = [];
  for (let i = 0; i < lines.length; i++) {
    segments.push(
      await provider.synthesize(lines[i].line, lines[i].speaker, {
        previousText: lines[i - 1]?.line ?? context.previousLine,
        nextText: lines[i + 1]?.line ?? context.nextLine,
      })
    );
    onProgress?.(i + 1, lines.length);
  }
  return Buffer.concat(segments);
}

export function estimateDurationSeconds(lines: ScriptLine[]): number {
  const words = lines.reduce((n, l) => n + l.line.split(/\s+/).filter(Boolean).length, 0);
  return Math.round((words / 150) * 60);
}
