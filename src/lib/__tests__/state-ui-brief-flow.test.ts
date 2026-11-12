import { describe, expect, it } from "vitest";
import {
  BANNER_NONE,
  bannerControls,
  briefErrorMessage,
  briefFailureMessage,
  briefFlowReducer,
  briefProgress,
  briefStageLabel,
  draftFromStatus,
  resumeBannerReducer,
  resumeStartStage,
  type BriefFlow,
  type BriefFlowEvent,
  type ResumableDraft,
  type ResumeBanner,
  type ResumeBannerEvent,
} from "../state/ui/brief-flow";

type Result = { id: string };
type Flow = BriefFlow<Result>;
type FlowEvent = BriefFlowEvent<Result>;

const flows: Record<Flow["step"], Flow> = {
  idle: { step: "idle" },
  working: { step: "working", stage: { step: "scripting" }, startedAt: 100 },
  succeeded: { step: "succeeded", result: { id: "ep-1" } },
  failed: { step: "failed", message: "boom" },
};

const flowEvents: Record<FlowEvent["type"], FlowEvent> = {
  start: { type: "start", startedAt: 500, stage: { step: "preparing" } },
  stage: { type: "stage", stage: { step: "rendering", cursor: 3, total: 10 } },
  succeed: { type: "succeed", result: { id: "ep-2" } },
  fail: { type: "fail", message: "nope" },
  stop: { type: "stop" },
  clearError: { type: "clearError" },
};

const started: Flow = { step: "working", stage: { step: "preparing" }, startedAt: 500 };

// Every step x event pair: the expected next state, or "same" for an illegal move.
const flowTable: Record<Flow["step"], Record<FlowEvent["type"], Flow | "same">> = {
  idle: { start: started, stage: "same", succeed: "same", fail: "same", stop: "same", clearError: "same" },
  working: {
    start: "same",
    stage: { step: "working", stage: { step: "rendering", cursor: 3, total: 10 }, startedAt: 100 },
    succeed: { step: "succeeded", result: { id: "ep-2" } },
    fail: { step: "failed", message: "nope" },
    stop: { step: "idle" },
    clearError: "same",
  },
  succeeded: { start: started, stage: "same", succeed: "same", fail: "same", stop: "same", clearError: "same" },
  failed: { start: started, stage: "same", succeed: "same", fail: "same", stop: "same", clearError: { step: "idle" } },
};

describe("briefFlowReducer", () => {
  for (const [step, row] of Object.entries(flowTable) as [Flow["step"], Record<FlowEvent["type"], Flow | "same">][]) {
    for (const [type, expected] of Object.entries(row) as [FlowEvent["type"], Flow | "same"][]) {
      it(`${step} + ${type}`, () => {
        const state = flows[step];
        const next = briefFlowReducer(state, flowEvents[type]);
        if (expected === "same") expect(next).toBe(state);
        else expect(next).toEqual(expected);
      });
    }
  }

  it("keeps startedAt across stage changes, so the clock doesn't restart", () => {
    let s: Flow = briefFlowReducer(flows.idle, flowEvents.start);
    s = briefFlowReducer(s, { type: "stage", stage: { step: "scripting" } });
    s = briefFlowReducer(s, { type: "stage", stage: { step: "publishing" } });
    expect(s).toEqual({ step: "working", stage: { step: "publishing" }, startedAt: 500 });
  });

  it("a late failure after success leaves the result alone", () => {
    const done = briefFlowReducer(flows.working, flowEvents.succeed);
    expect(briefFlowReducer(done, { type: "fail", message: "episodes refresh failed" })).toBe(done);
  });
});

describe("brief stage selectors", () => {
  it("label each stage with today's wording", () => {
    expect(briefStageLabel({ step: "preparing" })).toBe("Reading your posts & writing the brief…");
    expect(briefStageLabel({ step: "scripting" })).toBe("Writing the show script…");
    expect(briefStageLabel({ step: "rendering", cursor: 0, total: 42 })).toBe("Recording audio — line 1 of 42");
    expect(briefStageLabel({ step: "rendering", cursor: 17, total: 42 })).toBe("Recording audio — line 18 of 42");
    expect(briefStageLabel({ step: "publishing" })).toBe("Mixing & publishing…");
  });

  it("report progress only while recording, capped at 1", () => {
    expect(briefProgress({ step: "preparing" })).toBeNull();
    expect(briefProgress({ step: "scripting" })).toBeNull();
    expect(briefProgress({ step: "publishing" })).toBeNull();
    expect(briefProgress({ step: "rendering", cursor: 0, total: 40 })).toBe(0);
    expect(briefProgress({ step: "rendering", cursor: 10, total: 40 })).toBe(0.25);
    expect(briefProgress({ step: "rendering", cursor: 50, total: 40 })).toBe(1);
    expect(briefProgress({ step: "rendering", cursor: 0, total: 0 })).toBe(0);
  });

  it("start a resume at the cached draft's stage", () => {
    expect(resumeStartStage({ stage: "needs_script", totalLines: 0, nextCursor: 0 })).toEqual({ step: "scripting" });
    expect(resumeStartStage({ stage: "rendering", totalLines: 30, nextCursor: 12 })).toEqual({
      step: "rendering",
      cursor: 12,
      total: 30,
    });
    expect(resumeStartStage({ stage: "needs_finalize", totalLines: 30, nextCursor: 30 })).toEqual({
      step: "publishing",
    });
  });

  it("add the draft suffix only when the episode id is known", () => {
    expect(briefFailureMessage(new Error("Render failed"), "ep-1")).toBe(
      "Render failed — this brief is saved as a draft, so you can resume it instead of starting over."
    );
    expect(briefFailureMessage(new Error("Prepare timed out"), undefined)).toBe("Prepare timed out");
    expect(briefFailureMessage("not an error", undefined)).toBe("Generation failed");
  });
});

