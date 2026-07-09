import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import { signEpisodeUrls } from "@/lib/episodes";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { data, error } = await db()
    .from("episodes")
    .select()
    .eq("user_id", userId)
    .eq("status", "ready") // hide drafts abandoned mid-generation
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ episodes: await Promise.all((data ?? []).map(signEpisodeUrls)) });
}
