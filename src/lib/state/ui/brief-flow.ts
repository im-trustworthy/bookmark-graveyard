/**
 * The dashboard's brief creation flow and its Resume banner, as two small state machines. Pure:
 * no React, no fetch. The dashboard consumes both with useReducer and drives the network calls
 * (see brief-runner.ts); everything it shows about them comes from the selectors below.
 */

import { isResumableStage } from "../episode";
import type { DigestStage, ResumableStage } from "../episode";

// The stages a draft can be resumed from are defined in ../episode; re-exported for the flow's consumers.
export { isResumableStage };
export type { ResumableStage };

export interface ResumableDraft {
  episodeId: string;
  stage: ResumableStage;
  totalLines: number;
  nextCursor: number;
  title?: string;
  createdAt?: string;
}

export interface DigestStatusResponse {
  episodeId: string | null;
  stage: DigestStage;
  totalLines: number;
  nextCursor: number;
  markdownReady: boolean;
  title?: string;
  createdAt?: string;
}

/** The banner's draft from a status response, or null when there is nothing to resume. */
export function draftFromStatus(body: DigestStatusResponse): ResumableDraft | null {
  if (!body.episodeId || !isResumableStage(body.stage)) return null;
  return {
    episodeId: body.episodeId,
    stage: body.stage,
    totalLines: body.totalLines,
    nextCursor: body.nextCursor,
    title: body.title,
    createdAt: body.createdAt,
  };
}

// What a working brief is doing right now. `cursor` is the next line to record.
export type BriefStage =
  | { step: "preparing" }
  | { step: "scripting" }
  | { step: "rendering"; cursor: number; total: number }
  | { step: "publishing" };

export type BriefFlow<R> =
  | { step: "idle" }
  | { step: "working"; stage: BriefStage; startedAt: number }
  | { step: "succeeded"; result: R }
  | { step: "failed"; message: string };

export type BriefFlowEvent<R> =
  | { type: "start"; startedAt: number; stage: BriefStage }
  | { type: "stage"; stage: BriefStage }
  | { type: "succeed"; result: R }
  | { type: "fail"; message: string }
  // Ends a run with nothing to show: a resumed draft turned out to be finished elsewhere.
  | { type: "stop" }
  // Starting another part of the brief flow (a discard) clears the last create/resume error.
  | { type: "clearError" };

export const BRIEF_IDLE: BriefFlow<never> = { step: "idle" };

