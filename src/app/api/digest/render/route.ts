import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { DigestStageError, renderChunk } from "@/lib/digest";
import { apiError } from "@/lib/errors";
import { InvalidVoiceKeyError, VoiceConfigError, VoiceVendorError } from "@/lib/voice";
import { stageErrorResponse } from "../shared";

export const maxDuration = 300;

const CONTEXT = "Digest render error";

// Stage 3 (audio): render the next chunk of script lines to an MP3 segment.
// The client loops, advancing `cursor`, so each request stays ~30-60s.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { episodeId, cursor = 0 } = (await req.json()) as { episodeId?: string; cursor?: number };
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  try {
    return NextResponse.json(await renderChunk(userId, episodeId, cursor));
  } catch (err) {
    if (err instanceof DigestStageError) return stageErrorResponse(CONTEXT, err);
    // Voice setup problems are the user's to fix; their messages name the setting, never a secret.
    if (err instanceof VoiceConfigError) return apiError(CONTEXT, err, err.message, 400);
    if (err instanceof InvalidVoiceKeyError) {
      return apiError(CONTEXT, err, "The voice provider rejected the API key — update it under Voices", 400);
    }
    if (err instanceof VoiceVendorError && (err.status === 401 || err.status === 403)) {
      const message = "The voice provider refused the request — check that account's credits and permissions";
      return apiError(CONTEXT, err, message, 502);
    }
    return apiError(CONTEXT, err, "Audio rendering failed");
  }
}
