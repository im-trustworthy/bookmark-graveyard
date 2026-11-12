import { describe, expect, it } from "vitest";
import {
  BRIEF_JOB_NEXT_ACTIONS,
  BRIEF_JOB_STAGE_INFO,
  BRIEF_JOB_STAGE_TRANSITIONS,
  BRIEF_JOB_STAGES,
  BRIEF_JOB_STATE_TRANSITIONS,
  BRIEF_JOB_STATES,
  briefJobOutlook,
  briefJobStalled,
  canMoveBriefJobStage,
  canMoveBriefJobState,
  isBriefJobStage,
} from "@/lib/state/brief-job";
import type { BriefJobOutlookFacts, BriefJobStage, BriefJobState } from "@/lib/state/brief-job";

// The background brief job lifecycle: both transition tables pair by pair, the stage metadata, and what a
// status report tells an agent to do next for every combination the rules name.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const STALE = 90;
const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();

describe("BRIEF_JOB_STATE_TRANSITIONS / canMoveBriefJobState", () => {
  const legal: Record<BriefJobState, BriefJobState[]> = {
    queued: ["running"],
    running: ["running", "done", "failed"],
    done: [],
    failed: [],
  };

  for (const from of BRIEF_JOB_STATES) {
    for (const to of BRIEF_JOB_STATES) {
      const allowed = legal[from].includes(to);
      it(`${from} -> ${to}: ${allowed ? "allowed" : "refused"}`, () => {
        expect(canMoveBriefJobState(from, to)).toBe(allowed);
      });
    }
  }

  it("has an entry for every state and nothing else", () => {
    expect(Object.keys(BRIEF_JOB_STATE_TRANSITIONS).sort()).toEqual([...BRIEF_JOB_STATES].sort());
  });
});

