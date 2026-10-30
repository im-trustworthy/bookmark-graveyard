import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/bookmarks is the contract the dashboard reads, and src/lib/bookmarks.ts now does its work, so
// this pins the response (rows, topic chips, library, total) and the exact query. The supabase client is
// a recording stub: PostgREST filtering isn't under test, the rows it would return are fixtures.
type Call = [method: string, ...args: unknown[]];
const state = vi.hoisted(() => ({
  userId: "user-1" as string | null,
  rows: [] as unknown[],
  count: 0 as number | null,
  failWith: null as string | null,
  calls: [] as Call[],
}));

vi.mock("@/lib/session", () => ({ getSessionUserId: async () => state.userId }));
vi.mock("@/lib/supabase", () => ({
  db: () => ({
    from(table: string) {
      let head = false;
      const q = {
        select(columns: string, options?: { head?: boolean }) {
          head = options?.head === true;
          state.calls.push(["select", table, columns, options]);
          return q;
        },
        eq(column: string, value: unknown) {
          state.calls.push(["eq", column, value]);
          return q;
        },
        order(column: string, options: unknown) {
          state.calls.push(["order", column, options]);
          return q;
        },
        limit(n: number) {
          state.calls.push(["limit", n]);
          return q;
        },
        then(resolve: (value: unknown) => unknown) {
          if (head) return Promise.resolve({ count: state.count, error: null }).then(resolve);
          const result = state.failWith
            ? { data: null, error: { message: state.failWith } }
            : { data: state.rows, error: null };
          return Promise.resolve(result).then(resolve);
        },
      };
      return q;
    },
  }),
}));

import { GET } from "@/app/api/bookmarks/route";

const analysis = (topics: string[], extra = {}) => ({ topics, summary: null, content_type: "other", credibility: "none", ...extra });
const row = (tweet_id: string, tweet_created_at: string | null, bookmark_analysis: unknown) => ({
  tweet_id,
  author_handle: "ada",
  author_name: "Ada",
  text: `post ${tweet_id}`,
  tweet_created_at,
  first_seen_at: "2026-10-06T00:00:00Z",
  public_metrics: null,
  bookmark_analysis,
});

// Newest first, as the query orders them. "b" carries its analysis as a one-element array, the other shape
// Supabase returns; "d" is undated and not yet analyzed.
const FIXTURE = [
  row("a", "2026-10-05T10:00:00Z", analysis(["ai", "mcp"])),
  row("b", "2026-10-03T10:00:00Z", [analysis(["ai"])]),
  row("c", "2026-09-01T00:00:00Z", analysis(["rust"])),
  row("d", null, null),
];

async function get(query = ""): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await GET(new NextRequest(`http://localhost/api/bookmarks${query}`));
  return { status: res.status, json: await res.json() };
}
const ids = (json: Record<string, unknown>) => (json.bookmarks as { tweet_id: string }[]).map((b) => b.tweet_id);

beforeEach(() => {
  state.userId = "user-1";
  state.rows = FIXTURE;
  state.count = 7;
  state.failWith = null;
  state.calls = [];
  vi.spyOn(console, "error").mockImplementation(() => {}); // apiError logs every rejection
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/bookmarks", () => {
  it("returns every loaded post with the topic chips, the library size and the unfiltered total", async () => {
    const { status, json } = await get();
    expect(status).toBe(200);
    expect(json).toEqual({
      bookmarks: FIXTURE,
      topics: [
        { name: "ai", count: 2 },
        { name: "mcp", count: 1 },
        { name: "rust", count: 1 },
      ],
      library: 4,
      total: 7,
    });
  });

  it("asks for the user's visible bookmarks, newest post first, capped at 1000, and counts the whole library", async () => {
    await get();
    expect(state.calls).toEqual([
      [
        "select",
        "bookmarks",
        "tweet_id, author_handle, author_name, text, tweet_created_at, first_seen_at, public_metrics, bookmark_analysis(topics, summary, content_type, credibility)",
        undefined,
      ],
      ["eq", "user_id", "user-1"],
      ["eq", "hidden", false],
      ["order", "tweet_created_at", { ascending: false, nullsFirst: false }],
      ["limit", 1000],
      ["select", "bookmarks", "tweet_id", { count: "exact", head: true }],
      ["eq", "user_id", "user-1"],
    ]);
  });

  it("filters by the post's date, bounds inclusive to the end of the 'to' day, keeping undated posts", async () => {
    const { json } = await get("?from=2026-10-01&to=2026-10-03");
    expect(ids(json)).toEqual(["b", "d"]);
    expect(json.topics).toEqual([{ name: "ai", count: 1 }]); // chips describe the date-filtered set
    expect(json.library).toBe(4); // library stays the loaded size
  });

  it("applies the topic selection after counting the chips, and drops unanalyzed posts when topics are chosen", async () => {
    const { json } = await get("?topics=mcp");
    expect(ids(json)).toEqual(["a"]);
    expect(json.topics).toEqual([
      { name: "ai", count: 2 },
      { name: "mcp", count: 1 },
      { name: "rust", count: 1 },
    ]);
    expect(ids((await get("?topics=rust,mcp")).json)).toEqual(["a", "c"]);
  });

  it("drops over-long topic names rather than failing the page", async () => {
    expect(ids((await get(`?topics=${"x".repeat(81)}`)).json)).toEqual(["a", "b", "c", "d"]);
    expect(ids((await get(`?topics=${"x".repeat(81)},rust`)).json)).toEqual(["c"]);
  });

  it("reports a total of 0 when the count comes back empty", async () => {
    state.count = null;
    expect((await get()).json.total).toBe(0);
  });

  it("answers 401 without a session, before any query", async () => {
    state.userId = null;
    expect(await get()).toEqual({ status: 401, json: { error: "Not logged in — no session" } });
    expect(state.calls).toEqual([]);
  });

  it.each(["from", "to"])("rejects a malformed %s with a 400 before any query", async (param) => {
    expect(await get(`?${param}=yesterday`)).toEqual({
      status: 400,
      json: { error: `'${param}' must be YYYY-MM-DD — invalid ${param}=yesterday` },
    });
    expect(state.calls).toEqual([]);
  });

  it("is a 500 when the posts can't be loaded, and skips the count", async () => {
    state.failWith = "boom";
    expect(await get()).toEqual({ status: 500, json: { error: "Failed to load bookmarks — boom" } });
    expect(state.calls.filter(([method]) => method === "select")).toHaveLength(1);
  });
});
