import { InvalidVoiceKeyError, VoiceVendorError } from "./errors";
import type { VoiceOption, VoiceProviderId } from "./types";

/**
 * Error for a non-OK vendor response. A rejected key (401 that isn't about
 * quota or limits, or xAI's 400 "Incorrect API key provided") becomes
 * InvalidVoiceKeyError, worded "<what> rejected the API key (<status>)" with
 * no body. Anything else, a 403 or a quota 401 included, is a VoiceVendorError
 * "<what> failed (<status>): <body>", with the request's key redacted from the
 * body in case the vendor echoes it.
 */
export async function vendorError(
  provider: VoiceProviderId,
  what: string,
  res: Response,
  apiKey: string
): Promise<VoiceVendorError> {
  const body = await res.text();
  const badKey =
    (res.status === 401 && !/quota|unusual|limit/i.test(body)) || (res.status === 400 && /api key/i.test(body));
  if (badKey) return new InvalidVoiceKeyError(provider, res.status, `${what} rejected the API key (${res.status})`);
  const safeBody = apiKey ? body.split(apiKey).join("[redacted key]") : body;
  return new VoiceVendorError(provider, res.status, `${what} failed (${res.status}): ${safeBody}`);
}

/** Vendors label gender loosely ("Female", "male", "neutral", or not at all); only female/male are kept. */
export function voiceGender(value: unknown): VoiceOption["gender"] {
  const gender = typeof value === "string" ? value.trim().toLowerCase() : "";
  return gender === "female" || gender === "male" ? gender : null;
}
