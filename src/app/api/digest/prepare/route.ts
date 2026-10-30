import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { DigestStageError, prepareBrief, validatePrepareInput } from "@/lib/digest";
import { apiError } from "@/lib/errors";
import { VoiceConfigError } from "@/lib/voice";
import { stageErrorResponse } from "../shared";

export const maxDuration = 300;

const CONTEXT = "Digest prepare error";

// Stage 1: select -> freshness -> outline -> compose markdown. For markdown-only
// briefs this completes the episode; for audio the client continues to /script.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const rawBody = await req.json().catch(() => null);
  const validated = validatePrepareInput(rawBody);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  try {
    return NextResponse.json(await prepareBrief(userId, validated.value));
  } catch (err) {
    if (err instanceof DigestStageError) return stageErrorResponse(CONTEXT, err);
    // A broken voice setup names the setting to fix (never a secret): the same 400 as "none".
    if (err instanceof VoiceConfigError) return apiError(CONTEXT, err, err.message, 400);
    return apiError(CONTEXT, err, "Digest generation failed");
  }
}
