import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { enrichNewBookmarks } from "@/lib/brain";
import { ingestPending } from "@/lib/ingest";
import { apiError } from "@/lib/errors";
import { checkUsage } from "@/lib/limits";

export const maxDuration = 300;

// One processing chunk: ingest sources (articles/media) for up to 15 bookmarks,
// then analyze up to 60 ingested-but-unanalyzed ones. Client loops on `remaining`.
export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) return apiError("POST /api/enrich", "no session", "Not logged in", 401);

  try {
    // Cap before touching Grok/Scribe/article fetches — checkUsage throws
    // UsageLimitError (-> 429) once today's per-user enrich budget is spent. The
    // dashboard's sync loop calls this route once per chunk, so this also bounds
    // how many chunks a single sync can burn through per day.
    await checkUsage(userId, "enrich");
    const ingest = await ingestPending(userId, 15);
    const enrich = await enrichNewBookmarks(userId, 60);
    return NextResponse.json({
      ingested: ingest.ingested,
      enriched: enrich.enriched,
      remaining: Math.max(ingest.remaining, enrich.remaining),
    });
  } catch (err) {
    return apiError("POST /api/enrich", err, "Analysis failed");
  }
}
