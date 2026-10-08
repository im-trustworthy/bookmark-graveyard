import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import { apiError } from "@/lib/errors";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TOPICS = 50;
const MAX_TOPIC_LEN = 80;

// Supabase returns the joined analysis as an object or a one-element array
// depending on the relationship shape; normalize to a single row or null.
function analysisOf<T>(b: { bookmark_analysis: T | T[] | null }): T | null {
  return Array.isArray(b.bookmark_analysis) ? (b.bookmark_analysis[0] ?? null) : b.bookmark_analysis;
}

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return apiError("GET /api/bookmarks", "no session", "Not logged in", 401);

  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  if (from !== null && !DATE_RE.test(from)) {
    return apiError("GET /api/bookmarks", `invalid from=${from}`, "'from' must be YYYY-MM-DD", 400);
  }
  if (to !== null && !DATE_RE.test(to)) {
    return apiError("GET /api/bookmarks", `invalid to=${to}`, "'to' must be YYYY-MM-DD", 400);
  }
  // Malformed topics shouldn't 400 the whole page — just drop the offenders and cap
  // the list so a pathological query string can't bloat the downstream filter/DB work.
  const topics = (req.nextUrl.searchParams.get("topics")?.split(",").filter(Boolean) ?? [])
    .filter((t) => t.length <= MAX_TOPIC_LEN)
    .slice(0, MAX_TOPICS);

  const { data, error } = await db()
    .from("bookmarks")
    .select(
      "tweet_id, author_handle, author_name, text, tweet_created_at, first_seen_at, public_metrics, bookmark_analysis(topics, summary, content_type, credibility)"
    )
    .eq("user_id", userId)
    .eq("hidden", false)
    .order("tweet_created_at", { ascending: false, nullsFirst: false })
    .limit(1000);
  if (error) return apiError("GET /api/bookmarks", new Error(error.message), "Failed to load bookmarks", 500);

  // Date range first: dates use the post's date (what the UI displays), keeping
  // posts with no date.
  const toBound = to ? `${to}T23:59:59Z` : null;
  const inRange = (data ?? []).filter((b) => {
    if (!b.tweet_created_at) return true;
    if (from && b.tweet_created_at < from) return false;
    if (toBound && b.tweet_created_at > toBound) return false;
    return true;
  });

  // Topic chips are counted over the date-filtered set *before* the topic
  // selection is applied, so they describe exactly the posts loaded for this
  // range and stay stable while the user toggles them.
  const counts = new Map<string, number>();
  for (const b of inRange) {
    for (const t of analysisOf(b)?.topics ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const topicCounts = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const rows =
    topics.length === 0
      ? inRange
      : inRange.filter((b) => analysisOf(b)?.topics?.some((t: string) => topics.includes(t)));

  // Unfiltered library size — lets the UI distinguish "empty filters" from "never synced"
  const { count: total } = await db()
    .from("bookmarks")
    .select("tweet_id", { count: "exact", head: true })
    .eq("user_id", userId);

  return NextResponse.json({
    bookmarks: rows,
    topics: topicCounts,
    // Non-hidden posts the user could reach by widening the filters ("Showing X of Y")
    library: (data ?? []).length,
    total: total ?? 0,
  });
}
