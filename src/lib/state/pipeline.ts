// The bookmark processing pipeline as one explicit state machine. A bookmark is
// synced when it is stored, ingested once its sources are fetched
// (bookmarks.ingested_at is set), and analysed once its bookmark_analysis row
// exists. A post whose analysis failed on its own content MAX_ANALYSIS_ATTEMPTS
// times (bookmarks.analysis_attempts) is analysis_failed: the pass gives up on
// it until the user asks for a retry, which puts it back to ingested. Pure: no
// I/O, so server code, client components and tests can share it.

export const BOOKMARK_STAGES = ["synced", "ingested", "analysed", "analysis_failed"] as const;
export type BookmarkStage = (typeof BOOKMARK_STAGES)[number];

export const BOOKMARK_STAGE_TRANSITIONS: Readonly<Record<BookmarkStage, readonly BookmarkStage[]>> = {
  synced: ["ingested"],
  ingested: ["analysed", "analysis_failed"],
  // An explicit retry resets the attempt count.
  analysis_failed: ["ingested"],
  analysed: [],
};

export function canMoveBookmarkStage(from: BookmarkStage, to: BookmarkStage): boolean {
  return BOOKMARK_STAGE_TRANSITIONS[from].includes(to);
}

/** How many failed analysis attempts a post gets before the pass gives up on it. */
export const MAX_ANALYSIS_ATTEMPTS = 3;

/**
 * The stage a bookmark is in, from the facts that are stored. Analysed wins; a post not yet ingested is
 * synced whatever its count says. `analysis_attempts` is 0 where the column does not exist.
 */
export function bookmarkStage(facts: {
  ingested_at: string | null;
  analysed: boolean;
  analysis_attempts?: number | null;
}): BookmarkStage {
  if (facts.analysed) return "analysed";
  if (!facts.ingested_at) return "synced";
  return (facts.analysis_attempts ?? 0) >= MAX_ANALYSIS_ATTEMPTS ? "analysis_failed" : "ingested";
}

/**
 * How many posts go into one analysis call, by how many attempts they already failed: 20 at first, 5
 * on the second try, then one at a time, so a post the model keeps choking on ends up alone and stops
 * taking good posts down with it.
 */
export function analysisBatchSize(attempts: number): number {
  if (attempts <= 0) return 20;
  return attempts === 1 ? 5 : 1;
}

/**
 * How much one processing chunk takes on: ingest up to 15 bookmarks (articles and
 * media are slow to fetch), then analyse up to 60 ingested ones in at most 12
 * model calls. Retried posts go in smaller batches, so a chunk is bounded by
 * model calls as well as by posts, which keeps a chunk of one-post retries short.
 * Moved here from the enrich route so every driver of the loop uses the same sizes.
 */
export const PIPELINE_CHUNK = { ingest: 15, enrich: 60, enrichCalls: 12 } as const;

/**
 * Where the chunk loop stands after one chunk. `remaining` is the larger of the
 * two backlogs; `stalled` means the chunk moved nothing while work is left, so
 * repeating it would spin forever. `missed` counts the posts the chunk tried and
 * charged a failed attempt: that is progress too, because a post can only be
 * charged MAX_ANALYSIS_ATTEMPTS times before it leaves the backlog.
 */
export function pipelineProgress(chunk: {
  ingested: number;
  enriched: number;
  missed?: number;
  ingestRemaining: number;
  enrichRemaining: number;
}): { remaining: number; stalled: boolean } {
  const remaining = Math.max(chunk.ingestRemaining, chunk.enrichRemaining);
  return { remaining, stalled: remaining > 0 && !chunk.ingested && !chunk.enriched && !chunk.missed };
}
