import { db } from "./supabase";
import { fetchAllBookmarks, getAccessToken } from "./x";

export interface SyncResult {
  fetched: number;
  new: number;
  pendingAnalysis: number;
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
    const { error } = await db()
      .from("bookmarks")
      .insert(fresh.map((b) => ({ ...b, user_id: userId })));
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }

  const countRows = async (table: string) =>
    (
      await db().from(table).select("tweet_id", { count: "exact", head: true }).eq("user_id", userId)
    ).count ?? 0;
  const pendingAnalysis = (await countRows("bookmarks")) - (await countRows("bookmark_analysis"));

  return { fetched: bookmarks.length, new: fresh.length, pendingAnalysis };
}