describe("draftFromStatus", () => {
  const base = { totalLines: 10, nextCursor: 4, markdownReady: true, title: "T", createdAt: "2026-11-01" };
  it("offers resumable stages and nothing else", () => {
    expect(draftFromStatus({ ...base, episodeId: "ep-1", stage: "rendering" })).toEqual({
      episodeId: "ep-1",
      stage: "rendering",
      totalLines: 10,
      nextCursor: 4,
      title: "T",
      createdAt: "2026-11-01",
    });
    expect(draftFromStatus({ ...base, episodeId: "ep-1", stage: "ready" })).toBeNull();
    expect(draftFromStatus({ ...base, episodeId: null, stage: "none" })).toBeNull();
    expect(draftFromStatus({ ...base, episodeId: null, stage: "rendering" })).toBeNull();
  });
});

const draftA: ResumableDraft = { episodeId: "a", stage: "rendering", totalLines: 10, nextCursor: 2 };
const draftB: ResumableDraft = { episodeId: "b", stage: "needs_script", totalLines: 0, nextCursor: 0 };

const banners: Record<string, ResumeBanner> = {
  none: BANNER_NONE,
  available: { step: "available", draft: draftA, error: null },
  availableWithError: { step: "available", draft: draftA, error: "Couldn't discard draft" },
  discarding: { step: "discarding", draft: draftA },
};

const bannerEvents: Record<string, ResumeBannerEvent> = {
  foundSame: { type: "found", draft: { ...draftA, nextCursor: 5 } },
  foundOther: { type: "found", draft: draftB },
  cleared: { type: "cleared" },
  discard: { type: "discard" },
  discarded: { type: "discarded" },
  discardFailed: { type: "discardFailed", message: "Server said no" },
  clearError: { type: "clearError" },
};

const bannerTable: Record<string, Record<string, ResumeBanner | "same">> = {
  none: {
    foundSame: { step: "available", draft: { ...draftA, nextCursor: 5 }, error: null },
    foundOther: { step: "available", draft: draftB, error: null },
    cleared: "same",
    discard: "same",
    discarded: "same",
    discardFailed: "same",
    clearError: "same",
  },
  available: {
    foundSame: { step: "available", draft: { ...draftA, nextCursor: 5 }, error: null },
    foundOther: { step: "available", draft: draftB, error: null },
    cleared: BANNER_NONE,
    discard: { step: "discarding", draft: draftA },
    discarded: "same",
    discardFailed: "same",
    clearError: "same",
  },
  availableWithError: {
    // A refresh of the same draft keeps its discard error; another draft starts clean.
    foundSame: { step: "available", draft: { ...draftA, nextCursor: 5 }, error: "Couldn't discard draft" },
    foundOther: { step: "available", draft: draftB, error: null },
    cleared: BANNER_NONE,
    discard: { step: "discarding", draft: draftA },
    discarded: "same",
    discardFailed: "same",
    clearError: { step: "available", draft: draftA, error: null },
  },
  discarding: {
    foundSame: "same",
    foundOther: "same",
    cleared: "same",
    discard: "same",
    discarded: BANNER_NONE,
    discardFailed: { step: "available", draft: draftA, error: "Server said no" },
    clearError: "same",
  },
};

describe("resumeBannerReducer", () => {
  for (const [name, row] of Object.entries(bannerTable)) {
    for (const [eventName, expected] of Object.entries(row)) {
      it(`${name} + ${eventName}`, () => {
        const state = banners[name];
        const next = resumeBannerReducer(state, bannerEvents[eventName]);
        if (expected === "same") expect(next).toBe(state);
        else expect(next).toEqual(expected);
      });
    }
  }
});

describe("bannerControls and briefErrorMessage", () => {
  it("disables both buttons while discarding, and Discard while a brief works", () => {
    expect(bannerControls(banners.available, flows.idle)).toEqual({
      resumeDisabled: false,
      discardDisabled: false,
      discardLabel: "Discard",
    });
    expect(bannerControls(banners.discarding, flows.idle)).toEqual({
      resumeDisabled: true,
      discardDisabled: true,
      discardLabel: "Discarding…",
    });
    expect(bannerControls(banners.available, flows.working)).toEqual({
      resumeDisabled: false,
      discardDisabled: true,
      discardLabel: "Discard",
    });
  });

  it("shows a failed discard, else a failed create or resume", () => {
    expect(briefErrorMessage(flows.idle, banners.none)).toBeNull();
    expect(briefErrorMessage(flows.failed, banners.none)).toBe("boom");
    expect(briefErrorMessage(flows.succeeded, banners.availableWithError)).toBe("Couldn't discard draft");
    expect(briefErrorMessage(flows.working, banners.discarding)).toBeNull();
  });
});
