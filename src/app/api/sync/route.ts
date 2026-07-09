import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { syncUser } from "@/lib/sync";
import { apiError } from "@/lib/errors";
import { checkUsage } from "@/lib/limits";

export const maxDuration = 300;

export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) return apiError("POST /api/sync", "no session", "Not logged in", 401);

  try {
    // Cap before touching the X API — checkUsage throws UsageLimitError (-> 429) once
    // today's per-user sync budget is spent.
    await checkUsage(userId, "sync");
    return NextResponse.json(await syncUser(userId));
  } catch (err) {
    return apiError("POST /api/sync", err, "Sync failed");
  }
}
