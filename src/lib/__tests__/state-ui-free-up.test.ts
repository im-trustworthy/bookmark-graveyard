import { describe, expect, it } from "vitest";
import {
  FREE_UP_IDLE,
  freeUpBusy,
  freeUpLabel,
  freeUpMessage,
  freeUpReducer,
  type FreeUp,
  type FreeUpEvent,
} from "../state/ui/free-up";

const states: Record<FreeUp["step"], FreeUp> = {
  idle: FREE_UP_IDLE,
  checking: { step: "checking", run: 7 },
  confirm: { step: "confirm", titles: ["A", "B"] },
  pruning: { step: "pruning", run: 7 },
  empty: { step: "empty" },
  done: { step: "done", pct: 41 },
  error: { step: "error", message: "Couldn't free up space" },
};

const events: Record<string, FreeUpEvent> = {
  check: { type: "check", run: 8 },
  checkedCurrent: { type: "checked", run: 7, titles: ["Old brief"] },
  checkedNone: { type: "checked", run: 7, titles: [] },
  checkedStale: { type: "checked", run: 6, titles: ["Old brief"] },
  prune: { type: "prune", run: 8 },
  prunedCurrent: { type: "pruned", run: 7, removed: 2, pct: 55 },
  prunedNone: { type: "pruned", run: 7, removed: 0, pct: 80 },
  prunedStale: { type: "pruned", run: 6, removed: 2, pct: 55 },
  failedCurrent: { type: "failed", run: 7, message: "nope" },
  failedStale: { type: "failed", run: 6, message: "nope" },
  reset: { type: "reset" },
};

const checking8: FreeUp = { step: "checking", run: 8 };
const resting = (overrides: Partial<Record<string, FreeUp | "same">> = {}) => ({
  check: checking8 as FreeUp | "same",
  checkedCurrent: "same" as const,
  checkedNone: "same" as const,
  checkedStale: "same" as const,
  prune: "same" as const,
  prunedCurrent: "same" as const,
  prunedNone: "same" as const,
  prunedStale: "same" as const,
  failedCurrent: "same" as const,
  failedStale: "same" as const,
  reset: FREE_UP_IDLE as FreeUp | "same",
  ...overrides,
});

const table: Record<FreeUp["step"], Record<string, FreeUp | "same">> = {
  idle: resting({ reset: "same" }),
  checking: {
    check: "same",
    checkedCurrent: { step: "confirm", titles: ["Old brief"] },
    checkedNone: { step: "empty" },
    checkedStale: "same",
    prune: "same",
    prunedCurrent: "same",
    prunedNone: "same",
    prunedStale: "same",
    failedCurrent: { step: "error", message: "nope" },
    failedStale: "same",
    reset: FREE_UP_IDLE,
  },
  confirm: resting({ check: "same", prune: { step: "pruning", run: 8 } }),
  pruning: {
    check: "same",
    checkedCurrent: "same",
    checkedNone: "same",
    checkedStale: "same",
    prune: "same",
    prunedCurrent: { step: "done", pct: 55 },
    prunedNone: { step: "empty" },
    prunedStale: "same",
    failedCurrent: { step: "error", message: "nope" },
    failedStale: "same",
    reset: FREE_UP_IDLE,
  },
  empty: resting(),
  done: resting(),
  error: resting(),
};

describe("freeUpReducer", () => {
  for (const [step, row] of Object.entries(table) as [FreeUp["step"], Record<string, FreeUp | "same">][]) {
    for (const [name, expected] of Object.entries(row)) {
      it(`${step} + ${name}`, () => {
        const state = states[step];
        const next = freeUpReducer(state, events[name]);
        if (expected === "same") expect(next).toBe(state);
        else expect(next).toEqual(expected);
      });
    }
  }

  it("a reset while a check is out drops that check's late answer", () => {
    let s = freeUpReducer(FREE_UP_IDLE, { type: "check", run: 1 });
    s = freeUpReducer(s, { type: "reset" }); // a new brief started
    expect(freeUpReducer(s, { type: "checked", run: 1, titles: ["A"] })).toBe(s);
    expect(freeUpReducer(s, { type: "failed", run: 1, message: "x" })).toBe(s);
  });

  it("a superseded run's answer can't overwrite the run after it", () => {
    let s = freeUpReducer(FREE_UP_IDLE, { type: "check", run: 1 });
    s = freeUpReducer(s, { type: "reset" });
    s = freeUpReducer(s, { type: "check", run: 2 });
    const current = s;
    expect(freeUpReducer(s, { type: "checked", run: 1, titles: ["A"] })).toBe(current);
    expect(freeUpReducer(s, { type: "checked", run: 2, titles: ["B"] })).toEqual({ step: "confirm", titles: ["B"] });
  });

  it("a reset while pruning drops the prune's late answer", () => {
    let s = freeUpReducer(states.confirm, { type: "prune", run: 3 });
    s = freeUpReducer(s, { type: "reset" });
    expect(freeUpReducer(s, { type: "pruned", run: 3, removed: 2, pct: 50 })).toBe(s);
  });
});

describe("free up selectors", () => {
  it("word each step as the banner always has", () => {
    expect(freeUpMessage(states.idle)).toBeNull();
    expect(freeUpMessage(states.checking)).toBeNull();
    expect(freeUpMessage({ step: "confirm", titles: ["One"] })).toBe(
      "This removes the audio of 1 older brief (markdown stays): One. Continue?"
    );
    expect(freeUpMessage({ step: "confirm", titles: ["A", "B", "C", "D", "E", "F"] })).toBe(
      "This removes the audio of 6 older briefs (markdown stays): A, B, C, D, E… Continue?"
    );
    expect(freeUpMessage(states.pruning)).toBe("Removing audio…");
    expect(freeUpMessage(states.empty)).toBe("Nothing to prune: your newest briefs are always kept.");
    expect(freeUpMessage(states.done)).toBe("Freed space: now 41% used.");
    expect(freeUpMessage(states.error)).toBe("Couldn't free up space");
  });

  it("label the button and report busy", () => {
    expect(freeUpLabel(states.checking, true)).toBe("Checking…");
    expect(freeUpLabel(states.pruning, false)).toBe("Removing…");
    expect(freeUpLabel(states.idle, true)).toBe("Free up space");
    expect(freeUpLabel(states.done, false)).toBe("Dismiss");
    expect(Object.values(states).filter(freeUpBusy)).toEqual([states.checking, states.pruning]);
  });
});
