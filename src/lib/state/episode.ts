// The episode lifecycle as data: the statuses a row can hold, the resume stages a staged brief moves
// through, and the pure functions that read one from persisted facts. No I/O and no server imports, so
// the stage functions in src/lib/digest.ts, the routes, the job runner, client components and tests all
// share one vocabulary instead of re-deriving it from bare strings.

// ---------------------------------------------------------------------------
// Row status (episodes.status)
// ---------------------------------------------------------------------------

/**
 * Every value episodes.status may hold. `failed` is allowed by the database CHECK constraint but nothing
 * writes it today: a brief that fails mid-generation stays a `draft` so it can be resumed or discarded.
 */
export const EPISODE_STATUSES = ["draft", "ready", "failed"] as const;
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

/** The statuses by name, so a filter or comparison reads `EPISODE_STATUS.draft` rather than a bare string. */
export const EPISODE_STATUS = {
  draft: "draft",
  ready: "ready",
  failed: "failed",
} as const satisfies { [S in EpisodeStatus]: S };

export function isEpisodeStatus(value: unknown): value is EpisodeStatus {
  return (EPISODE_STATUSES as readonly unknown[]).includes(value);
}

/** Lines in a stored script: the jsonb column is null until written, and anything not an array counts as none. */
export function scriptLengthOf(script: unknown): number {
  return Array.isArray(script) ? script.length : 0;
}

// ---------------------------------------------------------------------------
// Row state: what the row alone says, without listing storage
// ---------------------------------------------------------------------------

export const EPISODE_ROW_STATES = ["unscripted_draft", "scripted_draft", "ready", "failed"] as const;
export type EpisodeRowState = (typeof EPISODE_ROW_STATES)[number];

/**
 * The part of an episode's state knowable from its row, without listing the chunk files in storage: a
 * draft with or without its script, a finished brief, or a failed one. Where a scripted draft is in its
 * render needs the chunk listing, which is what deriveDigestStage adds.
 *
 * The CHECK constraint admits only the three statuses; anything else is read as `failed`, the one state
 * no stage will act on.
 */
