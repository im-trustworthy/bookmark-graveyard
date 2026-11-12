import { db } from "./supabase";
import { fetchAllBookmarks, getAccessToken } from "./x";
import { hasAnalysisAttempts } from "./analysis-attempts";
import { MAX_ANALYSIS_ATTEMPTS } from "./state/pipeline";

export interface SyncResult {
  fetched: number;
  new: number;
  pendingAnalysis: number;
  /** The newly stored bookmarks, so the UI can tell which fall outside its date window. */
  newBookmarks: { tweet_id: string; tweet_created_at: string | null }[];
}

/** Fetches bookmarks from X and stores them. Fast — analysis runs separately. */
export async function syncUser(userId: string): Promise<SyncResult> {
  const { data: user } = await db().from("users").select("x_user_id").eq("id", userId).single();
  if (!user) throw new Error("User not found");

  const accessToken = await getAccessToken(userId);
  const bookmarks = await fetchAllBookmarks(accessToken, user.x_user_id);

  const { data: existing } = await db()
    .from("bookmarks")
    .select("tweet_id")
    .eq("user_id", userId);
  const known = new Set((existing ?? []).map((b) => b.tweet_id));
  const fresh = bookmarks.filter((b) => !known.has(b.tweet_id));

  if (fresh.length > 0) {
    // Upsert-and-ignore rather than insert: the weekly cron and a manual sync can
    // overlap, and the loser of that race must not fail on the primary key.
    const { error } = await db()
      .from("bookmarks")
      .upsert(
        fresh.map((b) => ({ ...b, user_id: userId })),
        { onConflict: "user_id,tweet_id", ignoreDuplicates: true }
      );
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }

  const countRows = async (table: string) =>
    (
      await db().from(table).select("tweet_id", { count: "exact", head: true }).eq("user_id", userId)
    ).count ?? 0;
  // Given-up posts are not pending: the analysis pass no longer takes them, so counting them would leave
  // a backlog that never drains.
  const givenUp = (await hasAnalysisAttempts())
    ? ((
        await db()
          .from("bookmarks")
          .select("tweet_id", { count: "exact", head: true })
          .eq("user_id", userId)
          .gte("analysis_attempts", MAX_ANALYSIS_ATTEMPTS)
      ).count ?? 0)
    : 0;
  const pendingAnalysis = Math.max(
    0,
    (await countRows("bookmarks")) - (await countRows("bookmark_analysis")) - givenUp
  );

  return {
    fetched: bookmarks.length,
    new: fresh.length,
    pendingAnalysis,
    newBookmarks: fresh.map((b) => ({ tweet_id: b.tweet_id, tweet_created_at: b.tweet_created_at })),
  };
}