describe("BRIEF_JOB_STAGE_TRANSITIONS / canMoveBriefJobStage", () => {
  const legal: Record<BriefJobStage, BriefJobStage[]> = {
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

  for (const from of BRIEF_JOB_STAGES) {
    for (const to of BRIEF_JOB_STAGES) {
      const allowed = legal[from].includes(to);
      it(`${from} -> ${to}: ${allowed ? "allowed" : "refused"}`, () => {
        expect(canMoveBriefJobStage(from, to)).toBe(allowed);
      });
    }
  }

  it("has an entry for every stage and nothing else", () => {
    expect(Object.keys(BRIEF_JOB_STAGE_TRANSITIONS).sort()).toEqual([...BRIEF_JOB_STAGES].sort());
  });

  it("lets every stage that isn't final fail, and moves nothing out of a final one", () => {
    for (const stage of BRIEF_JOB_STAGES) {
      if (BRIEF_JOB_STAGE_INFO[stage].terminal) expect(BRIEF_JOB_STAGE_TRANSITIONS[stage], stage).toEqual([]);
      else expect(canMoveBriefJobStage(stage, "failed"), stage).toBe(true);
    }
  });
});

describe("BRIEF_JOB_STAGE_INFO", () => {
  it("has one entry per stage, each with a label", () => {
    expect(Object.keys(BRIEF_JOB_STAGE_INFO).sort()).toEqual([...BRIEF_JOB_STAGES].sort());
    for (const stage of BRIEF_JOB_STAGES) expect(BRIEF_JOB_STAGE_INFO[stage].label, stage).not.toBe("");
    expect(BRIEF_JOB_STAGE_INFO.rendering.label).toBe("Recording audio");
  });

  it("only the three audio stages need an episode, and only done and failed are final", () => {
    const needing = BRIEF_JOB_STAGES.filter((s) => BRIEF_JOB_STAGE_INFO[s].needsEpisode);
    const terminal = BRIEF_JOB_STAGES.filter((s) => BRIEF_JOB_STAGE_INFO[s].terminal);
    expect(needing).toEqual(["scripting", "rendering", "publishing"]);
    expect(terminal).toEqual(["done", "failed"]);
  });

  it("isBriefJobStage knows the stages and nothing else", () => {
    for (const stage of BRIEF_JOB_STAGES) expect(isBriefJobStage(stage)).toBe(true);
    for (const other of ["", "Rendering", "ready", null, 3]) expect(isBriefJobStage(other)).toBe(false);
  });
});

describe("briefJobStalled", () => {
  it("a running job goes by its heartbeat, strictly older than the window", () => {
    const at = (s: number) => briefJobStalled({ status: "running", heartbeat_at: secondsAgo(s), created_at: secondsAgo(999) }, STALE, NOW);
    expect(at(STALE - 1)).toBe(false);
    expect(at(STALE)).toBe(false);
    expect(at(STALE + 1)).toBe(true);
  });

  it("a queued job goes by when it was created", () => {
    const at = (s: number) => briefJobStalled({ status: "queued", heartbeat_at: null, created_at: secondsAgo(s) }, STALE, NOW);
    expect(at(STALE)).toBe(false);
    expect(at(STALE + 1)).toBe(true);
  });

  it("a finished job, or a missing or unparseable timestamp, is never stalled", () => {
    for (const status of ["done", "failed"] as const) {
      expect(briefJobStalled({ status, heartbeat_at: secondsAgo(999), created_at: secondsAgo(999) }, STALE, NOW)).toBe(false);
    }
    expect(briefJobStalled({ status: "running", heartbeat_at: null, created_at: secondsAgo(999) }, STALE, NOW)).toBe(false);
    expect(briefJobStalled({ status: "queued", heartbeat_at: null }, STALE, NOW)).toBe(false);
    expect(briefJobStalled({ status: "running", heartbeat_at: "not a date" }, STALE, NOW)).toBe(false);
  });
});

describe("briefJobOutlook", () => {
  const facts = (extra: Partial<BriefJobOutlookFacts>): BriefJobOutlookFacts => ({
    status: "running",
    heartbeat_at: secondsAgo(10),
    created_at: secondsAgo(600),
    episodeStatus: null,
    staleSeconds: STALE,
    now: NOW,
    canRestart: false,
    rescheduled: false,
    ...extra,
  });

  it("done: read the episode", () => {
    expect(briefJobOutlook(facts({ status: "done", episodeStatus: "ready" }))).toEqual({
      stalled: false,
      next_action: "read_episode",
      note: null,
    });
  });

  it("failed, but the brief was finished from the dashboard: read the episode, with a note", () => {
    expect(briefJobOutlook(facts({ status: "failed", episodeStatus: "ready" }))).toEqual({
      stalled: false,
      next_action: "read_episode",
      note: "This job failed, but the brief was finished afterwards from the dashboard.",
    });
  });

  it("failed with a draft: resume in the dashboard", () => {
    expect(briefJobOutlook(facts({ status: "failed", episodeStatus: "draft" }))).toMatchObject({
      stalled: false,
      next_action: "resume_in_dashboard",
    });
  });

  it("failed with no episode, or a failed one: start again", () => {
    for (const episodeStatus of [null, "failed"] as const) {
      expect(briefJobOutlook(facts({ status: "failed", episodeStatus }))).toMatchObject({
        stalled: false,
        next_action: "start_again",
      });
    }
  });

  it("a finished job is never stalled, however old its timestamps", () => {
    for (const status of ["done", "failed"] as const) {
      const out = briefJobOutlook(facts({ status, heartbeat_at: secondsAgo(9999), created_at: secondsAgo(9999) }));
      expect(out.stalled, status).toBe(false);
    }
  });

  it.each(["queued", "running"] as const)("%s and not stalled: wait, whoever asks", (status) => {
    for (const canRestart of [false, true]) {
      const out = briefJobOutlook(facts({ status, created_at: secondsAgo(STALE), heartbeat_at: secondsAgo(STALE), canRestart }));
      expect(out).toEqual({ stalled: false, next_action: "wait", note: null });
    }
  });

  describe.each([
    ["running", { status: "running", heartbeat_at: secondsAgo(STALE + 1) }],
    ["queued", { status: "queued", heartbeat_at: null, created_at: secondsAgo(STALE + 1) }],
  ] as const)("%s and stalled", (_name, stalledJob) => {
    it("restarted by this poll: wait", () => {
      expect(briefJobOutlook(facts({ ...stalledJob, canRestart: true, rescheduled: true }))).toEqual({
        stalled: true,
        next_action: "wait",
        note: "This job had stalled; this poll restarted it.",
      });
    });

    it("a caller that may not restart it: use a write token", () => {
      expect(briefJobOutlook(facts({ ...stalledJob, canRestart: false }))).toEqual({
        stalled: true,
        next_action: "use_write_token",
        note: "This job has stalled; restarting it needs a token with write access.",
      });
    });

    it("a caller that may restart it but this poll didn't: wait", () => {
      expect(briefJobOutlook(facts({ ...stalledJob, canRestart: true, rescheduled: false }))).toEqual({
        stalled: true,
        next_action: "wait",
        note: null,
      });
    });
  });

  it("exactly at the stale window is not stalled yet; one millisecond past it is", () => {
    const exactly = new Date(NOW - STALE * 1000).toISOString();
    const past = new Date(NOW - STALE * 1000 - 1).toISOString();
    expect(briefJobOutlook(facts({ heartbeat_at: exactly })).stalled).toBe(false);
    expect(briefJobOutlook(facts({ heartbeat_at: past }))).toMatchObject({ stalled: true, next_action: "use_write_token" });
  });

  it("only ever answers one of the listed next actions", () => {
    const seen = new Set<string>();
    for (const status of BRIEF_JOB_STATES) {
      for (const episodeStatus of [null, "draft", "ready", "failed"] as const) {
        for (const heartbeat of [10, STALE + 1]) {
          for (const canRestart of [false, true]) {
            for (const rescheduled of [false, true]) {
              const out = briefJobOutlook(
                facts({ status, episodeStatus, heartbeat_at: secondsAgo(heartbeat), created_at: secondsAgo(heartbeat), canRestart, rescheduled })
              );
              expect(BRIEF_JOB_NEXT_ACTIONS).toContain(out.next_action);
              if (out.stalled) expect(["queued", "running"]).toContain(status);
              seen.add(out.next_action);
            }
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...BRIEF_JOB_NEXT_ACTIONS].sort());
  });
});