export function episodeRowState(input: { status: string; scriptLength: number }): EpisodeRowState {
  const { status, scriptLength } = input;
  if (!isEpisodeStatus(status)) return "failed";
  switch (status) {
    case "draft":
      return scriptLength > 0 ? "scripted_draft" : "unscripted_draft";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled episode status: ${String(unhandled)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Audio availability (audio_path, audio_pruned_at)
// ---------------------------------------------------------------------------

export const AUDIO_AVAILABILITIES = ["none", "available", "pruned"] as const;
export type AudioAvailability = (typeof AUDIO_AVAILABILITIES)[number];

/**
 * Whether an episode's MP3 can be played: `available` when it has an audio path and was not pruned,
 * `pruned` when the capacity guard removed it (src/lib/capacity.ts clears audio_path and stamps
 * audio_pruned_at), `none` when it never had audio (markdown-only, or a podcast not yet finalized).
 */
export function audioAvailability(episode: {
  audio_path: string | null;
  audio_pruned_at: string | null;
}): AudioAvailability {
  if (episode.audio_pruned_at) return "pruned";
  return episode.audio_path ? "available" : "none";
}

// ---------------------------------------------------------------------------
// Digest stages: where a staged brief generation stands, and how it moves
// ---------------------------------------------------------------------------

// Script lines rendered per /api/digest/render call (and per uploaded chunk file).
// Shared with the render route and the status route's resume-cursor math — keep
// them importing this instead of redeclaring the number so they can't drift.
export const LINES_PER_CALL = 12;

export const DIGEST_STAGES = ["needs_script", "rendering", "needs_finalize", "ready", "none"] as const;
export type DigestStage = (typeof DIGEST_STAGES)[number];

export interface DigestStageResult {
  stage: DigestStage;
  totalLines: number;
  nextCursor: number;
}

/** The stages an unfinished draft can be resumed from: the Resume banner and the job runner pick up here. */
export const RESUMABLE_STAGES = ["needs_script", "rendering", "needs_finalize"] as const satisfies readonly DigestStage[];
export type ResumableStage = (typeof RESUMABLE_STAGES)[number];

export function isResumableStage(stage: DigestStage): stage is ResumableStage {
  return (RESUMABLE_STAGES as readonly DigestStage[]).includes(stage);
}

/**
 * The legal moves between stages, and which stage function makes each:
 * - none -> needs_script | ready: prepare (a podcast draft, or a markdown-only brief that is done at once)
 * - needs_script -> rendering: script
 * - rendering -> rendering | needs_finalize: render (one chunk per call; the last one reaches the end)
 * - needs_finalize -> ready: finalize
 * - any draft stage -> none: discard
 * A ready brief is final: nothing in the pipeline moves it again.
 */
export const DIGEST_STAGE_TRANSITIONS: Readonly<Record<DigestStage, readonly DigestStage[]>> = {
  none: ["needs_script", "ready"],
  needs_script: ["rendering", "none"],
  rendering: ["rendering", "needs_finalize", "none"],
  needs_finalize: ["ready", "none"],
  ready: [],
};

export function canMoveDigestStage(from: DigestStage, to: DigestStage): boolean {
  return DIGEST_STAGE_TRANSITIONS[from].includes(to);
}

/**
 * Pure resume state machine — no I/O, so the cursor math is unit-testable in
 * isolation. Given an episode's persisted status/script and the chunk-file
 * start indices already in storage, decides which stage to resume from and
 * where.
 *
 * `nextCursor` is always "where /api/digest/render should resume from, or
 * totalLines if there's nothing left to render" — that lets a client drive
 * both the 'rendering' and 'needs_finalize' cases through the same
 * `while (cursor < totalLines)` loop without branching on stage.
 *
 * Resume-point rule: the LAST chunk's start index (not start+length). Chunk
 * uploads use upsert:true, and a chunk that was mid-upload when generation
 * was interrupted may be partial, so re-rendering it is always safe and
 * correct — whereas trusting it and skipping past it risks baking a
 * truncated segment into the final MP3. Once the highest chunk on record
 * covers through the end of the script, rendering is done (a render call
 * only ever returns success after its upload confirms), so resume goes
 * straight to 'needs_finalize' instead of redundantly redoing that chunk.
 *
 * The row's status is read through episodeRowState, so the two agree: a `failed` row, or a status the
 * CHECK constraint doesn't admit, is the state no stage will act on, and answers `none` rather than a
 * stage every stage function would then refuse.
 */
export function deriveDigestStage(input: {
  status: string;
  scriptLength: number;
  chunkStarts: number[];
}): DigestStageResult {
  const { status, scriptLength, chunkStarts } = input;
  const row = episodeRowState({ status, scriptLength });

  switch (row) {
    case "ready":
      return { stage: "ready", totalLines: scriptLength, nextCursor: scriptLength };
    case "failed":
      return { stage: "none", totalLines: 0, nextCursor: 0 };
    case "unscripted_draft":
      return { stage: "needs_script", totalLines: 0, nextCursor: 0 };
    case "scripted_draft": {
      if (chunkStarts.length === 0) {
        return { stage: "rendering", totalLines: scriptLength, nextCursor: 0 };
      }
      const lastStart = Math.max(...chunkStarts);
      const renderedThroughEnd = lastStart + LINES_PER_CALL >= scriptLength;
      if (renderedThroughEnd) {
        return { stage: "needs_finalize", totalLines: scriptLength, nextCursor: scriptLength };
      }
      return { stage: "rendering", totalLines: scriptLength, nextCursor: lastStart };
    }
    default: {
      const unhandled: never = row;
      throw new Error(`Unhandled episode row state: ${String(unhandled)}`);
    }
  }
}
