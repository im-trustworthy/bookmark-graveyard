import "server-only";
import { assertStitchableMp3, stripMp3Headers } from "../mp3";
import type { VoiceConfig, VoiceOption, VoiceProvider } from "./types";
import { vendorError, voiceGender } from "./vendor";

const API = "https://api.x.ai/v1";

/**
 * xAI Grok Voice TTS and STT. TTS accepts up to 60,000 chars per request, far
 * above any script line, so each line is a single request with no chunking.
 */
export function createGrokProvider(config: VoiceConfig): VoiceProvider {
  return {
    id: "grok",

    // `context` is accepted and ignored: Grok's TTS has no previous/next-text
    // continuity inputs, so each line is voiced on its own.
    async synthesize(text, speaker) {
      const res = await fetch(`${API}/tts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          voice_id: speaker === "A" ? config.voiceA : config.voiceB,
          language: "en",
          // Same encoding as ElevenLabs' mp3_44100_128, so every chunk shares one CBR format.
          output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 128000 },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw await vendorError("grok", "Grok TTS", res, config.apiKey);
      // Already bare CBR frames today; stripping is an idempotent no-op that
      // keeps the header-free guarantee if xAI ever starts adding ID3/Xing.
      const audio = stripMp3Headers(Buffer.from(await res.arrayBuffer()));
      assertStitchableMp3(audio, `Grok TTS (content-type ${res.headers.get("content-type") ?? "none"})`);
      return audio;
    },

    async transcribe(media, mimeType, filename) {
      const form = new FormData();
      // No `language` field, so STT auto-detects: bookmarked videos aren't all English.
      // Uint8Array views an ArrayBuffer as-is and copies a Buffer, which Blob's typings reject.
      form.append("file", new Blob([new Uint8Array(media)], { type: mimeType }), filename);
      const res = await fetch(`${API}/stt`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw await vendorError("grok", "Grok STT", res, config.apiKey);
      // The response also carries language, duration and word timings; only the text is used.
      const body = (await res.json()) as { text?: string };
      const text = (body.text ?? "").trim();
      if (!text) throw new Error("Empty transcript");
      return text;
    },
  };
}

type RawVoice = { voice_id?: unknown; id?: unknown; name?: unknown; gender?: unknown };

/** A bare array or `{ voices: [...] }`; null for any other shape. */
function rawVoices(body: unknown): RawVoice[] | null {
  const list = Array.isArray(body) ? body : (body as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(list)) return null;
  return list.filter((v): v is RawVoice => typeof v === "object" && v !== null);
}

function toOptions(raw: RawVoice[], kind: VoiceOption["kind"]): VoiceOption[] {
  return raw.flatMap((v) => {
    const id = typeof v.voice_id === "string" ? v.voice_id : typeof v.id === "string" ? v.id : "";
    if (!id) return [];
    const name = typeof v.name === "string" && v.name.trim() ? v.name.trim() : id;
    return [{ id, name, gender: voiceGender(v.gender), kind }];
  });
}

/**
 * The built-in voices, then the team's custom (cloned) ones. Custom voices are
 * US-only, so any failure listing them just means there are none.
 */
export async function listGrokVoices(apiKey: string): Promise<VoiceOption[]> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const res = await fetch(`${API}/tts/voices`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw await vendorError("grok", "Grok voices", res, apiKey);
  const builtin = rawVoices(await res.json());
  if (!builtin) throw new Error("Grok voices returned an unexpected response shape");

  const custom = await fetch(`${API}/custom-voices`, { headers, signal: AbortSignal.timeout(15_000) })
    .then(async (r) => (r.ok ? rawVoices(await r.json()) : null))
    .catch(() => null);
  return [...toOptions(builtin, "builtin"), ...toOptions(custom ?? [], "custom")];
}
