import { db } from "./supabase";
import { fetchAllBookmarks, getAccessToken } from "./x";
import { enrichNewBookmarks } from "./brain";

export interface SyncResult {
  fetched: number;
  new: number;
  enriched: number;
  enrichError: string | null;
}

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

  // Enrichment is best-effort: sync succeeds even if the brain is unavailable.
  let enriched = 0;
  let enrichError: string | null = null;
  try {
    enriched = await enrichNewBookmarks(userId);
  } catch (err) {
    enrichError = err instanceof Error ? err.message : String(err);
    console.error("Enrichment failed:", err);
  }

  return { fetched: bookmarks.length, new: fresh.length, enriched, enrichError };
}
