import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";

// The analysis pass (enrichNewBookmarks, resetFailedAnalysis) against the fake database, with the Grok
// calls replaced. Pins how failed attempts are counted: what is charged, how retried posts are batched,
// when a post is given up, and that without the analysis_attempts column nothing of that happens.
const state = vi.hoisted(() => ({ db: null as unknown as FakeDb, column: true }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/analysis-attempts", () => ({ hasAnalysisAttempts: vi.fn(async () => state.column) }));
vi.mock("@/lib/grok", () => ({
  FAST_MODEL: "fast-model",
  SMART_MODEL: "smart-model",
  grokText: vi.fn(),
  grokJson: vi.fn(),
  grokSearchText: vi.fn(),
}));

import { chargesAnalysisAttempt, enrichNewBookmarks, resetFailedAnalysis } from "@/lib/brain";
import { grokJson } from "@/lib/grok";

type Row = Record<string, unknown>;
let fake: FakeDb;
/** The tweet ids of every analysis call, in the order they were made. */
let calls: string[][];
/** Posts the model leaves out of its answer. */
let omitted: Set<string>;

const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

/** Stores ingested, unanalysed posts; the fake does not join, so each row exposes its analysis like the relation. */
function seed(tweetIds: string[], extra: Row = {}) {
  for (const id of tweetIds) {
    const row: Row = {
      user_id: "u1",
      tweet_id: id,
      author_handle: "someone",
      text: `text ${id}`,
      tweet_created_at: null,
      referenced: [],
      ingested_at: "2026-11-01T00:00:00Z",
      ...extra,
    };
    Object.defineProperty(row, "bookmark_analysis", {
      enumerable: true,
      get: () => fake.tables.bookmark_analysis.filter((a) => a.user_id === row.user_id && a.tweet_id === row.tweet_id),
    });
    fake.tables.bookmarks.push(row);
  }
}
const attempts = (id: string) => fake.tables.bookmarks.find((b) => b.tweet_id === id)?.analysis_attempts;
const analysed = () => fake.tables.bookmark_analysis.map((a) => a.tweet_id as string).sort((a, b) => Number(a) - Number(b));
const httpError = (status: number) => Object.assign(new Error(`${status} status code`), { status });

beforeEach(() => {
  vi.clearAllMocks();
  state.column = true;
  calls = [];
  omitted = new Set();
  fake = createFakeDb({ bookmarks: [], bookmark_analysis: [], bookmark_sources: [], topics: [], community_notes: [] });
  state.db = fake;
  vi.mocked(grokJson).mockImplementation((async (_model: string, _system: string, user: string) => {
    const sent = (JSON.parse(user) as { tweet_id: string }[]).map((b) => b.tweet_id);
    calls.push(sent);
    return {
      items: sent
        .filter((id) => !omitted.has(id))
        .map((tweet_id) => ({ tweet_id, topics: ["Tools"], summary: "A summary.", claims: [], content_type: "evergreen" })),
    };
  }) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("chargesAnalysisAttempt", () => {
  it("charges an answer that is not JSON", () => {
    let parseError: unknown;
    try {
      JSON.parse("not json");
    } catch (err) {
      parseError = err;
    }
    expect(chargesAnalysisAttempt(parseError)).toBe(true);
  });

  it.each([400, 413, 422])("charges the provider rejecting the request with HTTP %i", (status) => {
    expect(chargesAnalysisAttempt(httpError(status))).toBe(true);
  });

  it.each([401, 403, 404, 429, 500, 502, 503])("does not charge HTTP %i, the provider's or the configuration's", (status) => {
    expect(chargesAnalysisAttempt(httpError(status))).toBe(false);
  });

  it("does not charge a failure with no response, a timeout, or anything that is not an error", () => {
    expect(chargesAnalysisAttempt(new Error("Connection error."))).toBe(false);
    expect(chargesAnalysisAttempt(Object.assign(new Error("Request timed out."), { status: undefined }))).toBe(false);
    expect(chargesAnalysisAttempt(new TypeError("fetch failed"))).toBe(false);
    expect(chargesAnalysisAttempt("400")).toBe(false);
    expect(chargesAnalysisAttempt(null)).toBe(false);
    expect(chargesAnalysisAttempt({ status: "400" })).toBe(false);
  });
});

describe("enrichNewBookmarks with analysis_attempts", () => {
  it("retries a post the model leaves out in smaller batches, gives up after three, and analyses its neighbours", async () => {
    seed(ids(1, 25));
    omitted.add("7");

    expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 24, remaining: 1, missed: 1 });
    expect(calls.map((c) => c.length)).toEqual([20, 5]);
    expect(analysed()).toEqual(ids(1, 25).filter((id) => id !== "7"));
    expect(attempts("7")).toBe(1);

    // Fresh posts still go 20 at a time; the retried one goes with posts that failed as often (batches of 5).
    seed(ids(26, 35));
    calls = [];
    expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 10, remaining: 1, missed: 1 });
    expect(calls).toEqual([ids(26, 35), ["7"]]);
    expect(attempts("7")).toBe(2);

    // The third miss gives it up: it no longer counts as remaining.
    calls = [];
    expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 0, remaining: 0, missed: 1 });
    expect(calls).toEqual([["7"]]);
    expect(attempts("7")).toBe(3);

    // A given-up post is no longer a candidate, so no more calls are spent on it.
    calls = [];
    expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 0, remaining: 0, missed: 0 });
    expect(calls).toEqual([]);
  });

  it("batches by attempt count: a second try goes five at a time, a third alone", async () => {
    seed(ids(1, 7), { analysis_attempts: 1 });
    seed(ids(8, 9), { analysis_attempts: 2 });
    await enrichNewBookmarks("u1");
    expect(calls).toEqual([ids(1, 5), ids(6, 7), ["8"], ["9"]]);
  });

  it("charges nothing during a provider outage and leaves every post pending", async () => {
    seed(ids(1, 25));
    vi.mocked(grokJson).mockRejectedValue(httpError(503));
    expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 0, remaining: 25, missed: 0 });
    expect(fake.tables.bookmarks.every((b) => b.analysis_attempts === undefined)).toBe(true);

    vi.mocked(grokJson).mockRejectedValue(httpError(429));
    expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 0, remaining: 25, missed: 0 });
    vi.mocked(grokJson).mockRejectedValue(new Error("Connection error."));
    expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 0, remaining: 25, missed: 0 });
    expect(fake.tables.bookmarks.every((b) => b.analysis_attempts === undefined)).toBe(true);
  });

  it("charges every post of a batch whose answer is not JSON, and analyses the other batches", async () => {
    seed(ids(1, 25));
    vi.mocked(grokJson).mockRejectedValueOnce(new SyntaxError("Unexpected token 'o', \"not json\" is not valid JSON"));
    expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 5, remaining: 20, missed: 20 });
    expect(ids(1, 20).map(attempts)).toEqual(Array(20).fill(1));
    expect(analysed()).toEqual(ids(21, 25));

    calls = [];
    expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 20, remaining: 0, missed: 0 });
    expect(calls.map((c) => c.length)).toEqual([5, 5, 5, 5]);
  });

  it("charges a request the provider rejects as malformed or too large", async () => {
    seed(ids(1, 3));
    vi.mocked(grokJson).mockRejectedValueOnce(httpError(413));
    expect(await enrichNewBookmarks("u1")).toEqual({ enriched: 0, remaining: 3, missed: 3 });
    expect(ids(1, 3).map(attempts)).toEqual([1, 1, 1]);
  });

  it("gives up on posts reaching the maximum in this call and leaves them out of remaining", async () => {
    seed(["1", "2"], { analysis_attempts: 2 });
    seed(["3"]);
    vi.mocked(grokJson).mockRejectedValue(new SyntaxError("Unexpected end of JSON input"));
    expect(await enrichNewBookmarks("u1")).toEqual({ enriched: 0, remaining: 1, missed: 3 });
    expect(["1", "2", "3"].map(attempts)).toEqual([3, 3, 1]);
  });

  it("sets an analysed post's count back to 0", async () => {
    seed(["1"], { analysis_attempts: 2 });
    seed(["2"], { analysis_attempts: 1 });
    seed(["3"]);
    expect(await enrichNewBookmarks("u1")).toEqual({ enriched: 3, remaining: 0, missed: 0 });
    expect(["1", "2"].map(attempts)).toEqual([0, 0]);
    expect(attempts("3")).toBeUndefined(); // nothing to reset, so not written
  });

  it("counts `limit` in posts and leaves the rest in remaining", async () => {
    seed(ids(1, 25));
    expect(await enrichNewBookmarks("u1", 10)).toEqual({ enriched: 10, remaining: 15, missed: 0 });
  });

  it("writes the counts in a handful of grouped updates, not one per post", async () => {
    seed(ids(1, 20));
    seed(ids(21, 25), { analysis_attempts: 1 });
    seed(ids(26, 30), { analysis_attempts: 2 });
    for (const id of ids(1, 30)) omitted.add(id);
    const from = vi.spyOn(fake, "from");
    await enrichNewBookmarks("u1");
    const updates = from.mock.results.filter((r) => (r.value as { op?: string }).op === "update");
    expect(updates).toHaveLength(3); // one per new count: 1, 2 and 3
    expect(ids(1, 30).map(attempts)).toEqual([...Array(20).fill(1), ...Array(5).fill(2), ...Array(5).fill(3)]);
  });

  it("throws when the candidate query fails rather than reading it as nothing to do", async () => {
    const realFrom = fake.from.bind(fake);
    state.db = {
      ...fake,
      from: (table: string) => {
        if (table !== "bookmarks") return realFrom(table);
        const failing = {
          select: () => failing,
          eq: () => failing,
          not: () => failing,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: "permission denied" } }).then(resolve),
        };
        return failing as never;
      },
    };
    await expect(enrichNewBookmarks("u1")).rejects.toThrow(/permission denied/);
  });

  it("throws when recording the attempts fails", async () => {
    seed(["1"]);
    omitted.add("1");
    const realFrom = fake.from.bind(fake);
    state.db = {
      ...fake,
      from: (table: string) => {
        const q = realFrom(table);
        if (table !== "bookmarks") return q;
        const failing = {
          eq: () => failing,
          in: () => failing,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: "update refused" } }).then(resolve),
        };
        return Object.assign(q, { update: () => failing });
      },
    };
    await expect(enrichNewBookmarks("u1")).rejects.toThrow(/Recording analysis attempts failed: update refused/);
  });
});

