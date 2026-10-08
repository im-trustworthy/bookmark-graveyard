export type VoiceProviderId = "elevenlabs" | "grok";

/** Script speaker: A is "Alex" (the curious host), B is "Blake" (the analyst). */
export type HostSpeaker = "A" | "B";

export interface VoiceConfig {
  provider: VoiceProviderId;
  apiKey: string;
  voiceA: string; // Host A ("Alex", curious host); "" when unset (ElevenLabs, transcription-only)
  voiceB: string; // Host B ("Blake", analyst); "" when unset
  model?: string; // provider-specific TTS model, if any
}

/** Neighboring script lines, for providers that use them to smooth prosody across stitched clips. */
export interface SynthesizeContext {
  previousText?: string;
  nextText?: string;
}

/** One entry in a vendor's voice catalog, as the Voices panel lists it. */
export interface VoiceOption {
  id: string;
  name: string;
  gender: "female" | "male" | null;
  kind: "builtin" | "custom"; // custom = the account's own cloned/designed voices
}

export interface VoiceProvider {
  readonly id: VoiceProviderId;
  /** One dialogue line → bare CBR MP3 audio frames (44.1 kHz, 128 kbps), ID3/Xing headers already stripped. */
  synthesize(text: string, speaker: HostSpeaker, context?: SynthesizeContext): Promise<Buffer>;
  /** Audio/video bytes → plain transcript text (trimmed). Throws on empty transcript. */
  transcribe(media: Buffer | ArrayBuffer, mimeType: string, filename?: string): Promise<string>;
}
