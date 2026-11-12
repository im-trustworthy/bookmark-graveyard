// The background brief job lifecycle as data: the states a brief_jobs row can hold, the stages its runner
// reports, the legal moves between them, and what an agent polling get_brief_status should do next.
// brief_jobs.status is CHECK-constrained to the four states; brief_jobs.stage has no CHECK, so the arrays
// here are its only definition. Pure: no I/O and no server imports, so the runner (src/lib/jobs.ts), the
// MCP tools and tests all share one vocabulary.

import type { EpisodeStatus } from "./episode";

// ---------------------------------------------------------------------------
// Job state (brief_jobs.status)
// ---------------------------------------------------------------------------

export const BRIEF_JOB_STATES = ["queued", "running", "done", "failed"] as const;
export type BriefJobState = (typeof BRIEF_JOB_STATES)[number];

/**
 * The legal moves, all made by claim_brief_job or the runner:
 * - queued -> running: the first claim
 * - running -> running: a stale lease taken over by a new claim
 * - running -> done | failed: the runner's outcome write
 * A finished job is final: the claim only ever takes a queued or running row.
 */
export const BRIEF_JOB_STATE_TRANSITIONS: Readonly<Record<BriefJobState, readonly BriefJobState[]>> = {
  queued: ["running"],
  running: ["running", "done", "failed"],
  done: [],
  failed: [],
};