describe("enrichNewBookmarks with a call budget", () => {
  /** The tweet ids of every post the calls carried. */
  const sent = () => calls.flat();

  it("makes at most maxCalls calls, works only on their posts, and leaves the rest in remaining", async () => {
    seed(ids(1, 60), { analysis_attempts: 2 });
    for (const id of ids(1, 6)) omitted.add(id);
    // The tweet ids the sources and Community Notes lookups ask for.
    const looked: Record<string, unknown[]> = {};
    const realFrom = fake.from.bind(fake);
    fake.from = (table: string) => {
      const q = realFrom(table);
      if (table !== "bookmark_sources" && table !== "community_notes") return q;
      const realIn = q.in.bind(q);
      return Object.assign(q, {
        in: (column: string, values: unknown[]) => {
          looked[table] = values;
          return realIn(column, values);
        },
      });
    };

    expect(await enrichNewBookmarks("u1", 60, 12)).toEqual({ enriched: 6, remaining: 48, missed: 6 });
    expect(calls).toEqual(ids(1, 12).map((id) => [id]));
    expect(ids(1, 6).map(attempts)).toEqual(Array(6).fill(3)); // charged, and given up
    expect(analysed()).toEqual(ids(7, 12));
    expect(ids(13, 60).every((id) => attempts(id) === 2)).toBe(true); // not attempted, not charged

    // The sources and Community Notes lookups ask only for the posts that are sent.
    expect(looked).toEqual({ bookmark_sources: ids(1, 12), community_notes: ids(1, 12) });
  });

  it("still sends 60 fresh posts in 3 calls, all of them attempted", async () => {
    seed(ids(1, 60));
    expect(await enrichNewBookmarks("u1", 60, 12)).toEqual({ enriched: 60, remaining: 0, missed: 0 });
    expect(calls.map((c) => c.length)).toEqual([20, 20, 20]);
  });

  it("attempts fresh posts before retries, whatever order the query returns them in", async () => {
    seed(ids(41, 70), { analysis_attempts: 2 });
    seed(ids(1, 40));
    expect(await enrichNewBookmarks("u1", 60, 12)).toEqual({ enriched: 50, remaining: 20, missed: 0 });
    expect(calls.map((c) => c.length)).toEqual([20, 20, ...Array(10).fill(1)]);
    expect(sent().slice(0, 40).sort((a, b) => Number(a) - Number(b))).toEqual(ids(1, 40));
    expect(sent().slice(40)).toEqual(ids(41, 50));
  });

  it("drains a backlog of one-post retries to zero over successive chunks", async () => {
    seed(ids(1, 30), { analysis_attempts: 2 });
    omitted.add("5");
    const chunks: { enriched: number; remaining: number; missed: number }[] = [];
    for (let remaining = 30, guard = 0; remaining > 0 && guard < 10; guard++) {
      calls = [];
      const chunk = await enrichNewBookmarks("u1", 60, 12);
      expect(calls.length).toBeLessThanOrEqual(12);
      chunks.push(chunk);
      remaining = chunk.remaining;
    }
    expect(chunks).toEqual([
      { enriched: 11, remaining: 18, missed: 1 },
      { enriched: 12, remaining: 6, missed: 0 },
      { enriched: 6, remaining: 0, missed: 0 },
    ]);
    expect(analysed()).toEqual(ids(1, 30).filter((id) => id !== "5"));
    expect(attempts("5")).toBe(3);
  });

  it("makes every call with the default budget, as the cron's single pass always did", async () => {
    seed(ids(1, 30), { analysis_attempts: 2 });
    expect(await enrichNewBookmarks("u1")).toEqual({ enriched: 30, remaining: 0, missed: 0 });
    expect(calls).toHaveLength(30);
  });
});

