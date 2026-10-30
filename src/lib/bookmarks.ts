import "server-only";
import { db } from "./supabase";

// How a user's bookmarks are loaded and narrowed, shared by GET /api/bookmarks and anything else that
// browses the library. The helpers compose: load once, narrow by date, count the topic chips over that
// set, then apply the topic selection, which is the order the dashboard relies on.

/** The stored analysis of one bookmark (the `bookmark_analysis` join). */
export interface BookmarkAnalysis {
  topics: string[];
  summary: string | null;
  content_type: string;
  credibility: string;
}

/** One row of the browse query: the post plus its analysis, which is missing until the post is enriched. */
export interface BookmarkRow {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
  text: string;
  tweet_created_at: string | null;
  first_seen_at: string;
  public_metrics: Record<string, unknown> | null;
  // Supabase returns the joined analysis as an object or a one-element array depending on the
  // relationship shape, and null when there is none.
  bookmark_analysis: BookmarkAnalysis | BookmarkAnalysis[] | null;
}

/** The browse query failed; carries the database's message. */
export class BookmarkQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookmarkQueryError";
  }
}

const MAX_ROWS = 1000;

/** The user's non-hidden bookmarks with their analysis, newest post first (undated last), at most 1000. */
export async function loadBookmarkRows(userId: string): Promise<BookmarkRow[]> {
  const { data, error } = await db()
    .from("bookmarks")
    .select(
      "tweet_id, author_handle, author_name, text, tweet_created_at, first_seen_at, public_metrics, bookmark_analysis(topics, summary, content_type, credibility)"
    )
    .eq("user_id", userId)
    .eq("hidden", false)
    .order("tweet_created_at", { ascending: false, nullsFirst: false })
    .limit(MAX_ROWS);
  if (error) throw new BookmarkQueryError(error.message);
  return (data ?? []) as BookmarkRow[];
}

/** Normalizes the joined analysis to a single row, or null when the post hasn't been analyzed. */
export function analysisOf(row: Pick<BookmarkRow, "bookmark_analysis">): BookmarkAnalysis | null {
  const a = row.bookmark_analysis;
  return Array.isArray(a) ? (a[0] ?? null) : a;
}

/**
 * Keeps the posts dated within `from`..`to` (YYYY-MM-DD, both inclusive; `to` runs to the end of that
 * day). Dates are the post's own date, what the UI displays, and posts with no date are always kept.
 */
export function filterByDateRange(
  rows: BookmarkRow[],
  from?: string | null,
  to?: string | null
): BookmarkRow[] {
  const toBound = to ? `${to}T23:59:59Z` : null;
  return rows.filter((b) => {
    if (!b.tweet_created_at) return true;
    if (from && b.tweet_created_at < from) return false;
    if (toBound && b.tweet_created_at > toBound) return false;
    return true;
  });
}

/**
 * Topic chips for these rows: each topic with how many posts carry it, most posts first and then by
 * name. Count over the date-filtered set *before* the topic selection is applied, so the chips describe
 * exactly the posts loaded for the range and stay stable while topics are toggled.
 */
export function topicCounts(rows: BookmarkRow[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of rows) {
    for (const t of analysisOf(b)?.topics ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Keeps the posts that carry at least one of `topics`; no topics selected keeps everything. */
export function filterByTopics(rows: BookmarkRow[], topics: string[]): BookmarkRow[] {
  if (topics.length === 0) return rows;
  return rows.filter((b) => analysisOf(b)?.topics?.some((t) => topics.includes(t)));
}

/**
 * Free-text match: the query is split on whitespace and every term must appear, case-insensitively, in
 * the post text, the analysis summary, the author handle or the author name (a term may match a
 * different field than its neighbors). An empty query matches everything.
 */
export function matchesQuery(row: BookmarkRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  // A newline joins the fields; a term holds no whitespace, so it can't match across two of them.
  const haystack = [row.text, analysisOf(row)?.summary, row.author_handle, row.author_name]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Every bookmark the user has, hidden or not: the size of the library before any filter. */
export async function countLibrary(userId: string): Promise<number> {
  const { count } = await db()
    .from("bookmarks")
    .select("tweet_id", { count: "exact", head: true })
    .eq("user_id", userId);
  return count ?? 0;
}
