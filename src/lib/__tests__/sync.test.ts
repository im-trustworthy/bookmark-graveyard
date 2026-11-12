import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";

const state = vi.hoisted(() => ({ db: null as unknown as FakeDb, fetched: [] as unknown[], attemptsColumn: true }));

vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/x", () => ({
  getAccessToken: vi.fn(async () => "token"),
  fetchAllBookmarks: vi.fn(async () => state.fetched),
}));
vi.mock("@/lib/analysis-attempts", () => ({ hasAnalysisAttempts: async () => state.attemptsColumn }));

import { syncUser } from "@/lib/sync";

const tweet = (id: string) => ({
  tweet_id: id,
  author_handle: "someone",
  author_name: "Someone",
  text: `text ${id}`,
  tweet_created_at: `2026-01-0${id}T00:00:00Z`,
  public_metrics: null,
  entities: null,
  media: null,
  referenced: [],
  raw: null,
});

beforeEach(() => {
  state.fetched = [];
  state.attemptsColumn = true;
  state.db = createFakeDb({ users: [{ id: "u1", x_user_id: "x1" }], bookmarks: [], bookmark_analysis: [] });
});

describe("syncUser", () => {
  it("stores and counts new bookmarks", async () => {
    state.fetched = [tweet("1"), tweet("2")];
    const result = await syncUser("u1");
    expect(state.db.tables.bookmarks.map((b) => [b.user_id, b.tweet_id])).toEqual([
      ["u1", "1"],
      ["u1", "2"],
    ]);
    expect(result).toMatchObject({ fetched: 2, new: 2, pendingAnalysis: 2 });
    expect(result.newBookmarks).toEqual([
      { tweet_id: "1", tweet_created_at: "2026-01-01T00:00:00Z" },
      { tweet_id: "2", tweet_created_at: "2026-01-02T00:00:00Z" },
    ]);
  });

  it("does not error on, or count, a bookmark that is already stored", async () => {
    state.db.tables.bookmarks.push({ user_id: "u1", tweet_id: "1", text: "kept" });
    state.fetched = [tweet("1"), tweet("2")];
    const result = await syncUser("u1");
    expect(result).toMatchObject({ fetched: 2, new: 1 });
    expect(result.newBookmarks.map((b) => b.tweet_id)).toEqual(["2"]);
    expect(state.db.tables.bookmarks).toHaveLength(2);
    expect(state.db.tables.bookmarks[0].text).toBe("kept");
  });

  it("tolerates a concurrent sync storing the same bookmarks first", async () => {
    // The overlapping sync lands its rows after our read of what is known but before our write.
    const realFrom = state.db.from.bind(state.db);
    let bookmarkReads = 0;
    state.db.from = (table: string) => {
      const query = realFrom(table);
      if (table === "bookmarks" && ++bookmarkReads === 1) {
        state.db.tables.bookmarks.push({ user_id: "u1", tweet_id: "1", text: "from the other sync" });
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) } as never;
      }
      return query;
    };
    state.fetched = [tweet("1")];
    const result = await syncUser("u1");
    expect(result).toMatchObject({ fetched: 1, new: 1 });
    expect(state.db.tables.bookmarks).toHaveLength(1);
    expect(state.db.tables.bookmarks[0].text).toBe("from the other sync");
  });

  it("reports pendingAnalysis as bookmarks minus analysis rows", async () => {
    state.db.tables.bookmarks.push({ user_id: "u1", tweet_id: "1" }, { user_id: "u1", tweet_id: "2" });
    state.db.tables.bookmark_analysis.push({ user_id: "u1", tweet_id: "1" });
    state.fetched = [tweet("1"), tweet("2"), tweet("3")];
    const result = await syncUser("u1");
    expect(result.pendingAnalysis).toBe(2);
  });

  it("leaves the posts the analysis gave up on out of pendingAnalysis", async () => {
    state.db.tables.bookmarks.push(
      { user_id: "u1", tweet_id: "1", analysis_attempts: 3 },
      { user_id: "u1", tweet_id: "2", analysis_attempts: 2 },
      { user_id: "u1", tweet_id: "3", analysis_attempts: 0 },
      { user_id: "u2", tweet_id: "9", analysis_attempts: 3 }
    );
    state.fetched = [tweet("1"), tweet("2"), tweet("3")];
    expect((await syncUser("u1")).pendingAnalysis).toBe(2);
  });

  it("never reports a negative pendingAnalysis", async () => {
    state.db.tables.bookmarks.push({ user_id: "u1", tweet_id: "1", analysis_attempts: 3 });
    state.db.tables.bookmark_analysis.push({ user_id: "u1", tweet_id: "1" });
    state.fetched = [tweet("1")];
    expect((await syncUser("u1")).pendingAnalysis).toBe(0);
  });

  it("subtracts nothing for given-up posts on a database without the column", async () => {
    state.attemptsColumn = false;
    state.db.tables.bookmarks.push({ user_id: "u1", tweet_id: "1", analysis_attempts: 3 });
    const from = vi.spyOn(state.db, "from");
    state.fetched = [tweet("1"), tweet("2")];
    expect((await syncUser("u1")).pendingAnalysis).toBe(2);
    // Only the two counts read bookmarks after the insert; no query names the column.
    expect(from.mock.calls.filter(([table]) => table === "bookmarks")).toHaveLength(3);
  });
});
