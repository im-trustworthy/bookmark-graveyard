import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { DigestStageError, scriptBrief } from "@/lib/digest";
import { apiError } from "@/lib/errors";
import { stageErrorResponse } from "../shared";

export const maxDuration = 300;

const CONTEXT = "Digest script error";

// Stage 2 (audio): turn the prepared markdown into the two-host script.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { episodeId, targetMinutes } = (await req.json()) as {
    episodeId?: string;
    targetMinutes?: number;
  };
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  try {
    return NextResponse.json(await scriptBrief(userId, episodeId, targetMinutes));
  } catch (err) {
    if (err instanceof DigestStageError) return stageErrorResponse(CONTEXT, err);
    return apiError(CONTEXT, err, "Script generation failed");
  }
}
