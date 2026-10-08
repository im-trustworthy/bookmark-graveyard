import "server-only";
import { assertStitchableMp3, stripMp3Headers } from "../mp3";
import { VoiceConfigError } from "./errors";
import type { VoiceConfig, VoiceOption, VoiceProvider } from "./types";
import { vendorError, voiceGender } from "./vendor";

const API = "https://api.elevenlabs.io/v1";

// Turbo = 0.5 credits/char, roughly doubles what a Creator subscription can render per month.
export const ELEVENLABS_DEFAULT_MODEL = "eleven_turbo_v2_5";

/**
 * ElevenLabs multi-voice TTS and Scribe STT. Each TTS clip comes back as a
 * complete MP3 file (ID3 tag + Xing/Info header frame + CBR audio frames);
 * only the audio frames are returned, so clips concatenate into one clean
 * stream — see src/lib/mp3.ts.
 */
export function createElevenLabsProvider(config: VoiceConfig): VoiceProvider {
  return {
    id: "elevenlabs",

    async synthesize(text, speaker, context = {}) {
      // Voices are optional at config time so the key alone can drive video transcription.
      const voice = speaker === "A" ? config.voiceA : config.voiceB;
      if (!voice) {
        throw new VoiceConfigError(
          `ElevenLabs voice for host ${speaker} is not set — set ELEVENLABS_VOICE_HOST_${speaker} or choose voices in the app`
        );
      }
      const url = `${API}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: config.model || ELEVENLABS_DEFAULT_MODEL,
          // Continuity hints improve prosody across stitched segments
          previous_text: context.previousText?.slice(-500),
          next_text: context.nextText?.slice(0, 500),
        }),
        // Bounded like Grok's, so a hung call can't eat the render route's 300 s budget.
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw await vendorError("elevenlabs", "ElevenLabs TTS", res, config.apiKey);
      const audio = stripMp3Headers(Buffer.from(await res.arrayBuffer()));
      assertStitchableMp3(audio, `ElevenLabs TTS (content-type ${res.headers.get("content-type") ?? "none"})`);
      return audio;
    },

    async transcribe(media, mimeType, filename) {
      const form = new FormData();
      form.append("model_id", "scribe_v2");
      // Uint8Array views an ArrayBuffer as-is and copies a Buffer, which Blob's typings reject.
      form.append("file", new Blob([new Uint8Array(media)], { type: mimeType }), filename);
      const res = await fetch(`${API}/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": config.apiKey },
        body: form,
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw await vendorError("elevenlabs", "Scribe", res, config.apiKey);
      const body = (await res.json()) as { text?: string };
      const text = (body.text ?? "").trim();
      if (!text) throw new Error("Empty transcript");
      return text;
    },
  };
}

type RawVoice = { voice_id?: unknown; name?: unknown; category?: unknown; labels?: { gender?: unknown } | null };

/**
 * The account's voices. Only ElevenLabs' premade voices count as "builtin";
 * everything else (cloned, generated, professional, library additions) belongs
 * to whoever owns the key, so it is "custom" and hidden from instance-key users.
 */
export async function listElevenLabsVoices(apiKey: string): Promise<VoiceOption[]> {
  const res = await fetch(`${API}/voices`, {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await vendorError("elevenlabs", "ElevenLabs voices", res, apiKey);
  const body = (await res.json()) as { voices?: unknown } | null;
  if (!Array.isArray(body?.voices)) throw new Error("ElevenLabs voices returned an unexpected response shape");
  return (body.voices as RawVoice[]).flatMap((v) => {
    if (typeof v?.voice_id !== "string" || !v.voice_id) return [];
    const name = typeof v.name === "string" && v.name.trim() ? v.name.trim() : v.voice_id;
    const kind = v.category === "premade" ? "builtin" : "custom";
    return [{ id: v.voice_id, name, gender: voiceGender(v.labels?.gender), kind }];
  });
}
