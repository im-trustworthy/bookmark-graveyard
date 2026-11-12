/**
 * The async driver for the analysis loop (POST /api/enrich, one chunk per call), shared by a sync
 * once its pull lands and by Retry for the posts the app gave up on. It takes its I/O as
 * arguments, so a node test can run it against a fake `post`; the dashboard passes its real fetch
 * wrapper and dispatches.
 */
import { pipelineProgress } from "../pipeline";
import type { Post } from "./brief-runner";

export type { Post };

// Older servers leave `missed` out, so it is optional here and read as 0.
interface EnrichResponse {
  ingested: number;
  enriched: number;
  remaining: number;
  missed?: number;
}

export interface AnalysisRunDeps {
  post: Post;
  onProgress: (done: number, total: number) => void;
  // Fires after every chunk, so tags fill in on the list as each one lands.
  onChunk: () => void;
}

export interface AnalysisRunOptions {
  // Asks the server to make the given-up posts candidates again. Only the first call carries it:
  // repeating it would reset posts that just failed again and keep the loop from ending.
  retryFailed?: boolean;
}

export interface AnalysisRunResult {
  // Posts that got an analysis during this run.
  analyzed: number;
}

export function stalledMessage(remaining: number): string {
  return `Analysis stalled with ${remaining} bookmarks left — try again`;
}

/**
 * Runs chunks while work remains and resolves with how many posts were analyzed. `total` is the
 * expected amount of work: the sync's pending count, or the given-up count for a retry. A retry
 * always makes its first call, since the server decides what is a candidate again. A chunk that
 * only counted failed attempts still moves the loop on (those posts get given up after a few
 * tries); a chunk that moved nothing at all while work remains throws, as repeating it would spin.
 */
export async function runAnalysis(
  total: number,
  deps: AnalysisRunDeps,
  options: AnalysisRunOptions = {}
): Promise<AnalysisRunResult> {
  const { post, onProgress, onChunk } = deps;
  let pending = total;
  let analyzed = 0;
  let retryFailed = options.retryFailed === true;
  if (pending <= 0 && !retryFailed) return { analyzed };

  onProgress(0, total);
  while (pending > 0 || retryFailed) {
    const payload: Record<string, unknown> = retryFailed ? { retryFailed: true } : {};
    retryFailed = false;
    const chunk = (await post("/api/enrich", payload)) as EnrichResponse;
    const { remaining, stalled } = pipelineProgress({
      ingested: chunk.ingested,
      enriched: chunk.enriched,
      missed: chunk.missed ?? 0,
      ingestRemaining: chunk.remaining,
      enrichRemaining: chunk.remaining,
    });
    analyzed += chunk.enriched;
    onChunk();
    if (stalled) throw new Error(stalledMessage(remaining));
    pending = remaining;
    onProgress(Math.min(total, Math.max(0, total - pending)), total);
  }
  return { analyzed };
}
