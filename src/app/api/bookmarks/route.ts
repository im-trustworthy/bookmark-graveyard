import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  const topics = req.nextUrl.searchParams.get("topics")?.split(",").filter(Boolean) ?? [];

  let query = db()
    .from("bookmarks")
    .select(
      "tweet_id, author_handle, author_name, text, tweet_created_at, first_seen_at, public_metrics, bookmark_analysis(topics, summary, content_type, credibility)"
    )
    .eq("user_id", userId)
    .order("first_seen_at", { ascending: false })
    .limit(1000);

  if (from) query = query.gte("first_seen_at", from);
  if (to) query = query.lte("first_seen_at", `${to}T23:59:59Z`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Topic filter applies to the joined analysis row (done here: PostgREST can't
  // filter parent rows by child array overlap without an RPC).
  const rows = (data ?? []).filter((b) => {
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
