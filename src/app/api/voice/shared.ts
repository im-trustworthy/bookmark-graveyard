import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/errors";
import { InvalidVoiceKeyError, VoiceConfigError, VoiceVendorError } from "@/lib/voice";
import type { VoiceOption, VoiceProviderId } from "@/lib/voice";
import type { RequestApiKey } from "@/lib/voice/user";

// Shared by the /api/voice/* routes (settings, voices, preview).

export const PROVIDER_LABEL: Record<VoiceProviderId, string> = { grok: "Grok Voice", elevenlabs: "ElevenLabs" };

export const providerSchema = z.enum(["grok", "elevenlabs"]);

/**
 * A pasted vendor key. Blank counts as omitted and null means "use the
 * instance key" (see resolveRequestApiKey). Keys are never echoed or logged;
 * validation messages name the field, not the value.
 */
export const apiKeySchema = z
  .string()
  .max(512, "apiKey is too long")
  .regex(/^[\x20-\x7e]*$/, "apiKey must be printable ASCII")
  .nullable()
  .optional();

/** Vendor voice ids: short and URL-safe, since they end up in TTS request paths. */
export const voiceIdSchema = z
  .string()
  .max(100, "voice id must be at most 100 characters")
  .regex(/^[\w.-]+$/, "voice id may only contain letters, digits, _ . -")
  .refine((id) => /[^.]/.test(id), "voice id must contain a letter or digit"); // not "." or ".."

/** Parses the JSON body; the error lists fields and rules, never submitted values. */
export async function readBody<T extends z.ZodType>(
  req: NextRequest,
  schema: T
): Promise<{ data: z.output<T> } | { error: string }> {
  const parsed = schema.safeParse(await req.json().catch(() => undefined));
  if (parsed.success) return { data: parsed.data };
  const issues = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
  return { error: issues.join("; ") };
}

/** A 400 whose message is already user-facing. */
export function badRequest(context: string, message: string): NextResponse {
  return apiError(context, message, message, 400);
}

export function noKeyAvailable(context: string, provider: VoiceProviderId): NextResponse {
  return badRequest(context, `This instance has no ${PROVIDER_LABEL[provider]} key — paste your own`);
}

/**
 * The voices a request may see. With the instance's key that's only the
 * vendor's shared voices: the operator's own clones and designs stay private.
 */
export function visibleVoices(voices: VoiceOption[], resolved: RequestApiKey): VoiceOption[] {
  return resolved.source === "instance" ? voices.filter((v) => v.kind !== "custom") : voices;
}

/**
 * Error response for the voice routes. A rejected key and a VoiceConfigError
 * (its message names the setting, never a secret) are the user's to fix: 400.
 * A vendor's 401/403 that isn't about the key (quota, permissions) gets a
 * clearer message on the vendor-failure path. Anything else gets `fallback`
 * with `status` (429 for a spent usage cap).
 */
export function voiceFailure(context: string, err: unknown, fallback: string, status = 500): NextResponse {
  if (err instanceof InvalidVoiceKeyError) {
    return apiError(context, err, `Invalid API key for ${PROVIDER_LABEL[err.provider]}`, 400);
  }
  if (err instanceof VoiceConfigError) return apiError(context, err, err.message, 400);
  if (err instanceof VoiceVendorError && (err.status === 401 || err.status === 403)) {
    return apiError(
      context,
      err,
      "The voice provider refused the request — check that account's credits and permissions",
      status
    );
  }
  return apiError(context, err, fallback, status);
}
