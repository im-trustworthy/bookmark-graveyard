import { describe, expect, it } from "vitest";
import { runAnalysis, stalledMessage, type Post } from "../state/ui/sync-runner";

type Chunk = { ingested: number; enriched: number; remaining: number; missed?: number };

// A fake POST /api/enrich that answers the given chunks in order and records every call.
function fakeEnrich(chunks: Chunk[]) {
  const calls: { url: string; payload: Record<string, unknown> }[] = [];
  const progress: [number, number][] = [];
  let reloads = 0;
  const post: Post = async (url, payload) => {
    calls.push({ url, payload });
    const next = chunks[calls.length - 1];
    if (!next) throw new Error("unexpected extra call");
    return next;
  };
  return {
    calls,
    progress,
    reloads: () => reloads,
    deps: {
      post,
      onProgress: (done: number, total: number) => progress.push([done, total]),
      onChunk: () => {
        reloads += 1;
      },
    },
  };
}

describe("runAnalysis", () => {
  it("runs a sync's loop to completion, reporting progress and a reload per chunk", async () => {
    const f = fakeEnrich([
      { ingested: 5, enriched: 3, remaining: 4, missed: 0 },
      { ingested: 2, enriched: 4, remaining: 0, missed: 0 },
    ]);
    const out = await runAnalysis(7, f.deps);
    expect(out).toEqual({ analyzed: 7 });
    expect(f.calls.map((c) => c.url)).toEqual(["/api/enrich", "/api/enrich"]);
    expect(f.calls.map((c) => c.payload)).toEqual([{}, {}]);
    expect(f.progress).toEqual([
      [0, 7],
      [3, 7],
      [7, 7],
    ]);
    expect(f.reloads()).toBe(2);
  });

  it("makes no call when a sync has nothing to analyze", async () => {
    const f = fakeEnrich([]);
    expect(await runAnalysis(0, f.deps)).toEqual({ analyzed: 0 });
    expect(f.calls).toEqual([]);
    expect(f.progress).toEqual([]);
    expect(f.reloads()).toBe(0);
  });

  it("a retry sends retryFailed on its first call only", async () => {
    const f = fakeEnrich([
      { ingested: 0, enriched: 1, remaining: 2, missed: 2 },
      { ingested: 0, enriched: 1, remaining: 0, missed: 1 },
    ]);
    const out = await runAnalysis(3, f.deps, { retryFailed: true });
    expect(out).toEqual({ analyzed: 2 });
    expect(f.calls.map((c) => c.payload)).toEqual([{ retryFailed: true }, {}]);
    expect(f.reloads()).toBe(2);
  });

  it("a retry makes its first call even when the count it was given is 0", async () => {
    const f = fakeEnrich([{ ingested: 0, enriched: 0, remaining: 0, missed: 0 }]);
    expect(await runAnalysis(0, f.deps, { retryFailed: true })).toEqual({ analyzed: 0 });
    expect(f.calls.map((c) => c.payload)).toEqual([{ retryFailed: true }]);
  });

  it("keeps going after a chunk that only counted failed attempts", async () => {
    const f = fakeEnrich([
      { ingested: 0, enriched: 0, remaining: 2, missed: 2 },
      { ingested: 0, enriched: 0, remaining: 1, missed: 1 },
      { ingested: 0, enriched: 1, remaining: 0, missed: 0 },
    ]);
    expect(await runAnalysis(2, f.deps)).toEqual({ analyzed: 1 });
    expect(f.calls).toHaveLength(3);
    expect(f.reloads()).toBe(3);
  });

  it("throws the stalled message when a chunk moves nothing while work remains", async () => {
    const f = fakeEnrich([
      { ingested: 1, enriched: 1, remaining: 5, missed: 0 },
      { ingested: 0, enriched: 0, remaining: 5, missed: 0 },
    ]);
    await expect(runAnalysis(6, f.deps)).rejects.toThrow("Analysis stalled with 5 bookmarks left — try again");
    expect(f.calls).toHaveLength(2);
    expect(stalledMessage(5)).toBe("Analysis stalled with 5 bookmarks left — try again");
  });

  it("reads a missing `missed` (an older server) as 0", async () => {
    const f = fakeEnrich([{ ingested: 0, enriched: 0, remaining: 3 }]);
    await expect(runAnalysis(3, f.deps)).rejects.toThrow("Analysis stalled with 3 bookmarks left — try again");

    const ok = fakeEnrich([
      { ingested: 2, enriched: 0, remaining: 1 },
      { ingested: 0, enriched: 1, remaining: 0 },
    ]);
    expect(await runAnalysis(3, ok.deps)).toEqual({ analyzed: 1 });
  });

  it("passes a rejected request through unchanged", async () => {
    const post: Post = async () => {
      throw new Error("Analysis failed");
    };
    await expect(runAnalysis(2, { post, onProgress: () => {}, onChunk: () => {} })).rejects.toThrow(
      "Analysis failed"
    );
  });

  it("keeps progress within 0..total when more work turns up than expected", async () => {
    const f = fakeEnrich([
      { ingested: 0, enriched: 1, remaining: 9, missed: 0 },
      { ingested: 0, enriched: 9, remaining: 0, missed: 0 },
    ]);
    await runAnalysis(2, f.deps, { retryFailed: true });
    expect(f.progress).toEqual([
      [0, 2],
      [0, 2],
      [2, 2],
    ]);
  });
});