describe("resetFailedAnalysis", () => {
  it("resets every post with a failed attempt on record and makes the given-up ones candidates again", async () => {
    seed(["1", "2"], { analysis_attempts: 3 });
    seed(["3"], { analysis_attempts: 1 });
    seed(["4"]);
    fake.tables.bookmarks.push({ user_id: "u2", tweet_id: "9", ingested_at: "2026-11-01T00:00:00Z", analysis_attempts: 3 });

    expect(await enrichNewBookmarks("u1")).toEqual({ enriched: 2, remaining: 0, missed: 0 });
    expect(analysed()).toEqual(["3", "4"]);

    expect(await resetFailedAnalysis("u1")).toBe(2);
    expect(["1", "2"].map(attempts)).toEqual([0, 0]);
    expect(fake.tables.bookmarks.find((b) => b.user_id === "u2")?.analysis_attempts).toBe(3); // another user's

    calls = [];
    expect(await enrichNewBookmarks("u1")).toEqual({ enriched: 2, remaining: 0, missed: 0 });
    expect(calls).toEqual([["1", "2"]]); // back to a first attempt's batch
  });

  it("does nothing where the column does not exist", async () => {
    state.column = false;
    const from = vi.spyOn(fake, "from");
    expect(await resetFailedAnalysis("u1")).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("enrichNewBookmarks without analysis_attempts", () => {
  beforeEach(() => {
    state.column = false;
  });

  it("does not select, filter on or write the column", async () => {
    // A stale value the code must not read: without the column the database could not hold it.
    seed(ids(1, 25), { analysis_attempts: 3 });
    omitted.add("7");
    const from = vi.spyOn(fake, "from");

    expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 24, remaining: 1, missed: 0 });
    expect(calls.map((c) => c.length)).toEqual([20, 5]);
    expect(from.mock.results.some((r) => (r.value as { op?: string }).op === "update")).toBe(false);
    expect(fake.tables.bookmarks.every((b) => b.analysis_attempts === 3)).toBe(true);

    // The left-out post is retried on every pass, as before, and never given up.
    for (let pass = 0; pass < 4; pass++) {
      expect(await enrichNewBookmarks("u1", 60)).toEqual({ enriched: 0, remaining: 1, missed: 0 });
    }
  });

  it("charges nothing for an answer that is not JSON, leaving the batch pending", async () => {
    seed(ids(1, 3));
    vi.mocked(grokJson).mockRejectedValueOnce(new SyntaxError("Unexpected end of JSON input"));
    expect(await enrichNewBookmarks("u1")).toEqual({ enriched: 0, remaining: 3, missed: 0 });
    expect(await enrichNewBookmarks("u1")).toEqual({ enriched: 3, remaining: 0, missed: 0 });
  });
});
