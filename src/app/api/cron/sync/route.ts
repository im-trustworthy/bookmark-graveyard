import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { syncUser } from "@/lib/sync";

export const maxDuration = 300;

// Weekly sync for all allowed users (Vercel cron, see vercel.json).
export async function GET(req: NextRequest) {
  // Fail closed: without a configured CRON_SECRET this endpoint stays disabled,
  // so a deployed instance can't be made to burn X/Grok credits by anyone who finds the URL.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: users } = await db().from("users").select("id, handle").eq("is_allowed", true);
  const results: Record<string, unknown> = {};
  for (const user of users ?? []) {
    try {
      results[user.handle] = await syncUser(user.id);
    } catch (err) {
      results[user.handle] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return NextResponse.json({ results });
}
