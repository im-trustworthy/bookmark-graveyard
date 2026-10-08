import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/errors";
import { checkUsage } from "@/lib/limits";
import { getSessionUserId } from "@/lib/session";
import { listVoices } from "@/lib/voice";
import { resolveRequestApiKey } from "@/lib/voice/user";
import {
  apiKeySchema,
  badRequest,
  noKeyAvailable,
  providerSchema,
  readBody,
  visibleVoices,
  voiceFailure,
} from "../shared";

export const maxDuration = 60;

const ListBody = z.object({ provider: providerSchema, apiKey: apiKeySchema });

// The vendor's voice catalog for the panel's pickers: built-ins plus the
// account's own custom voices (none when listing with the instance's key).
export async function POST(req: NextRequest) {
  const context = "POST /api/voice/voices";
  const userId = await getSessionUserId();
  if (!userId) return apiError(context, "no session", "Not logged in", 401);
  const body = await readBody(req, ListBody);
  if ("error" in body) return badRequest(context, body.error);
  const { provider, apiKey } = body.data;

  try {
    const resolved = await resolveRequestApiKey(userId, provider, apiKey);
    if (!resolved) return noKeyAvailable(context, provider);
    await checkUsage(userId, "voice_list");
    try {
      return NextResponse.json({ voices: visibleVoices(await listVoices(provider, resolved.key), resolved) });
    } catch (err) {
      return voiceFailure(context, err, "Couldn't list voices from the voice provider", 502);
    }
  } catch (err) {
    return voiceFailure(context, err, "Couldn't list voices");
  }
}
