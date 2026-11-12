import { describe, expect, it } from "vitest";
import {
  BOOKMARK_STAGES,
  BOOKMARK_STAGE_TRANSITIONS,
  MAX_ANALYSIS_ATTEMPTS,
  PIPELINE_CHUNK,
  analysisBatchSize,
  bookmarkStage,
  canMoveBookmarkStage,
  pipelineProgress,
} from "../state/pipeline";

describe("bookmark stage transitions", () => {
  const legal = new Set([
    "synced>ingested",
    "ingested>analysed",
    "ingested>analysis_failed",
    "analysis_failed>ingested",
  ]);

  for (const from of BOOKMARK_STAGES) {
    for (const to of BOOKMARK_STAGES) {
      const expected = legal.has(`${from}>${to}`);
      it(`${from} -> ${to} is ${expected ? "legal" : "illegal"}`, () => {
        expect(canMoveBookmarkStage(from, to)).toBe(expected);
        expect(BOOKMARK_STAGE_TRANSITIONS[from].includes(to)).toBe(expected);
      });
    }
  }

  it("lists the four stages in pipeline order", () => {
    expect(BOOKMARK_STAGES).toEqual(["synced", "ingested", "analysed", "analysis_failed"]);
  });

  it("has a table row for every stage and nothing leaves analysed", () => {
    expect(Object.keys(BOOKMARK_STAGE_TRANSITIONS).sort()).toEqual([...BOOKMARK_STAGES].sort());
    expect(BOOKMARK_STAGE_TRANSITIONS.analysed).toEqual([]);
  });
});

describe("bookmarkStage", () => {
  it("is synced until ingested_at is set", () => {
    expect(bookmarkStage({ ingested_at: null, analysed: false })).toBe("synced");
  });

  it("is ingested once stamped and not yet analysed", () => {
    expect(bookmarkStage({ ingested_at: "2026-01-01T00:00:00Z", analysed: false })).toBe("ingested");
  });

  it("is analysed when the analysis row exists, whatever ingested_at says", () => {
    expect(bookmarkStage({ ingested_at: "2026-01-01T00:00:00Z", analysed: true })).toBe("analysed");
    expect(bookmarkStage({ ingested_at: null, analysed: true })).toBe("analysed");
    expect(bookmarkStage({ ingested_at: "2026-01-01T00:00:00Z", analysed: true, analysis_attempts: 5 })).toBe("analysed");
  });

  it("is synced before ingest whatever the attempt count says", () => {
    expect(bookmarkStage({ ingested_at: null, analysed: false, analysis_attempts: MAX_ANALYSIS_ATTEMPTS })).toBe("synced");
  });

  it("is analysis_failed from MAX_ANALYSIS_ATTEMPTS failed attempts on, and ingested below", () => {
    const ingested_at = "2026-01-01T00:00:00Z";
    expect(MAX_ANALYSIS_ATTEMPTS).toBe(3);
    expect(bookmarkStage({ ingested_at, analysed: false, analysis_attempts: 2 })).toBe("ingested");
    expect(bookmarkStage({ ingested_at, analysed: false, analysis_attempts: 3 })).toBe("analysis_failed");
    expect(bookmarkStage({ ingested_at, analysed: false, analysis_attempts: 4 })).toBe("analysis_failed");
  });

  it("reads a missing or null count as no attempts", () => {
    const ingested_at = "2026-01-01T00:00:00Z";
    expect(bookmarkStage({ ingested_at, analysed: false })).toBe("ingested");
    expect(bookmarkStage({ ingested_at, analysed: false, analysis_attempts: null })).toBe("ingested");
  });
});

describe("analysisBatchSize", () => {
  it("is 20 for a first attempt, 5 for a second, then 1", () => {
    expect([0, 1, 2, 3, 7].map(analysisBatchSize)).toEqual([20, 5, 1, 1, 1]);
  });
});

describe("PIPELINE_CHUNK", () => {
  it("keeps the sizes the enrich route always used, and bounds a chunk to 12 model calls", () => {
    expect(PIPELINE_CHUNK).toEqual({ ingest: 15, enrich: 60, enrichCalls: 12 });
  });
});

describe("pipelineProgress", () => {
  it("reports the larger backlog as remaining", () => {
    expect(pipelineProgress({ ingested: 3, enriched: 1, ingestRemaining: 7, enrichRemaining: 2 })).toEqual({
      remaining: 7,
      stalled: false,
    });
    expect(pipelineProgress({ ingested: 3, enriched: 1, ingestRemaining: 0, enrichRemaining: 9 }).remaining).toBe(9);
  });

  it("is finished, not stalled, when nothing remains", () => {
    expect(pipelineProgress({ ingested: 0, enriched: 0, ingestRemaining: 0, enrichRemaining: 0 })).toEqual({
      remaining: 0,
      stalled: false,
    });
    expect(pipelineProgress({ ingested: 4, enriched: 2, ingestRemaining: 0, enrichRemaining: 0 }).stalled).toBe(false);
  });

  it("is stalled when a chunk moved nothing while work remains", () => {
    expect(pipelineProgress({ ingested: 0, enriched: 0, ingestRemaining: 5, enrichRemaining: 0 })).toEqual({
      remaining: 5,
      stalled: true,
    });
    expect(pipelineProgress({ ingested: 0, enriched: 0, ingestRemaining: 0, enrichRemaining: 3 }).stalled).toBe(true);
  });

  it("is not stalled when either step made progress", () => {
    expect(pipelineProgress({ ingested: 1, enriched: 0, ingestRemaining: 5, enrichRemaining: 0 }).stalled).toBe(false);
    expect(pipelineProgress({ ingested: 0, enriched: 1, ingestRemaining: 0, enrichRemaining: 5 }).stalled).toBe(false);
  });

  it("counts a charged miss as progress, since a post can only be charged so often", () => {
    expect(pipelineProgress({ ingested: 0, enriched: 0, missed: 2, ingestRemaining: 0, enrichRemaining: 5 })).toEqual({
      remaining: 5,
      stalled: false,
    });
  });

  it("treats a missing or zero miss count as no progress", () => {
    expect(pipelineProgress({ ingested: 0, enriched: 0, missed: 0, ingestRemaining: 0, enrichRemaining: 5 }).stalled).toBe(true);
    expect(pipelineProgress({ ingested: 0, enriched: 0, ingestRemaining: 0, enrichRemaining: 5 }).stalled).toBe(true);
  });

  it("is finished, not stalled, when misses emptied the backlog", () => {
    expect(pipelineProgress({ ingested: 0, enriched: 0, missed: 1, ingestRemaining: 0, enrichRemaining: 0 })).toEqual({
      remaining: 0,
      stalled: false,
    });
  });
});
