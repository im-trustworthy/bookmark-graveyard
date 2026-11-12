import { describe, expect, it } from "vitest";
import {
  SYNC_IDLE,
  syncBusy,
  syncDoneMessage,
  syncErrorMessage,
  syncProgress,
  syncReducer,
  syncStageLabel,
  type SyncEvent,
  type SyncFlow,
} from "../state/ui/sync-flow";

const states: Record<SyncFlow["step"], SyncFlow> = {
  idle: SYNC_IDLE,
  pulling: { step: "pulling" },
  analyzing: { step: "analyzing", done: 2, total: 9 },
  done: { step: "done", message: "Checked X: 3 bookmarks, 0 new since last time." },
  failed: { step: "failed", message: "Sync failed" },
};

const events: Record<SyncEvent["type"], SyncEvent> = {
  start: { type: "start" },
  retry: { type: "retry", total: 3 },
  progress: { type: "progress", done: 4, total: 9 },
  succeed: { type: "succeed", message: "All done." },
  fail: { type: "fail", message: "Analysis failed" },
  dismiss: { type: "dismiss" },
};

const analyzed: SyncFlow = { step: "analyzing", done: 4, total: 9 };
const succeeded: SyncFlow = { step: "done", message: "All done." };
const failed: SyncFlow = { step: "failed", message: "Analysis failed" };
const retrying: SyncFlow = { step: "analyzing", done: 0, total: 3 };

const table: Record<SyncFlow["step"], Record<SyncEvent["type"], SyncFlow | "same">> = {
  idle: { start: { step: "pulling" }, retry: retrying, progress: "same", succeed: "same", fail: "same", dismiss: "same" },
  pulling: { start: "same", retry: "same", progress: analyzed, succeed: succeeded, fail: failed, dismiss: "same" },
  analyzing: { start: "same", retry: "same", progress: analyzed, succeed: succeeded, fail: failed, dismiss: "same" },
  done: { start: { step: "pulling" }, retry: retrying, progress: "same", succeed: "same", fail: "same", dismiss: SYNC_IDLE },
  failed: { start: { step: "pulling" }, retry: retrying, progress: "same", succeed: "same", fail: "same", dismiss: "same" },
};

describe("syncReducer", () => {
  for (const [step, row] of Object.entries(table) as [SyncFlow["step"], Record<SyncEvent["type"], SyncFlow | "same">][]) {
    for (const [type, expected] of Object.entries(row) as [SyncEvent["type"], SyncFlow | "same"][]) {
      it(`${step} + ${type}`, () => {
        const state = states[step];
        const next = syncReducer(state, events[type]);
        if (expected === "same") expect(next).toBe(state);
        else expect(next).toEqual(expected);
      });
    }
  }

  it("a retry skips the pull and shows the analyzing stage", () => {
    const next = syncReducer(SYNC_IDLE, { type: "retry", total: 3 });
    expect(syncBusy(next)).toBe(true);
    expect(syncStageLabel(next)).toBe("Reading linked articles & media, tagging topics…");
    expect(syncProgress(next)).toEqual({ done: 0, total: 3 });
  });

  it("never shows a done message and an error together", () => {
    for (const s of Object.values(states)) {
      expect(syncDoneMessage(s) !== null && syncErrorMessage(s) !== null).toBe(false);
    }
  });
});

describe("sync selectors", () => {
  it("label the two busy stages with today's wording", () => {
    expect(syncStageLabel(states.pulling)).toBe("Pulling bookmarks from X…");
    expect(syncStageLabel(states.analyzing)).toBe("Reading linked articles & media, tagging topics…");
    expect(syncStageLabel(states.idle)).toBeNull();
    expect(syncStageLabel(states.done)).toBeNull();
    expect(syncStageLabel(states.failed)).toBeNull();
  });

  it("expose progress, busy, done and error per step", () => {
    expect(syncProgress(states.analyzing)).toEqual({ done: 2, total: 9 });
    expect(syncProgress(states.pulling)).toBeNull();
    expect(Object.values(states).filter(syncBusy)).toEqual([states.pulling, states.analyzing]);
    expect(syncDoneMessage(states.done)).toBe("Checked X: 3 bookmarks, 0 new since last time.");
    expect(syncDoneMessage(states.failed)).toBeNull();
    expect(syncErrorMessage(states.failed)).toBe("Sync failed");
    expect(syncErrorMessage(states.done)).toBeNull();
  });
});
