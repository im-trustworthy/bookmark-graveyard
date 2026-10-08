import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/errors";
import { checkUsage } from "@/lib/limits";
import { getSessionUserId } from "@/lib/session";
import { getVoiceProvider } from "@/lib/voice";
import { resolveRequestApiKey } from "@/lib/voice/user";
import {
  apiKeySchema,
  badRequest,
  noKeyAvailable,
  providerSchema,
  readBody,
  voiceFailure,
  voiceIdSchema,
} from "../shared";

export const maxDuration = 60;

const PREVIEW_TEXT =
  "Hey, welcome back to your bookmark brief. Three of the posts you saved this week point at the same shift.";

const PreviewBody = z.object({ provider: providerSchema, apiKey: apiKeySchema, voiceId: voiceIdSchema });

// One sentence in one voice, so the panel can audition voices before saving.
export async function POST(req: NextRequest) {
  const context = "POST /api/voice/preview";
  const userId = await getSessionUserId();
  if (!userId) return apiError(context, "no session", "Not logged in", 401);
  const body = await readBody(req, PreviewBody);
  if ("error" in body) return badRequest(context, body.error);
  const { provider, apiKey, voiceId } = body.data;

  try {
    const resolved = await resolveRequestApiKey(userId, provider, apiKey);
    if (!resolved) return noKeyAvailable(context, provider);
    await checkUsage(userId, "voice_preview");
    let mp3: Buffer;
    try {
      const voice = getVoiceProvider({ provider, apiKey: resolved.key, voiceA: voiceId, voiceB: voiceId });
      mp3 = await voice.synthesize(PREVIEW_TEXT, "A");
    } catch (err) {
      return voiceFailure(context, err, "Voice preview failed", 502);
    }
    return new NextResponse(new Uint8Array(mp3), {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return voiceFailure(context, err, "Voice preview failed");
  }
}