export function briefFlowReducer<R>(state: BriefFlow<R>, event: BriefFlowEvent<R>): BriefFlow<R> {
  switch (event.type) {
    case "start":
      // One run at a time: a second start while working is ignored.
      if (state.step === "working") return state;
      return { step: "working", stage: event.stage, startedAt: event.startedAt };
    case "stage":
      if (state.step !== "working") return state;
      return { step: "working", stage: event.stage, startedAt: state.startedAt };
    case "succeed":
      if (state.step !== "working") return state;
      return { step: "succeeded", result: event.result };
    case "fail":
      // Only a running brief can fail. A late error after success (say, refreshing the episode
      // list) must never turn a finished brief red.
      if (state.step !== "working") return state;
      return { step: "failed", message: event.message };
    case "stop":
      if (state.step !== "working") return state;
      return { step: "idle" };
    case "clearError":
      if (state.step !== "failed") return state;
      return { step: "idle" };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export function briefStageLabel(stage: BriefStage): string {
  switch (stage.step) {
    case "preparing":
      return "Reading your posts & writing the brief…";
    case "scripting":
      return "Writing the show script…";
    case "rendering":
      return `Recording audio — line ${stage.cursor + 1} of ${stage.total}`;
    case "publishing":
      return "Mixing & publishing…";
    default: {
      const unreachable: never = stage;
      return unreachable;
    }
  }
}

/** 0..1 while recording, null (an indeterminate bar) for every other stage. */
export function briefProgress(stage: BriefStage): number | null {
  switch (stage.step) {
    case "rendering":
      return stage.total > 0 ? Math.min(stage.cursor / stage.total, 1) : 0;
    case "preparing":
    case "scripting":
    case "publishing":
      return null;
    default: {
      const unreachable: never = stage;
      return unreachable;
    }
  }
}

/** Where the progress panel starts when resuming, before the fresh status read lands. */
export function resumeStartStage(draft: Pick<ResumableDraft, "stage" | "totalLines" | "nextCursor">): BriefStage {
  switch (draft.stage) {
    case "needs_script":
      return { step: "scripting" };
    case "rendering":
      return { step: "rendering", cursor: draft.nextCursor, total: draft.totalLines };
    case "needs_finalize":
      return { step: "publishing" };
    default: {
      const unreachable: never = draft.stage;
      return unreachable;
    }
  }
}

export const DRAFT_GONE_MESSAGE = "That draft is no longer available.";

/**
 * A create/resume failure. The draft row is left in place on purpose, so when the episode id is
 * known the message says the brief can be resumed instead of started over.
 */
export function briefFailureMessage(err: unknown, episodeId: string | undefined): string {
  const base = err instanceof Error ? err.message : "Generation failed";
  return episodeId
    ? `${base} — this brief is saved as a draft, so you can resume it instead of starting over.`
    : base;
}

// The Resume banner. `error` is the last failed discard, shown as the brief flow's error.
export type ResumeBanner =
  | { step: "none" }
  | { step: "available"; draft: ResumableDraft; error: string | null }
  | { step: "discarding"; draft: ResumableDraft };

export type ResumeBannerEvent =
  // A status check found a resumable draft.
  | { type: "found"; draft: ResumableDraft }
  // A status check found none, a fresh brief superseded it, or it was resumed or finished.
  | { type: "cleared" }
  | { type: "discard" }
  | { type: "discarded" }
  | { type: "discardFailed"; message: string }
  | { type: "clearError" };

export const BANNER_NONE: ResumeBanner = { step: "none" };

export function resumeBannerReducer(state: ResumeBanner, event: ResumeBannerEvent): ResumeBanner {
  switch (event.type) {
    case "found":
      // A check landing mid-discard must not bring back the draft the server is deleting.
      if (state.step === "discarding") return state;
      return {
        step: "available",
        draft: event.draft,
        // A refresh of the same draft keeps the discard error; a different draft starts clean.
        error:
          state.step === "available" && state.draft.episodeId === event.draft.episodeId ? state.error : null,
      };
    case "cleared":
      if (state.step !== "available") return state;
      return BANNER_NONE;
    case "discard":
      if (state.step !== "available") return state;
      return { step: "discarding", draft: state.draft };
    case "discarded":
      if (state.step !== "discarding") return state;
      return BANNER_NONE;
    case "discardFailed":
      if (state.step !== "discarding") return state;
      return { step: "available", draft: state.draft, error: event.message };
    case "clearError":
      if (state.step !== "available" || state.error === null) return state;
      return { step: "available", draft: state.draft, error: null };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export interface BannerControls {
  resumeDisabled: boolean;
  discardDisabled: boolean;
  discardLabel: string;
}

/** Resume and Discard both wait out a discard in flight; Discard also waits out a working brief. */
export function bannerControls<R>(banner: ResumeBanner, flow: BriefFlow<R>): BannerControls {
  const discarding = banner.step === "discarding";
  return {
    resumeDisabled: discarding,
    discardDisabled: discarding || flow.step === "working",
    discardLabel: discarding ? "Discarding…" : "Discard",
  };
}

/** The one brief error line: a failed discard, else a failed create or resume. */
export function briefErrorMessage<R>(flow: BriefFlow<R>, banner: ResumeBanner): string | null {
  if (banner.step === "available" && banner.error) return banner.error;
  return flow.step === "failed" ? flow.message : null;
}
