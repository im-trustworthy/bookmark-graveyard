import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";

// Hides a bookmark from the list and all future briefs. We can't un-bookmark on X
// (read-only scopes), and a delete would just come back on the next sync.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { tweet_id } = (await req.json()) as { tweet_id?: string };
  if (!tweet_id) return NextResponse.json({ error: "tweet_id required" }, { status: 400 });

  const { error } = await db()
    .from("bookmarks")
    .update({ hidden: true })
    .eq("user_id", userId)
    .eq("tweet_id", tweet_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
