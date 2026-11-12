import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { enrichNewBookmarks, resetFailedAnalysis } from "@/lib/brain";
import { ingestPending } from "@/lib/ingest";
import { apiError } from "@/lib/errors";
import { checkUsage } from "@/lib/limits";
import { PIPELINE_CHUNK, pipelineProgress } from "@/lib/state/pipeline";

export const maxDuration = 300;

// One processing chunk: ingest sources (articles/media) for up to PIPELINE_CHUNK.ingest
// bookmarks, then analyze up to PIPELINE_CHUNK.enrich ingested-but-unanalyzed ones.
// Client loops on `remaining`. A JSON body of {"retryFailed": true} first puts the posts the
// analysis gave up on back in the backlog; any other body, or none, leaves them be.
export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return apiError("POST /api/enrich", "no session", "Not logged in", 401);

  try {
    // Cap before touching Grok/video transcription/article fetches — checkUsage throws
    // UsageLimitError (-> 429) once today's per-user enrich budget is spent. The
    // dashboard's sync loop calls this route once per chunk, so this also bounds
    // how many chunks a single sync can burn through per day.
    await checkUsage(userId, "enrich");
    if (await wantsRetryFailed(req)) await resetFailedAnalysis(userId);
    const ingest = await ingestPending(userId, PIPELINE_CHUNK.ingest);
    const enrich = await enrichNewBookmarks(userId, PIPELINE_CHUNK.enrich, PIPELINE_CHUNK.enrichCalls);
    return NextResponse.json({
      ingested: ingest.ingested,
      enriched: enrich.enriched,
      missed: enrich.missed,
      remaining: pipelineProgress({
        ingested: ingest.ingested,
        enriched: enrich.enriched,
        missed: enrich.missed,
        ingestRemaining: ingest.remaining,
        enrichRemaining: enrich.remaining,
      }).remaining,
    });
  } catch (err) {
    return apiError("POST /api/enrich", err, "Analysis failed");
  }
}

/** The optional {"retryFailed": true} body; a missing or malformed body reads as false. */
async function wantsRetryFailed(req: Request): Promise<boolean> {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null && (body as { retryFailed?: unknown }).retryFailed === true;
  } catch {
    return false;
  }
}
