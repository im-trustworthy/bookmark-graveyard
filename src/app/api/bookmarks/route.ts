import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { apiError } from "@/lib/errors";
import {
  BookmarkQueryError,
  countLibrary,
  filterByDateRange,
  filterByTopics,
  loadBookmarkRows,
  topicCounts,
} from "@/lib/bookmarks";
import type { BookmarkRow } from "@/lib/bookmarks";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TOPICS = 50;
const MAX_TOPIC_LEN = 80;

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

  let loaded: BookmarkRow[];
  try {
    loaded = await loadBookmarkRows(userId);
  } catch (err) {
    if (err instanceof BookmarkQueryError) return apiError("GET /api/bookmarks", err, "Failed to load bookmarks", 500);
    throw err;
  }

  // Date range first: dates use the post's date (what the UI displays), keeping
  // posts with no date.
  const inRange = filterByDateRange(loaded, from, to);

  // Topic chips are counted over the date-filtered set *before* the topic
  // selection is applied, so they describe exactly the posts loaded for this
  // range and stay stable while the user toggles them.
  const chips = topicCounts(inRange);
  const rows = filterByTopics(inRange, topics);

  // Unfiltered library size — lets the UI distinguish "empty filters" from "never synced"
  const total = await countLibrary(userId);

  return NextResponse.json({
    bookmarks: rows,
    topics: chips,
    // Non-hidden posts the user could reach by widening the filters ("Showing X of Y")
    library: loaded.length,
    total,
  });
}
