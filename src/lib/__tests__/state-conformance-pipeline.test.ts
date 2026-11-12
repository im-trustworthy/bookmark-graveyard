import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { expectConformance, MoveLog } from "./conformance";
import type { NotExercised } from "./conformance";

// The bookmark pipeline against its table. syncUser, ingestPending and enrichNewBookmarks run for real
// against the fake database; only X's API, the Grok calls and the voice provider are replaced. After every
// step bookmarkStage reads each stored bookmark (its ingested_at, its analysis_attempts, and whether a
// bookmark_analysis row exists), and every bookmark whose stage changed is held against BOOKMARK_STAGE_TRANSITIONS. A bookmark
// the step created has no earlier stage, so storing it is no move.
const state = vi.hoisted(() => ({ db: null as unknown as FakeDb, fetched: [] as unknown[] }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/x", () => ({
  getAccessToken: vi.fn(async () => "token"),
  fetchAllBookmarks: vi.fn(async () => state.fetched),
}));
vi.mock("@/lib/grok", () => ({
  FAST_MODEL: "fast-model",
  SMART_MODEL: "smart-model",
  grokText: vi.fn(),
  grokJson: vi.fn(),
  grokSearchText: vi.fn(),
}));
vi.mock("@/lib/voice/user", () => ({ getVoiceProviderForUser: vi.fn(async () => null) }));

import { enrichNewBookmarks, resetFailedAnalysis } from "@/lib/brain";
import { grokJson, grokText } from "@/lib/grok";
import { ingestPending } from "@/lib/ingest";
import { syncUser } from "@/lib/sync";
import { BOOKMARK_STAGE_TRANSITIONS, bookmarkStage, canMoveBookmarkStage } from "@/lib/state/pipeline";
import type { BookmarkStage } from "@/lib/state/pipeline";

const tweet = (id: string, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});

const moves = new MoveLog<BookmarkStage>();
let fake: FakeDb;

/** The analysis rows of one bookmark, the way the database's relation shows them to a select. */
function analysisOf(row: Record<string, unknown>) {
  return fake.tables.bookmark_analysis.filter((a) => a.user_id === row.user_id && a.tweet_id === row.tweet_id);
}

/** Every stored bookmark's stage, by tweet id. */
function stages(): Record<string, BookmarkStage> {
  return Object.fromEntries(
    fake.tables.bookmarks.map((row) => [
      row.tweet_id as string,
      bookmarkStage({
        ingested_at: (row.ingested_at as string | null | undefined) ?? null,
        analysed: analysisOf(row).length > 0,
        analysis_attempts: row.analysis_attempts as number | undefined,
      }),
    ])
  );
}

/**
 * Runs one pipeline call and records each move it made to a bookmark that already existed. The fake
 * does not join tables, so each bookmark row exposes its analysis rows the way the real relation does.
 */
async function step<T>(call: () => Promise<T>): Promise<T> {
  for (const row of fake.tables.bookmarks) {
    if (!Object.getOwnPropertyDescriptor(row, "bookmark_analysis")) {
      Object.defineProperty(row, "bookmark_analysis", { enumerable: true, configurable: true, get: () => analysisOf(row) });
    }
  }
  const before = stages();
  const result = await call();
  const after = stages();
  for (const [id, from] of Object.entries(before)) {
    if (after[id] !== from) moves.record(from, after[id]);
  }
  return result;
}
const sync = () => step(() => syncUser("u1"));
const ingest = (limit?: number) => step(() => ingestPending("u1", limit));
const enrich = (limit?: number) => step(() => enrichNewBookmarks("u1", limit));
const retry = () => step(() => resetFailedAnalysis("u1"));

