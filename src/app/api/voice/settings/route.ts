import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/errors";
import { checkUsage } from "@/lib/limits";
import { getSessionUserId } from "@/lib/session";
import { listVoices } from "@/lib/voice";
import type { VoiceOption } from "@/lib/voice";
import {
  deleteUserVoiceSettings,
  describeVoiceSettings,
  resolveRequestApiKey,
  saveUserVoiceSettings,
} from "@/lib/voice/user";
import {
  apiKeySchema,
  badRequest,
  noKeyAvailable,
  providerSchema,
  readBody,
  visibleVoices,
  voiceFailure,
  voiceIdSchema,
} from "../shared";

export const maxDuration = 60;

const SaveBody = z.object({
  provider: providerSchema,
  apiKey: apiKeySchema,
  voiceA: voiceIdSchema,
  voiceB: voiceIdSchema,
});

// The Voices panel's state: the effective provider and voices, where they
// come from, and which vendor keys this instance has.
export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return apiError("GET /api/voice/settings", "no session", "Not logged in", 401);
  try {
    return NextResponse.json(await describeVoiceSettings(userId));
  } catch (err) {
    return voiceFailure("GET /api/voice/settings", err, "Couldn't load voice settings");
  }
}

// Connect a provider and pick the two host voices. The key (pasted, stored or
// the instance's) must list voices, and both picks must be among the ones this
// user may see (with the instance's key, not the operator's custom voices).
export async function PUT(req: NextRequest) {
  const context = "PUT /api/voice/settings";
  const userId = await getSessionUserId();
  if (!userId) return apiError(context, "no session", "Not logged in", 401);
  const body = await readBody(req, SaveBody);
  if ("error" in body) return badRequest(context, body.error);
  const { provider, apiKey, voiceA, voiceB } = body.data;

  try {
    const resolved = await resolveRequestApiKey(userId, provider, apiKey);
    if (!resolved) return noKeyAvailable(context, provider);
    await checkUsage(userId, "voice_list");
    let voices: VoiceOption[];
    try {
      voices = visibleVoices(await listVoices(provider, resolved.key), resolved);
    } catch (err) {
      return voiceFailure(context, err, "Couldn't check the key with the voice provider", 502);
    }
    const known = new Set(voices.map((v) => v.id));
    const unknown = [voiceA, voiceB].find((id) => !known.has(id));
    if (unknown) return badRequest(context, `Unknown voice id: ${unknown}`);

    await saveUserVoiceSettings(userId, { provider, apiKey, voiceA, voiceB });
    return NextResponse.json(await describeVoiceSettings(userId));
  } catch (err) {
    return voiceFailure(context, err, "Couldn't save voice settings");
  }
}

// Disconnect: back to the instance defaults.
export async function DELETE() {
  const context = "DELETE /api/voice/settings";
  const userId = await getSessionUserId();
  if (!userId) return apiError(context, "no session", "Not logged in", 401);
  try {
    await deleteUserVoiceSettings(userId);
    return NextResponse.json(await describeVoiceSettings(userId));
  } catch (err) {
    return voiceFailure(context, err, "Couldn't remove voice settings");
  }
}
