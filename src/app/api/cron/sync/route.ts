import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { syncUser } from "@/lib/sync";
import { enrichNewBookmarks } from "@/lib/brain";
import { ingestPending } from "@/lib/ingest";
import { apiError } from "@/lib/errors";

export const maxDuration = 300;

// Weekly sync for all allowed users (Vercel cron, see vercel.json).
//
// Deliberately no checkUsage() here: the per-user "sync"/"enrich" caps in
// src/lib/limits.ts exist to stop an interactive user (or a leaked session) from
// hammering the paid X/Grok APIs on demand. This route already has its own gate —
// it's Bearer-secret-protected, runs unattended on a fixed weekly schedule, and
// processes every allowed user exactly once per invocation — so the per-user daily
// caps would either be a no-op or could wrongly block a legitimate scheduled run
// that lands the same day as a user's own manual syncs.
export async function GET(req: NextRequest) {
  // Fail closed: without a configured CRON_SECRET this endpoint stays disabled,
  // so a deployed instance can't be made to burn X/Grok credits by anyone who finds the URL.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return apiError("GET /api/cron/sync", "CRON_SECRET not configured", "CRON_SECRET not configured", 503);
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return apiError("GET /api/cron/sync", "bad bearer token", "Unauthorized", 401);
  }

  const { data: users } = await db().from("users").select("id, handle").eq("is_allowed", true);
  const results: Record<string, unknown> = {};
  for (const user of users ?? []) {
    try {
      const sync = await syncUser(user.id);
      const ingest = await ingestPending(user.id);
      const enrich = await enrichNewBookmarks(user.id);
      results[user.handle] = { ...sync, ...ingest, ...enrich };
    } catch (err) {
      // Per-user failures are aggregated into `results` (so one broken user doesn't
      // fail the whole batch) rather than turned into a route-level apiError response
      // — but still logged server-side for the same "detail always in the log" reason.
      console.error(`Cron sync failed for ${user.handle}:`, err);
      results[user.handle] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return NextResponse.json({ results });
}