beforeEach(() => {
  vi.clearAllMocks();
  state.fetched = [];
  fake = createFakeDb({ users: [{ id: "u1", x_user_id: "x1" }], bookmarks: [], bookmark_analysis: [], bookmark_sources: [], topics: [], community_notes: [] });
  state.db = fake;
  // The analysis pass answers for every post it was sent.
  vi.mocked(grokJson).mockImplementation((async (_model: string, _system: string, user: string) => ({
    items: (JSON.parse(user) as { tweet_id: string }[]).map((b) => ({
      tweet_id: b.tweet_id,
      topics: ["Tools"],
      summary: "A summary.",
      claims: [],
      content_type: "evergreen",
    })),
  })) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("bookmark stage conformance", () => {
  it("a bookmark goes synced, ingested, analysed, each stage only once the one before is done", async () => {
    state.fetched = [tweet("1"), tweet("2"), tweet("3")];
    await sync();
    expect(stages()).toEqual({ 1: "synced", 2: "synced", 3: "synced" });

    // Analysis waits for ingest: with nothing ingested it has nothing to take, and nothing moves.
    expect(await enrich()).toEqual({ enriched: 0, remaining: 0, missed: 0 });
    expect(stages()).toEqual({ 1: "synced", 2: "synced", 3: "synced" });

    expect(await ingest(2)).toEqual({ ingested: 2, remaining: 1 });
    expect(Object.values(stages()).sort()).toEqual(["ingested", "ingested", "synced"]);

    // Only the two ingested bookmarks are analysed; the third is not skipped ahead.
    expect(await enrich()).toEqual({ enriched: 2, remaining: 0, missed: 0 });
    expect(Object.values(stages()).sort()).toEqual(["analysed", "analysed", "synced"]);

    expect(await ingest()).toEqual({ ingested: 1, remaining: 0 });
    expect(await enrich(1)).toEqual({ enriched: 1, remaining: 0, missed: 0 });
    expect(Object.values(stages())).toEqual(["analysed", "analysed", "analysed"]);
  });

  it("syncing again, or running either pass on finished work, moves nothing back", async () => {
    state.fetched = [tweet("1"), tweet("2")];
    await sync();
    await ingest();
    await enrich();
    const done = stages();
    expect(Object.values(done)).toEqual(["analysed", "analysed"]);

    state.fetched = [tweet("1"), tweet("2"), tweet("3")];
    await sync();
    await ingest();
    await enrich();
    expect(stages()).toEqual({ ...done, 3: "analysed" });
  });

  it("a bookmark whose ingest fails still counts as ingested, so the pipeline moves on", async () => {
    state.fetched = [tweet("1", { media: [{ type: "photo", url: "https://pbs.twimg.com/photo.jpg" }] })];
    await sync();
    vi.mocked(grokText).mockRejectedValue(new Error("vision unavailable"));

    expect(await ingest()).toEqual({ ingested: 1, remaining: 0 });
    expect(fake.tables.bookmark_sources).toEqual([expect.objectContaining({ kind: "image", status: "failed" })]);
    expect(stages()).toEqual({ 1: "ingested" });
  });

  it("a failed analysis batch leaves its bookmarks ingested, ready for the next pass", async () => {
    state.fetched = [tweet("1")];
    await sync();
    await ingest();
    vi.mocked(grokJson).mockRejectedValueOnce(new Error("model unavailable"));

    expect(await enrich()).toEqual({ enriched: 0, remaining: 1, missed: 0 });
    expect(stages()).toEqual({ 1: "ingested" });
    expect(await enrich()).toEqual({ enriched: 1, remaining: 0, missed: 0 });
    expect(stages()).toEqual({ 1: "analysed" });
  });

  it("a post the model keeps leaving out is given up, and an explicit retry puts it back", async () => {
    state.fetched = [tweet("1"), tweet("2")];
    await sync();
    await ingest();
    const answer = vi.mocked(grokJson).getMockImplementation()!;
    // The model never answers for post 2.
    vi.mocked(grokJson).mockImplementation((async (model: string, system: string, user: string) => {
      const sent = (JSON.parse(user) as { tweet_id: string }[]).filter((b) => b.tweet_id !== "2");
      return answer(model, system, JSON.stringify(sent));
    }) as never);

    expect(await enrich()).toEqual({ enriched: 1, remaining: 1, missed: 1 });
    expect(stages()).toEqual({ 1: "analysed", 2: "ingested" });
    await enrich();
    expect(await enrich()).toEqual({ enriched: 0, remaining: 0, missed: 1 });
    expect(stages()).toEqual({ 1: "analysed", 2: "analysis_failed" });

    expect(await retry()).toBe(1);
    expect(stages()).toEqual({ 1: "analysed", 2: "ingested" });
    vi.mocked(grokJson).mockImplementation(answer);
    expect(await enrich()).toEqual({ enriched: 1, remaining: 0, missed: 0 });
    expect(stages()).toEqual({ 1: "analysed", 2: "analysed" });
  });

  it("a bookmark that already has its analysis stays analysed when it is ingested", async () => {
    fake.tables.bookmarks.push({ ...tweet("1"), user_id: "u1", ingested_at: null });
    fake.tables.bookmark_analysis.push({ user_id: "u1", tweet_id: "1" });
    expect(stages()).toEqual({ 1: "analysed" });

    expect(await ingest()).toEqual({ ingested: 1, remaining: 0 });
    expect(stages()).toEqual({ 1: "analysed" });
  });
});

// Entries the fakes cannot produce, each with its reason. None today: every entry of the table is made by
// a real function in the scenarios above.
const NOT_EXERCISED: NotExercised<BookmarkStage>[] = [];

describe("bookmark stage table", () => {
  it("every move the pipeline made is allowed, and every allowed move was made", () => {
    expectConformance({
      transitions: BOOKMARK_STAGE_TRANSITIONS,
      canMove: canMoveBookmarkStage,
      moves: moves.moves,
      notExercised: NOT_EXERCISED,
    });
  });

  it("would catch a skipped stage, and an entry nothing makes", () => {
    const withSkip = [...moves.moves, { from: "synced" as const, to: "analysed" as const }];
    expect(() =>
      expectConformance({ transitions: BOOKMARK_STAGE_TRANSITIONS, canMove: canMoveBookmarkStage, moves: withSkip })
    ).toThrow();
    const withoutAnalysis = moves.moves.filter((m) => m.to !== "analysed");
    expect(() =>
      expectConformance({ transitions: BOOKMARK_STAGE_TRANSITIONS, canMove: canMoveBookmarkStage, moves: withoutAnalysis })
    ).toThrow();
  });
});
