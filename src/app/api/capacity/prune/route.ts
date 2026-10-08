import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCapacity, pruneAudio } from "@/lib/capacity";
import { apiError } from "@/lib/errors";
import { getSessionUserId } from "@/lib/session";

export const maxDuration = 60;

const PruneBody = z.object({ dryRun: z.boolean().optional() });

/**
 * An empty body means a real prune. Anything else must be {dryRun?: boolean}:
 * a garbled preview request must never be read as "go ahead and delete".
 */
async function readDryRun(req: NextRequest): Promise<boolean | null> {
  const text = await req.text();
  if (!text.trim()) return false;
  try {
    const parsed = PruneBody.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data.dryRun ?? false) : null;
  } catch {
    return null;
  }
}

// The capacity panel's "Free up space": removes the caller's own oldest
// podcast audio (never anyone else's, never their newest KEEP_RECENT_AUDIO
// briefs) until the instance is back down to 80% full. A dry run lists what
// would go and touches nothing. Answers with the result and a fresh report.
export async function POST(req: NextRequest) {
  const context = "POST /api/capacity/prune";
  const userId = await getSessionUserId();
  if (!userId) return apiError(context, "no session", "Not logged in", 401);
  const dryRun = await readDryRun(req);
  if (dryRun === null) return apiError(context, "invalid body", 'Expected a JSON body like {"dryRun": true}', 400);
  try {
    const result = await pruneAudio({ userId, dryRun });
    return NextResponse.json({ ...result, capacity: await getCapacity() });
  } catch (err) {
    return apiError(context, err, "Couldn't free up space");
  }
}
