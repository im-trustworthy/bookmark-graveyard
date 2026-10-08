import "server-only";
import { db } from "./supabase";

/** Thrown when a rolling-24h per-user cap is hit. apiError maps it to HTTP 429. */
export class UsageLimitError extends Error {}

const DEFAULT_LIMITS: Record<string, number> = {
  sync: 24, // X API reads
  enrich: 400, // Grok batches + article fetches + video transcription
  digest_prepare: 12, // full brief generations (gates prepare/markdown)
  digest_script: 40, // SMART Grok script generations (≈ prepares + resumes/retries)
  digest_render: 500, // TTS chunk calls (≈ 12 briefs × ~20 chunks + resumes)
  voice_list: 120, // voice-catalog fetches from the Voices panel (saving settings re-checks the key)
  voice_preview: 60, // one-sentence voice previews
};

function limitFor(kind: string): number {
  const fromEnv = Number(process.env[`LIMIT_${kind.toUpperCase()}_PER_DAY`]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : (DEFAULT_LIMITS[kind] ?? 100);
}

/**
 * Enforces a rolling-24h per-user cap on a spend-incurring action and records
 * the event. Call before any external (paid) API is hit.
 *
 * Atomic: delegates to the `record_usage` Postgres function, which counts and
 * inserts inside one transaction under a per-(user,kind) advisory lock. A plain
 * check-then-insert here would let a parallel burst all read "under limit"
 * before any insert landed and overshoot the cap by the burst size.
 */
export async function checkUsage(userId: string, kind: string): Promise<void> {
  const limit = limitFor(kind);
  const { data: allowed, error } = await db().rpc("record_usage", {
    p_user_id: userId,
    p_kind: kind,
    p_limit: limit,
  });
  if (error) throw new Error(`Usage check failed: ${error.message}`);
  if (allowed === false) {
    throw new UsageLimitError(
      `Daily limit reached for ${kind.replace(/_/g, " ")} (${limit}/24h). This guards your API spend; try again later or raise LIMIT_${kind.toUpperCase()}_PER_DAY.`
    );
  }
}
