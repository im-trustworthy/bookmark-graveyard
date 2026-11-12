/**
 * The capacity banner's "Free up space" flow: preview (dry run) -> confirm -> prune. Each check
 * or prune is a run with its own id, and only the current run's response may move the flow on:
 * resetting to idle (Cancel, Dismiss, or starting a new brief) drops the run in flight, so its
 * late answer can't bring back a prompt or result nobody is waiting for.
 */

export type FreeUp =
  | { step: "idle" | "empty" }
  | { step: "checking" | "pruning"; run: number }
  | { step: "confirm"; titles: string[] }
  | { step: "done"; pct: number }
  | { step: "error"; message: string };

export type FreeUpEvent =
  | { type: "check"; run: number }
  | { type: "checked"; run: number; titles: string[] }
  | { type: "prune"; run: number }
  // `removed` is how many briefs lost their audio; `pct` is storage use afterwards.
  | { type: "pruned"; run: number; removed: number; pct: number }
  | { type: "failed"; run: number; message: string }
  | { type: "reset" };

export const FREE_UP_IDLE: FreeUp = { step: "idle" };

function isCurrent(state: FreeUp, step: "checking" | "pruning", run: number): boolean {
  return state.step === step && state.run === run;
}

export function freeUpReducer(state: FreeUp, event: FreeUpEvent): FreeUp {
  switch (event.type) {
    case "check":
      // Only from a resting state: the confirm prompt and a run in flight own the buttons.
      if (state.step === "checking" || state.step === "pruning" || state.step === "confirm") return state;
      return { step: "checking", run: event.run };
    case "checked":
      if (!isCurrent(state, "checking", event.run)) return state;
      return event.titles.length > 0 ? { step: "confirm", titles: event.titles } : { step: "empty" };
    case "prune":
      if (state.step !== "confirm") return state;
      return { step: "pruning", run: event.run };
    case "pruned":
      if (!isCurrent(state, "pruning", event.run)) return state;
      return event.removed > 0 ? { step: "done", pct: event.pct } : { step: "empty" };
    case "failed":
      if (!isCurrent(state, "checking", event.run) && !isCurrent(state, "pruning", event.run)) return state;
      return { step: "error", message: event.message };
    case "reset":
      return state.step === "idle" ? state : FREE_UP_IDLE;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

// What the banner says about the Free up space flow, under the server's recommendation.
export function freeUpMessage(s: FreeUp): string | null {
  switch (s.step) {
    case "confirm": {
      const n = s.titles.length;
      const shown = s.titles.slice(0, 5).join(", ");
      return `This removes the audio of ${n} older ${n === 1 ? "brief" : "briefs"} (markdown stays): ${shown}${n > 5 ? "…" : "."} Continue?`;
    }
    case "pruning":
      return "Removing audio…";
    case "empty":
      return "Nothing to prune: your newest briefs are always kept.";
    case "done":
      return `Freed space: now ${s.pct}% used.`;
    case "error":
      return s.message;
    case "idle":
    case "checking":
      return null;
    default: {
      const unreachable: never = s;
      return unreachable;
    }
  }
}

export function freeUpBusy(s: FreeUp): boolean {
  return s.step === "checking" || s.step === "pruning";
}

/** The banner's single button: busy labels while a run is out, else Free up space or Dismiss. */
export function freeUpLabel(s: FreeUp, canFreeUp: boolean): string {
  if (s.step === "checking") return "Checking…";
  if (s.step === "pruning") return "Removing…";
  return canFreeUp ? "Free up space" : "Dismiss";
}
