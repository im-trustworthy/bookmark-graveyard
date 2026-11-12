/**
 * The "Check X for new" sync: pull bookmarks from X, then analyze them in chunks. Retry runs only
 * the analysis, for the posts the app gave up on, so it skips the pull. Pure: the dashboard runs
 * the requests and dispatches these events.
 */

export type SyncFlow =
  | { step: "idle" }
  | { step: "pulling" }
  | { step: "analyzing"; done: number; total: number }
  | { step: "done"; message: string }
  | { step: "failed"; message: string };

export type SyncEvent =
  | { type: "start" }
  // `total` is how many posts the app has given up on.
  | { type: "retry"; total: number }
  | { type: "progress"; done: number; total: number }
  | { type: "succeed"; message: string }
  | { type: "fail"; message: string }
  // The done message names the date range, so a range change makes it stale.
  | { type: "dismiss" };

export const SYNC_IDLE: SyncFlow = { step: "idle" };

export function syncReducer(state: SyncFlow, event: SyncEvent): SyncFlow {
  switch (event.type) {
    case "start":
      if (syncBusy(state)) return state;
      return { step: "pulling" };
    case "retry":
      if (syncBusy(state)) return state;
      return { step: "analyzing", done: 0, total: event.total };
    case "progress":
      if (!syncBusy(state)) return state;
      return { step: "analyzing", done: event.done, total: event.total };
    case "succeed":
      if (!syncBusy(state)) return state;
      return { step: "done", message: event.message };
    case "fail":
      if (!syncBusy(state)) return state;
      return { step: "failed", message: event.message };
    case "dismiss":
      if (state.step !== "done") return state;
      return SYNC_IDLE;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export function syncBusy(state: SyncFlow): boolean {
  return state.step === "pulling" || state.step === "analyzing";
}

export function syncStageLabel(state: SyncFlow): string | null {
  switch (state.step) {
    case "pulling":
      return "Pulling bookmarks from X…";
    case "analyzing":
      return "Reading linked articles & media, tagging topics…";
    case "idle":
    case "done":
    case "failed":
      return null;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function syncProgress(state: SyncFlow): { done: number; total: number } | null {
  return state.step === "analyzing" ? { done: state.done, total: state.total } : null;
}

export function syncDoneMessage(state: SyncFlow): string | null {
  return state.step === "done" ? state.message : null;
}

export function syncErrorMessage(state: SyncFlow): string | null {
  return state.step === "failed" ? state.message : null;
}
