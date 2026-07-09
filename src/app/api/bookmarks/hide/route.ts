import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import { apiError } from "@/lib/errors";

// X snowflake IDs are numeric strings; 30 digits is generous headroom while still
// bounding the value we interpolate into a query.
const TWEET_ID_RE = /^\d{1,30}$/;

// Hides a bookmark from the list and all future briefs. We can't un-bookmark on X
// (read-only scopes), and a delete would just come back on the next sync.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return apiError("POST /api/bookmarks/hide", "no session", "Not logged in", 401);

  let tweet_id: string | undefined;
  try {
    // Catches both unparsable JSON and a parsed-but-wrong-shape body (e.g. `null`),
    // which would otherwise throw on the destructure below.
    ({ tweet_id } = (await req.json()) as { tweet_id?: string });
  } catch (err) {
    return apiError("POST /api/bookmarks/hide", err, "Invalid request body", 400);
  }
  if (!tweet_id || !TWEET_ID_RE.test(tweet_id)) {
    return apiError(
      "POST /api/bookmarks/hide",
      `invalid tweet_id=${JSON.stringify(tweet_id)}`,
      "tweet_id must be a 1-30 digit numeric string",
      400
    );
  }

  const { error } = await db()
    .from("bookmarks")
    .update({ hidden: true })
    .eq("user_id", userId)
    .eq("tweet_id", tweet_id);
  if (error) return apiError("POST /api/bookmarks/hide", new Error(error.message), "Failed to hide bookmark", 500);

  return NextResponse.json({ ok: true });
}
