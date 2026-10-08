import type { VoiceProviderId } from "./types";

/**
 * Voice setup is missing or wrong: an invalid VOICE_PROVIDER, an unset or
 * corrupt key, an unset voice, an unreadable stored key. The message names the
 * setting to fix and never contains a secret, so routes can show it as-is.
 */
export class VoiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceConfigError";
  }
}

/** A non-OK response from a voice vendor; `status` is the vendor's HTTP status. */
export class VoiceVendorError extends Error {
  readonly provider: VoiceProviderId;
  readonly status: number;

  constructor(provider: VoiceProviderId, status: number, message: string) {
    super(message);
    this.name = "VoiceVendorError";
    this.provider = provider;
    this.status = status;
  }
}

/**
 * The vendor rejected the API key itself. Routes turn this into a 400
 * "Invalid API key" (the user's input is wrong, not the service). The message
 * carries no vendor body: xAI echoes a masked fragment of the key.
 */
export class InvalidVoiceKeyError extends VoiceVendorError {
  constructor(provider: VoiceProviderId, status: number, message: string) {
    super(provider, status, message);
    this.name = "InvalidVoiceKeyError";
  }
}