export function canMoveBriefJobState(from: BriefJobState, to: BriefJobState): boolean {
  return BRIEF_JOB_STATE_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Job stage (brief_jobs.stage)
// ---------------------------------------------------------------------------

export const BRIEF_JOB_STAGES = [
  "queued",
  "syncing",
  "selecting",
  "writing",
  "scripting",
  "rendering",
  "publishing",
  "done",
  "failed",
] as const;
export type BriefJobStage = (typeof BRIEF_JOB_STAGES)[number];

export function isBriefJobStage(value: unknown): value is BriefJobStage {
  return (BRIEF_JOB_STAGES as readonly unknown[]).includes(value);
}

export interface BriefJobStageInfo {
  /** A short phrase an agent can pass on to a person as it stands. */
  label: string;
  /** The stage only runs once the episode exists, so a job there without one lost its draft. */
  needsEpisode: boolean;
  /** The job is finished; the runner never moves it again. */
  terminal: boolean;
}

export const BRIEF_JOB_STAGE_INFO: Readonly<Record<BriefJobStage, BriefJobStageInfo>> = {
  queued: { label: "Waiting to start", needsEpisode: false, terminal: false },
  syncing: { label: "Pulling new bookmarks from X", needsEpisode: false, terminal: false },
  selecting: { label: "Choosing posts", needsEpisode: false, terminal: false },
  writing: { label: "Writing the brief", needsEpisode: false, terminal: false },
  scripting: { label: "Writing the podcast script", needsEpisode: true, terminal: false },
  rendering: { label: "Recording audio", needsEpisode: true, terminal: false },
  publishing: { label: "Publishing the episode", needsEpisode: true, terminal: false },
  done: { label: "Finished", needsEpisode: false, terminal: true },
  failed: { label: "Failed", needsEpisode: false, terminal: true },
};

/**
 * Every move the runner can make from a stored stage, on a fresh run or on a re-claimed one (the runner
 * starts from whatever stage the claimed row holds). Grouped by why the move happens:
 * - Forward: queued -> syncing (sync first) | selecting; syncing -> selecting; selecting -> writing;
 *   writing -> scripting (a podcast draft) | done (a markdown-only brief is ready at once);
 *   scripting -> rendering | publishing (a script with no lines to render); rendering -> publishing;
 *   publishing -> done.
 * - Re-entry: a run cut off in syncing, selecting, scripting, rendering or publishing is taken over and
 *   writes the same stage again.
 * - Back through selecting: a run cut off in writing before it recorded its episode has nothing to resume
 *   from, so the next run selects again (without syncing again).
 * - Resume: once the job carries an episode (it is written only after the stage is `writing`, so a
 *   `queued` row never has one), the next run jumps to that episode's resume point: scripting, rendering,
 *   publishing, or done when it is already ready. The jump only moves forward, at or after the stored
 *   stage, from `writing` or an audio stage: a script is never cleared and chunk files go only with a
 *   publish or a discard, so a draft never falls behind its job. The user may have moved the draft on
 *   from the dashboard in between. The runner keys this on episode_id, not on the stage.
 * - Failure: any stage that is not final can fail.
 * done and failed are final.
 */
export const BRIEF_JOB_STAGE_TRANSITIONS: Readonly<Record<BriefJobStage, readonly BriefJobStage[]>> = {
  queued: ["syncing", "selecting", "failed"],
  syncing: ["syncing", "selecting", "failed"],
  selecting: ["selecting", "writing", "failed"],
  writing: ["selecting", "scripting", "rendering", "publishing", "done", "failed"],
  scripting: ["scripting", "rendering", "publishing", "done", "failed"],
  rendering: ["rendering", "publishing", "done", "failed"],
  publishing: ["publishing", "done", "failed"],
  done: [],
  failed: [],
};

export function canMoveBriefJobStage(from: BriefJobStage, to: BriefJobStage): boolean {
  return BRIEF_JOB_STAGE_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Outlook: what an agent polling the job should do next
// ---------------------------------------------------------------------------

export const BRIEF_JOB_NEXT_ACTIONS = [
  "wait",
  "use_write_token",
  "read_episode",
  "resume_in_dashboard",
  "start_again",
] as const;
export type BriefJobNextAction = (typeof BRIEF_JOB_NEXT_ACTIONS)[number];

/**
 * Whether a job has gone quiet longer than the stale window: a running job by its heartbeat, a queued one
 * by when it was created (its first runner never started). Strictly older than the window, as
 * claim_brief_job counts it. A finished job, a missing timestamp or one that doesn't parse is never stalled.
 */
export function briefJobStalled(
  job: { status: BriefJobState; heartbeat_at: string | null; created_at?: string | null },
  staleSeconds: number,
  now: number
): boolean {
  const since = job.status === "running" ? job.heartbeat_at : job.status === "queued" ? job.created_at : null;
  if (!since) return false;
  return now - Date.parse(since) > staleSeconds * 1000;
}

export interface BriefJobOutlookFacts {
  status: BriefJobState;
  heartbeat_at: string | null;
  created_at: string | null;
  /** The status of the episode the job drives; null when it has none (not yet made, or discarded). */
  episodeStatus: EpisodeStatus | null;
  staleSeconds: number;
  now: number;
  /** The caller may restart jobs (its token has write access). */
  canRestart: boolean;
  /** This poll just scheduled a new runner for the job. */
  rescheduled: boolean;
}

export interface BriefJobOutlook {
  stalled: boolean;
  next_action: BriefJobNextAction;
  note: string | null;
}

const NOTE_FINISHED_LATER = "This job failed, but the brief was finished afterwards from the dashboard.";
const NOTE_DRAFT_SAVED = "The draft is saved: the user can finish it from the Bookmark Graveyard dashboard.";
const NOTE_NOTHING_SAVED = "Nothing was saved; start a new brief if the user still wants one.";
const NOTE_RESTARTED = "This job had stalled; this poll restarted it.";
const NOTE_NEEDS_WRITE = "This job has stalled; restarting it needs a token with write access.";

/** What a status report tells the agent to do next, from the job's and its episode's state. */
export function briefJobOutlook(facts: BriefJobOutlookFacts): BriefJobOutlook {
  const { status } = facts;
  switch (status) {
    case "done":
      return { stalled: false, next_action: "read_episode", note: null };
    case "failed":
      // A failed episode is never written today; like no episode, there is nothing to resume.
      if (facts.episodeStatus === "ready") return { stalled: false, next_action: "read_episode", note: NOTE_FINISHED_LATER };
      if (facts.episodeStatus === "draft") return { stalled: false, next_action: "resume_in_dashboard", note: NOTE_DRAFT_SAVED };
      return { stalled: false, next_action: "start_again", note: NOTE_NOTHING_SAVED };
    case "queued":
    case "running": {
      if (!briefJobStalled(facts, facts.staleSeconds, facts.now)) return { stalled: false, next_action: "wait", note: null };
      if (facts.rescheduled) return { stalled: true, next_action: "wait", note: NOTE_RESTARTED };
      if (!facts.canRestart) return { stalled: true, next_action: "use_write_token", note: NOTE_NEEDS_WRITE };
      return { stalled: true, next_action: "wait", note: null };
    }
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled brief job state: ${String(unhandled)}`);
    }
  }
}
