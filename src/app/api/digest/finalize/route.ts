import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { CapacityError } from "@/lib/capacity";
import { DigestStageError, finalizeBrief } from "@/lib/digest";
import { apiError } from "@/lib/errors";
import { stageErrorResponse } from "../shared";

export const maxDuration = 300;

const CONTEXT = "Digest finalize error";

// Stage 4 (audio): stitch rendered chunks into one MP3 and publish the episode.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { episodeId } = (await req.json()) as { episodeId?: string };
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  try {
    return NextResponse.json(await finalizeBrief(userId, episodeId));
  } catch (err) {
    if (err instanceof DigestStageError) return stageErrorResponse(CONTEXT, err);
    if (err instanceof CapacityError) return apiError(CONTEXT, err, err.message, 507);
    return apiError(CONTEXT, err, "Finalize failed");
  }
}
