import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  const topics = req.nextUrl.searchParams.get("topics")?.split(",").filter(Boolean) ?? [];

  const { data, error } = await db()
    .from("bookmarks")
    .select(
      "tweet_id, author_handle, author_name, text, tweet_created_at, first_seen_at, public_metrics, bookmark_analysis(topics, summary, content_type, credibility)"
    )
    .eq("user_id", userId)
    .eq("hidden", false)
    .order("tweet_created_at", { ascending: false, nullsFirst: false })
    .limit(1000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Date range + topic filters applied here: dates use the post's date (what the
  // UI displays), keeping posts with no date; topics live on the joined analysis row.
  const toBound = to ? `${to}T23:59:59Z` : null;
  const rows = (data ?? []).filter((b) => {
    if (b.tweet_created_at) {
      if (from && b.tweet_created_at < from) return false;
      if (toBound && b.tweet_created_at > toBound) return false;
    }
    if (topics.length === 0) return true;
    const analysis = Array.isArray(b.bookmark_analysis)
      ? b.bookmark_analysis[0]
      : b.bookmark_analysis;
    return analysis?.topics?.some((t: string) => topics.includes(t));
  });

  const { data: topicRows } = await db()
    .from("topics")
    .select("name")
    .eq("user_id", userId)
    .order("name");

  // Unfiltered library size — lets the UI distinguish "empty filters" from "never synced"
  const { count: total } = await db()
    .from("bookmarks")
    .select("tweet_id", { count: "exact", head: true })
    .eq("user_id", userId);

  return NextResponse.json({
    bookmarks: rows,
    allTopics: (topicRows ?? []).map((t) => t.name),
    total: total ?? 0,
  });
}
