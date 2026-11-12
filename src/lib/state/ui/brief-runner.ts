/**
 * The async driver for a brief's audio stages (script -> render loop -> finalize), shared by a
 * fresh generation and a resumed one. It takes its I/O as arguments, so a node test can run it
 * against a fake `post`; the dashboard passes its real fetch wrapper and a dispatch.
 */
import type { BriefStage, DigestStatusResponse, ResumableStage } from "./brief-flow";
import { isResumableStage } from "./brief-flow";

// Every brief aims for the same length; prepare and script both take it.
export const TARGET_MINUTES = 20;

// Resolves to the route's JSON body, or rejects with the route's error message. The body is
// unknown here and read only through the response shapes below.
export type Post = (url: string, payload: Record<string, unknown>) => Promise<unknown>;

interface ScriptResponse {
  totalLines: number;
}

interface RenderResponse {
  nextCursor: number;
  done: boolean;
}

export interface ResumePoint {
  stage: ResumableStage;
  totalLines: number;
  nextCursor: number;
}

export interface AudioRunDeps {
  post: Post;
  onStage: (stage: BriefStage) => void;
}

/**
 * Runs stages 2-4 for `episodeId` and resolves to the finalize response. With no `resume` it
 * starts by writing the script. A resume skips the script unless the draft still needs one, and
 * the render loop's `cursor < totalLines` guard means a needs_finalize draft (cursor already at
 * totalLines) goes straight to publishing.
 */
export async function runAudioStages<F = unknown>(
  episodeId: string,
  deps: AudioRunDeps,
  resume?: ResumePoint
): Promise<F> {
  const { post, onStage } = deps;
  let totalLines: number;
  let cursor: number;
  if (!resume || resume.stage === "needs_script") {
    onStage({ step: "scripting" });
    const scripted = (await post("/api/digest/script", {
      episodeId,
      targetMinutes: TARGET_MINUTES,
    })) as ScriptResponse;
    totalLines = scripted.totalLines;
    cursor = 0;
  } else {
    totalLines = resume.totalLines;
    cursor = resume.nextCursor;
  }

  while (cursor < totalLines) {
    onStage({ step: "rendering", cursor, total: totalLines });
    const rendered = (await post("/api/digest/render", { episodeId, cursor })) as RenderResponse;
    if (rendered.done) break;
    // A response that neither moves the cursor forward nor says done would loop forever,
    // re-recording the same line (and spending voice credits) on every pass.
    if (!(typeof rendered.nextCursor === "number" && rendered.nextCursor > cursor)) {
      throw new Error(`Recording stopped advancing at line ${cursor + 1} of ${totalLines}`);
    }
    cursor = rendered.nextCursor;
  }

  onStage({ step: "publishing" });
  return (await post("/api/digest/finalize", { episodeId })) as F;
}

// Reads one episode's current stage: the body, or null when the server answers 404.
export type GetStatus = (episodeId: string) => Promise<DigestStatusResponse | null>;

export type ResumeOutcome<F> =
  | { kind: "published"; finalized: F }
  // Another tab or the background job runner already finished it.
  | { kind: "finished" }
  // Deleted, or no longer a draft that can be resumed.
  | { kind: "gone" };

/**
 * Resumes a draft from its stage as the server reports it now, not as it was when the banner
 * was shown: another tab or the background job runner may have moved it on since.
 */
export async function resumeDraft<F = unknown>(
  episodeId: string,
  deps: AudioRunDeps & { getStatus: GetStatus }
): Promise<ResumeOutcome<F>> {
  const status = await deps.getStatus(episodeId);
  if (!status) return { kind: "gone" };
  if (status.stage === "ready") return { kind: "finished" };
  if (!isResumableStage(status.stage)) return { kind: "gone" };
  const finalized = await runAudioStages<F>(episodeId, deps, {
    stage: status.stage,
    totalLines: status.totalLines,
    nextCursor: status.nextCursor,
  });
  return { kind: "published", finalized };
}
