import { describe, expect, it } from "vitest";
import {
  analysisOf,
  filterByDateRange,
  filterByTopics,
  matchesQuery,
  topicCounts,
} from "@/lib/bookmarks";
import type { BookmarkAnalysis, BookmarkRow } from "@/lib/bookmarks";

const analysis = (topics: string[], summary: string | null = null): BookmarkAnalysis => ({
  topics,
  summary,
  content_type: "other",
  credibility: "none",
});

function post(tweet_id: string, overrides: Partial<BookmarkRow> = {}): BookmarkRow {
  return {
    tweet_id,
    author_handle: null,
    author_name: null,
    text: "",
    tweet_created_at: "2026-10-05T10:00:00Z",
    first_seen_at: "2026-10-06T00:00:00Z",
    public_metrics: null,
    bookmark_analysis: null,
    ...overrides,
  };
}
const ids = (rows: BookmarkRow[]) => rows.map((r) => r.tweet_id);

describe("analysisOf", () => {
  it("normalizes the object form, the one-element array form, and a missing analysis", () => {
    const a = analysis(["ai"]);
    expect(analysisOf(post("1", { bookmark_analysis: a }))).toBe(a);
    expect(analysisOf(post("2", { bookmark_analysis: [a] }))).toBe(a);
    expect(analysisOf(post("3", { bookmark_analysis: [] }))).toBeNull();
    expect(analysisOf(post("4", { bookmark_analysis: null }))).toBeNull();
  });
});

describe("filterByDateRange", () => {
  const rows = [
    post("before", { tweet_created_at: "2026-09-30T23:59:59Z" }),
    post("first-second", { tweet_created_at: "2026-10-01T00:00:00Z" }),
    post("middle", { tweet_created_at: "2026-10-02T12:00:00Z" }),
    post("last-second", { tweet_created_at: "2026-10-03T23:59:59Z" }),
    post("after", { tweet_created_at: "2026-10-04T00:00:00Z" }),
    post("undated", { tweet_created_at: null }),
  ];

  it("includes both bounds: from starts at midnight, to runs to the end of that day", () => {
    expect(ids(filterByDateRange(rows, "2026-10-01", "2026-10-03"))).toEqual([
      "first-second",
      "middle",
      "last-second",
      "undated",
    ]);
  });

  it("applies either bound on its own", () => {
    expect(ids(filterByDateRange(rows, "2026-10-03", null))).toEqual(["last-second", "after", "undated"]);
    expect(ids(filterByDateRange(rows, undefined, "2026-10-01"))).toEqual(["before", "first-second", "undated"]);
  });

  it("keeps posts with no date even when the range excludes everything else", () => {
    expect(ids(filterByDateRange(rows, "2027-01-01", "2027-01-31"))).toEqual(["undated"]);
  });

  it("returns every row when there are no bounds, without changing the input", () => {
    const before = [...rows];
    expect(filterByDateRange(rows, null, null)).toEqual(rows);
    expect(filterByDateRange(rows)).toEqual(rows);
    expect(rows).toEqual(before);
  });
});

describe("topicCounts", () => {
  it("counts each topic once per post, most posts first, then by name", () => {
    const rows = [
      post("1", { bookmark_analysis: analysis(["rust", "ai"]) }),
      post("2", { bookmark_analysis: [analysis(["ai", "mcp"])] }), // the array form counts too
      post("3", { bookmark_analysis: analysis(["zig", "mcp"]) }),
      post("4", { bookmark_analysis: analysis(["ai"]) }),
      post("5"), // not analyzed yet
    ];
    expect(topicCounts(rows)).toEqual([
      { name: "ai", count: 3 },
      { name: "mcp", count: 2 },
      { name: "rust", count: 1 },
      { name: "zig", count: 1 },
    ]);
  });

  it("is empty when nothing is analyzed", () => {
    expect(topicCounts([])).toEqual([]);
    expect(topicCounts([post("1")])).toEqual([]);
  });
});

describe("filterByTopics", () => {
  const rows = [
    post("ai", { bookmark_analysis: analysis(["ai"]) }),
    post("ai-mcp", { bookmark_analysis: [analysis(["ai", "mcp"])] }),
    post("rust", { bookmark_analysis: analysis(["rust"]) }),
    post("unanalyzed"),
  ];

  it("keeps the posts carrying any selected topic", () => {
    expect(ids(filterByTopics(rows, ["mcp"]))).toEqual(["ai-mcp"]);
    expect(ids(filterByTopics(rows, ["rust", "mcp"]))).toEqual(["ai-mcp", "rust"]);
    expect(ids(filterByTopics(rows, ["nope"]))).toEqual([]);
  });

  it("keeps everything, unanalyzed posts included, when no topic is selected", () => {
    expect(filterByTopics(rows, [])).toEqual(rows);
  });

  it("drops unanalyzed posts as soon as a topic is selected", () => {
    expect(ids(filterByTopics(rows, ["ai", "rust"]))).not.toContain("unanalyzed");
  });
});

describe("matchesQuery", () => {
  const tweet = post("1", {
    text: "Shipping an MCP server for my bookmarks",
    author_handle: "adalovelace",
    author_name: "Ada Lovelace",
    bookmark_analysis: analysis(["mcp"], "A walkthrough of Streamable HTTP transports"),
  });

  it("matches everything for an empty or whitespace-only query", () => {
    expect(matchesQuery(tweet, "")).toBe(true);
    expect(matchesQuery(tweet, "   \t\n")).toBe(true);
    expect(matchesQuery(post("2"), "")).toBe(true);
  });

  it("looks in the post text, the summary, the author handle and the author name", () => {
    expect(matchesQuery(tweet, "bookmarks")).toBe(true); // text
    expect(matchesQuery(tweet, "transports")).toBe(true); // summary
    expect(matchesQuery(tweet, "adalovelace")).toBe(true); // handle
    expect(matchesQuery(tweet, "lovelace")).toBe(true); // name
    expect(matchesQuery(tweet, "rust")).toBe(false);
  });

  it("is case-insensitive in both directions", () => {
    expect(matchesQuery(tweet, "mcp SERVER")).toBe(true);
    expect(matchesQuery(tweet, "ADA")).toBe(true);
    expect(matchesQuery(tweet, "streamable http")).toBe(true);
  });

  it("needs every term, each in any field", () => {
    expect(matchesQuery(tweet, "mcp transports ada")).toBe(true); // text, summary, name
    expect(matchesQuery(tweet, "mcp rust")).toBe(false); // one missing term fails the whole query
    expect(matchesQuery(tweet, "  mcp \n  server  ")).toBe(true); // any run of whitespace separates terms
  });

  it("matches substrings, not whole words, and never across two fields", () => {
    expect(matchesQuery(tweet, "book")).toBe(true);
    // "bookmarksadalovelace" would exist only if the text and the handle were run together
    expect(matchesQuery(post("3", { text: "foo", author_handle: "bar" }), "foobar")).toBe(false);
  });

  it("copes with missing fields without matching the word 'null'", () => {
    const bare = post("4", { text: "hello" });
    expect(matchesQuery(bare, "hello")).toBe(true);
    expect(matchesQuery(bare, "null")).toBe(false);
    expect(matchesQuery(bare, "undefined")).toBe(false);
  });
});
