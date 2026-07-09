import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { enrichNewBookmarks } from "@/lib/brain";
import { ingestPending } from "@/lib/ingest";

export const maxDuration = 300;

// One processing chunk: ingest sources (articles/media) for up to 15 bookmarks,
// then analyze up to 60 ingested-but-unanalyzed ones. Client loops on `remaining`.
export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  try {
    const ingest = await ingestPending(userId, 15);
    const enrich = await enrichNewBookmarks(userId, 60);
    return NextResponse.json({
      ingested: ingest.ingested,
      enriched: enrich.enriched,
      remaining: Math.max(ingest.remaining, enrich.remaining),
    });
  } catch (err) {
    console.error("Enrich error:", err);
    const message = err instanceof Error ? err.message : "Analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
