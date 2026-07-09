import "server-only";
import { db } from "./supabase";

/** Thrown when a rolling-24h per-user cap is hit. apiError maps it to HTTP 429. */
export class UsageLimitError extends Error {}

const DEFAULT_LIMITS: Record<string, number> = {
  sync: 24, // X API reads
  enrich: 400, // Grok batches + article fetches + Scribe
  digest_prepare: 12, // full brief generations (gates the whole pipeline)
};

function limitFor(kind: string): number {
  const fromEnv = Number(process.env[`LIMIT_${kind.toUpperCase()}_PER_DAY`]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : (DEFAULT_LIMITS[kind] ?? 100);
}

/**
 * Enforces a rolling-24h per-user cap on a spend-incurring action and records
 * the event. Call at the top of the route, before any external API is hit.
 */
export async function checkUsage(userId: string, kind: string): Promise<void> {
  const limit = limitFor(kind);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count, error } = await db()
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", kind)
    .gte("created_at", since);
  if (error) throw new Error(`Usage check failed: ${error.message}`);
  if ((count ?? 0) >= limit) {
    throw new UsageLimitError(
      `Daily limit reached for ${kind.replace("_", " ")} (${limit}/24h). This guards your API spend; try again later or raise LIMIT_${kind.toUpperCase()}_PER_DAY.`
    );
  }
  const { error: insertError } = await db()
    .from("usage_events")
    .insert({ user_id: userId, kind });
  if (insertError) throw new Error(`Usage record failed: ${insertError.message}`);
}
