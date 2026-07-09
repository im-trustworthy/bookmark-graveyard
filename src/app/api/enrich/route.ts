import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { enrichNewBookmarks } from "@/lib/brain";

export const maxDuration = 300;

// Analyzes up to 60 pending bookmarks per call; the client loops until remaining = 0.
export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  try {
    return NextResponse.json(await enrichNewBookmarks(userId, 60));
  } catch (err) {
    console.error("Enrich error:", err);
    const message = err instanceof Error ? err.message : "Analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
