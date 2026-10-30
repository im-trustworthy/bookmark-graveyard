import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { withBucketMethods } from "./capacity-fixtures";

// The MCP tools against the fake db: each tool's own function, and runTool, the guard every call goes
// through (the mcp_call cap, the write scope, error mapping). createBriefJob and scheduleBriefJob are
// mocked (jobs.test.ts covers them); the rest of jobs.ts is real, with `after` capturing its callback so a
// test can see that a status poll scheduled a runner.
const state = vi.hoisted(() => ({ db: null as unknown, afterTasks: [] as (() => unknown)[] }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void state.afterTasks.push(task),
}));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs")>()),
  createBriefJob: vi.fn(),
  scheduleBriefJob: vi.fn(),
}));

import {
  getBriefStatus,
  getEpisode,
  hideBookmark,
  listEpisodes,
  listTopics,
  MAX_MARKDOWN_CHARS,
  POLL_HINT,
  registerTools,
  runTool,
  searchBookmarks,
  TOOLS,
  toolContextFrom,
} from "@/lib/mcp/tools";
import type { ToolContext } from "@/lib/mcp/tools";
import { createBriefJob, scheduleBriefJob } from "@/lib/jobs";
import { loadBookmarkRows } from "@/lib/bookmarks";
import type { BriefJobRow } from "@/lib/jobs";
import { DigestStageError } from "@/lib/digest";

type Row = Record<string, unknown>;

const USER = "u1";
const OTHER = "u2";
const READER: ToolContext = { userId: USER, tokenId: "token-read", scopes: ["read"] };
const WRITER: ToolContext = { userId: USER, tokenId: "token-write", scopes: ["read", "write"] };
const NO_MATCH = "No bookmarks match these filters. Try widening the date range or syncing first.";

let fake: FakeDb;
/** Markdown files in the episodes bucket, by path. */
let files: Record<string, string>;
/** Every cap record_usage was asked to spend, as "kind:user". */
let usage: string[];
/** What record_usage answers: true until the cap is "hit". */
let underCap: boolean;

function analysis(extra: Row = {}): Row {
  return { topics: ["ai"], summary: null, content_type: "other", credibility: "none", claims: [], ...extra };
}

function bookmark(tweet_id: string, extra: Row = {}): Row {
  return {
    user_id: USER,
    tweet_id,
    author_handle: "someone",
    author_name: "Someone",
    text: `post ${tweet_id}`,
    tweet_created_at: null,
    first_seen_at: "2026-10-20T08:00:00.000Z",
    public_metrics: null,
    hidden: false,
    bookmark_analysis: null,
    ...extra,
  };
}

function episode(id: string, extra: Row = {}): Row {
  return {
    id,
    user_id: USER,
    title: `Brief ${id.slice(0, 4)}`,
    created_at: "2026-10-01T09:00:00.000Z",
    format: "both",
    status: "ready",
    duration_seconds: 900,
    bookmark_count: 12,
    topics: ["ai"],
    date_from: "2026-09-01T00:00:00.000Z",
    date_to: "2026-09-30T23:59:59.000Z",
    markdown_path: `${USER}/${id}/brief.md`,
    audio_path: `${USER}/${id}/brief.mp3`,
    audio_pruned_at: null,
    script: [{ speaker: "A", line: "Hello." }],
    ...extra,
  };
}

function job(id: string, extra: Partial<BriefJobRow> = {}): BriefJobRow {
  return {
    id,
    user_id: USER,
    token_id: "token-write",
    params: { format: "markdown", syncFirst: false },
    status: "queued",
    stage: "queued",
    episode_id: null,
    rendered_lines: 0,
    total_lines: 0,
    error: null,
    heartbeat_at: null,
    started_at: null,
    finished_at: null,
    created_at: "2026-10-29T10:00:00.000Z",
    ...extra,
  };
}

function project(tables: Record<string, object[]> = {}) {
  fake = createFakeDb({ bookmarks: [], episodes: [], brief_jobs: [], ...(tables as Record<string, Row[]>) });
  fake.functions.record_usage = vi.fn((args: Record<string, unknown>) => {
    usage.push(`${args.p_kind}:${args.p_user_id}`);
    return underCap;
  });
  state.db = withBucketMethods(fake, {
    download: async (path: string) =>
      path in files
        ? { data: new Blob([files[path]]), error: null }
        : { data: null, error: { message: `Object not found: ${path}` } },
  });
}

/** The JSON a successful tool call carries, after checking it is also the text content. */
function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }]);
  return result.structuredContent as Record<string, unknown>;
}

/** The message of a tool error. */
function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const [block] = result.content;
  return block.type === "text" ? block.text : "";
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_URL", "https://graveyard.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.afterTasks = [];
  files = {};
  usage = [];
  underCap = true;
  project();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("search_bookmarks", () => {
  beforeEach(() => {
    project({
      bookmarks: [
        bookmark("100", {
          tweet_created_at: "2026-10-05T10:00:00.000Z",
          author_handle: "ada",
          author_name: "Ada Lovelace",
          text: "Shipping an MCP server for my bookmarks",
          bookmark_analysis: analysis({
            topics: ["ai", "mcp"],
            summary: "Notes on MCP transports",
            claims: ["MCP is stateless now"],
            content_type: "news",
          }),
        }),
        bookmark("101", {
          tweet_created_at: "2026-10-07T10:00:00.000Z",
          text: "Vaccines cause everything",
          // Supabase's other shape for the join: a one-element array.
          bookmark_analysis: [analysis({ topics: ["health"], credibility: "misleading" })],
        }),
        bookmark("102", {
          tweet_created_at: "2026-09-01T10:00:00.000Z",
          text: "A contested take on rust",
          bookmark_analysis: analysis({ topics: ["rust"], credibility: "disputed" }),
        }),
        bookmark("103", { text: "undated and not analyzed yet" }),
        bookmark("104", { tweet_created_at: "2026-10-06T00:00:00.000Z", hidden: true, text: "hidden mcp post" }),
        bookmark("105", { user_id: OTHER, tweet_created_at: "2026-10-06T00:00:00.000Z", text: "someone else's mcp" }),
      ],
    });
  });

  it("returns the user's visible posts newest first, with their stored analysis", async () => {
    const out = await searchBookmarks(READER, {});
    expect(out.items.map((i) => i.tweet_id)).toEqual(["101", "100", "102", "103"]);
    expect(out).toMatchObject({ total_matches: 4, returned: 4 });
    expect(out.items[1]).toEqual({
      tweet_id: "100",
      url: "https://x.com/ada/status/100",
      author_handle: "ada",
      author_name: "Ada Lovelace",
      posted_at: "2026-10-05T10:00:00.000Z",
      saved_at: "2026-10-20T08:00:00.000Z",
      text: "Shipping an MCP server for my bookmarks",
      summary: "Notes on MCP transports",
      claims: ["MCP is stateless now"],
      topics: ["ai", "mcp"],
      content_type: "news",
      credibility: "none",
    });
    // Not analyzed yet: empty analysis fields rather than made-up ones.
    expect(out.items[3]).toMatchObject({ summary: null, claims: [], topics: [], content_type: null, credibility: null });
  });

  it("counts every match in total_matches but returns at most `limit`", async () => {
    const out = await searchBookmarks(READER, { limit: 2 });
    expect(out.items.map((i) => i.tweet_id)).toEqual(["101", "100"]);
    expect(out).toMatchObject({ total_matches: 4, returned: 2 });
  });

  it("matches every query term in the text, summary, handle or name", async () => {
    const ids = async (query: string) => (await searchBookmarks(READER, { query })).items.map((i) => i.tweet_id);
    expect(await ids("mcp")).toEqual(["100"]); // the hidden and the other user's MCP posts stay out
    expect(await ids("transports lovelace")).toEqual(["100"]);
    expect(await ids("mcp rust")).toEqual([]);
  });

  it("ignores a leading @ on a term, so a handle can be searched as written on X", async () => {
    const ids = async (query: string) => (await searchBookmarks(READER, { query })).items.map((i) => i.tweet_id);
    expect(await ids("@ada")).toEqual(["100"]);
    expect(await ids("@@ADA mcp")).toEqual(["100"]);
    expect((await searchBookmarks(READER, { query: "@" })).total_matches).toBe(4); // nothing left to match on
  });

  it("keeps only disputed and misleading posts when credibility is flagged", async () => {
    const out = await searchBookmarks(READER, { credibility: "flagged" });
    expect(out.items.map((i) => [i.tweet_id, i.credibility])).toEqual([
      ["101", "misleading"],
      ["102", "disputed"],
    ]);
  });

  it("filters by the post's date (keeping undated posts) and by topic, as the dashboard does", async () => {
    const ids = async (input: Parameters<typeof searchBookmarks>[1]) =>
      (await searchBookmarks(READER, input)).items.map((i) => i.tweet_id);
    expect(await ids({ from: "2026-10-01", to: "2026-10-05" })).toEqual(["100", "103"]);
    expect(await ids({ topics: ["mcp", "rust"] })).toEqual(["100", "102"]);
    expect(await ids({ from: "2026-10-01", topics: ["health"], credibility: "flagged" })).toEqual(["101"]);
  });

  it("cuts long post text to 500 characters ending in an ellipsis, without splitting an emoji", async () => {
    project({
      bookmarks: [
        bookmark("1", { text: "a".repeat(500) }),
        bookmark("2", { text: "b".repeat(501) }),
        bookmark("3", { text: "🙂".repeat(600) }),
      ],
    });
    const byId = Object.fromEntries((await searchBookmarks(READER, {})).items.map((i) => [i.tweet_id, i.text]));
    expect(byId["1"]).toBe("a".repeat(500));
    expect(byId["2"]).toBe(`${"b".repeat(499)}…`);
    expect(Array.from(byId["3"])).toHaveLength(500);
    expect(byId["3"]).toBe(`${"🙂".repeat(499)}…`);
  });

  it("loads claims only when asked, so the dashboard's query stays as it was", async () => {
    const plain = (await loadBookmarkRows(USER)).find((r) => r.tweet_id === "100");
    expect(plain?.bookmark_analysis).not.toHaveProperty("claims");
    const withClaims = (await loadBookmarkRows(USER, { withClaims: true })).find((r) => r.tweet_id === "100");
    expect(withClaims?.bookmark_analysis).toHaveProperty("claims", ["MCP is stateless now"]);
  });

  it("rejects input outside the schema", async () => {
    for (const input of [{ query: "x".repeat(201) }, { limit: 51 }, { from: "10/01/2026" }, { credibility: "bad" }]) {
      expect(errorText(await runTool("search_bookmarks", READER, input))).toMatch(/^Invalid arguments/);
    }
  });
});

describe("list_topics", () => {
  it("counts topic chips over the date range, with library and total as GET /api/bookmarks reports them", async () => {
    project({
      bookmarks: [
        bookmark("1", { tweet_created_at: "2026-10-05T00:00:00Z", bookmark_analysis: analysis({ topics: ["ai", "mcp"] }) }),
        bookmark("2", { tweet_created_at: "2026-10-03T00:00:00Z", bookmark_analysis: [analysis({ topics: ["ai"] })] }),
        bookmark("3", { tweet_created_at: "2026-09-01T00:00:00Z", bookmark_analysis: analysis({ topics: ["rust"] }) }),
        bookmark("4", { bookmark_analysis: null }),
        bookmark("5", { hidden: true, bookmark_analysis: analysis({ topics: ["secret"] }) }),
        bookmark("6", { user_id: OTHER, bookmark_analysis: analysis({ topics: ["theirs"] }) }),
      ],
    });
    expect(await listTopics(READER, {})).toEqual({
      topics: [
        { name: "ai", count: 2 },
        { name: "mcp", count: 1 },
        { name: "rust", count: 1 },
      ],
      library: 4, // visible posts, whatever the range
      total: 5, // every bookmark the user has, hidden included
    });
    expect(await listTopics(READER, { from: "2026-10-04" })).toEqual({
      topics: [
        { name: "ai", count: 1 },
        { name: "mcp", count: 1 },
      ],
      library: 4,
      total: 5,
    });
  });
});

describe("list_episodes", () => {
  it("lists the user's ready briefs newest first, with stable links", async () => {
    const [a, b, c, draft, theirs] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    project({
      episodes: [
        episode(a, { created_at: "2026-10-01T09:00:00.000Z" }),
        episode(b, { created_at: "2026-10-03T09:00:00.000Z", format: "markdown", audio_path: null, duration_seconds: null }),
        episode(c, {
          created_at: "2026-10-02T09:00:00.000Z",
          audio_path: null,
          audio_pruned_at: "2026-10-20T00:00:00.000Z",
        }),
        episode(draft, { created_at: "2026-10-04T09:00:00.000Z", status: "draft" }),
        episode(theirs, { user_id: OTHER, created_at: "2026-10-05T09:00:00.000Z" }),
      ],
    });
    const { episodes } = await listEpisodes(READER, {});
    expect(episodes.map((e) => e.id)).toEqual([b, c, a]);
    expect(episodes[2]).toEqual({
      id: a,
      title: `Brief ${a.slice(0, 4)}`,
      created_at: "2026-10-01T09:00:00.000Z",
      format: "both",
      status: "ready",
      duration_seconds: 900,
      bookmark_count: 12,
      topics: ["ai"],
      date_from: "2026-09-01T00:00:00.000Z",
      date_to: "2026-09-30T23:59:59.000Z",
      links: {
        markdown: `https://graveyard.example/api/episodes/${a}/markdown`,
        audio: `https://graveyard.example/api/episodes/${a}/audio`,
      },
    });
    // Markdown-only, and audio pruned to free space: no audio link either way.
    expect(episodes[0].links).toEqual({ markdown: `https://graveyard.example/api/episodes/${b}/markdown`, audio: null });
    expect(episodes[1].links.audio).toBeNull();
    // No storage paths leak into the output.
    expect(Object.keys(episodes[0])).not.toContain("markdown_path");

    expect((await listEpisodes(READER, { limit: 1 })).episodes.map((e) => e.id)).toEqual([b]);
  });
});

describe("get_episode", () => {
  let id: string;
  beforeEach(() => {
    id = randomUUID();
    project({ episodes: [episode(id)] });
    files[`${USER}/${id}/brief.md`] = "# Your weekly brief\n\nAll about MCP.";
  });

  it("returns the list item plus the brief's markdown by default", async () => {
    const out = await getEpisode(READER, { episode_id: id });
    expect(out).toMatchObject({
      id,
      status: "ready",
      links: { audio: `https://graveyard.example/api/episodes/${id}/audio` },
      markdown: "# Your weekly brief\n\nAll about MCP.",
      truncated: false,
    });
    expect(out).not.toHaveProperty("script");
  });

  it("adds the script when asked and leaves the markdown out when asked", async () => {
    const out = await getEpisode(READER, { episode_id: id, include_markdown: false, include_script: true });
    expect(out.script).toEqual([{ speaker: "A", line: "Hello." }]);
    expect(out).not.toHaveProperty("markdown");
    expect(out).not.toHaveProperty("truncated");
  });

  it("caps the markdown at 60,000 characters and says it did", async () => {
    files[`${USER}/${id}/brief.md`] = "m".repeat(MAX_MARKDOWN_CHARS + 10);
    const out = await getEpisode(READER, { episode_id: id });
    expect(out.markdown).toBe("m".repeat(MAX_MARKDOWN_CHARS));
    expect(out.truncated).toBe(true);

    files[`${USER}/${id}/brief.md`] = "m".repeat(MAX_MARKDOWN_CHARS);
    expect((await getEpisode(READER, { episode_id: id })).truncated).toBe(false);
  });

  it("answers 'Episode not found' for a draft, someone else's brief and an unknown id", async () => {
    const draft = randomUUID();
    const theirs = randomUUID();
    fake.tables.episodes.push(episode(draft, { status: "draft" }), episode(theirs, { user_id: OTHER }));
    for (const episode_id of [draft, theirs, randomUUID()]) {
      expect(errorText(await runTool("get_episode", READER, { episode_id }))).toBe("Episode not found");
    }
  });

  it("rejects an id that isn't a uuid before looking anything up", async () => {
    const from = vi.spyOn(fake, "from");
    expect(errorText(await runTool("get_episode", READER, { episode_id: "1; drop table" }))).toMatch(
      /^Invalid arguments/
    );
    expect(from.mock.calls.map(([table]) => table)).not.toContain("episodes");
  });

  it("answers a generic error when the markdown can't be downloaded, and logs the detail", async () => {
    delete files[`${USER}/${id}/brief.md`];
    expect(errorText(await runTool("get_episode", READER, { episode_id: id }))).toBe(
      "Something went wrong on the server"
    );
    expect(console.error).toHaveBeenCalledWith("MCP get_episode:", expect.any(Error));
  });
});

describe("generate_brief", () => {
  it("creates a job with the translated params, then schedules it", async () => {
    const jobId = randomUUID();
    vi.mocked(createBriefJob).mockResolvedValue(job(jobId));
    const out = structured(
      await runTool("generate_brief", WRITER, {
        format: "podcast",
        from: "2026-10-01",
        to: "2026-10-07",
        topics: ["ai"],
        tweet_ids: ["123", "456"],
        target_minutes: 15,
        sync_first: true,
      })
    );
    expect(createBriefJob).toHaveBeenCalledWith(
      USER,
      {
        format: "both",
        from: "2026-10-01",
        to: "2026-10-07",
        topics: ["ai"],
        tweetIds: ["123", "456"],
        targetMinutes: 15,
        syncFirst: true,
      },
      { tokenId: "token-write" }
    );
    expect(scheduleBriefJob).toHaveBeenCalledWith(jobId);
    expect(vi.mocked(createBriefJob).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(scheduleBriefJob).mock.invocationCallOrder[0]
    );
    expect(out).toEqual({ job_id: jobId, status: "queued", estimated_minutes: 12, poll_hint: POLL_HINT });
  });

  it("defaults a markdown brief to 20 minutes, no sync, and estimates 3 minutes", async () => {
    vi.mocked(createBriefJob).mockResolvedValue(job("job-md"));
    const out = structured(await runTool("generate_brief", WRITER, { format: "markdown" }));
    expect(createBriefJob).toHaveBeenCalledWith(
      USER,
      { format: "markdown", targetMinutes: 20, syncFirst: false },
      { tokenId: "token-write" }
    );
    expect(out).toMatchObject({ job_id: "job-md", estimated_minutes: 3 });
  });

  it("answers the no-match error without scheduling anything", async () => {
    vi.mocked(createBriefJob).mockRejectedValue(new DigestStageError(400, NO_MATCH));
    expect(errorText(await runTool("generate_brief", WRITER, { format: "markdown", topics: ["nothing"] }))).toBe(NO_MATCH);
    expect(scheduleBriefJob).not.toHaveBeenCalled();
  });

  it("rejects bad input before creating a job", async () => {
    for (const input of [
      {},
      { format: "both" },
      { format: "podcast", target_minutes: 31 },
      { format: "podcast", tweet_ids: ["12a"] },
      { format: "podcast", tweet_ids: Array.from({ length: 501 }, (_, i) => String(i)) },
    ]) {
      expect(errorText(await runTool("generate_brief", WRITER, input))).toMatch(/^Invalid arguments/);
    }
    expect(createBriefJob).not.toHaveBeenCalled();
  });
});

describe("get_brief_status", () => {
  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("reports a queued job and schedules a runner for it", async () => {
    const id = randomUUID();
    project({ brief_jobs: [job(id)] });
    const out = structured(await runTool("get_brief_status", READER, { job_id: id }));
    expect(out).toEqual({
      job_id: id,
      status: "queued",
      stage: "queued",
      progress: { rendered_lines: 0, total_lines: 0 },
      episode_id: null,
      title: null,
      links: null,
      error: null,
      started_at: null,
      finished_at: null,
      rescheduled: true,
    });
    expect(state.afterTasks).toHaveLength(1);
  });

  it("leaves a running job with a fresh heartbeat alone, and takes over a stale one", async () => {
    const fresh = randomUUID();
    const stale = randomUUID();
    project({
      brief_jobs: [
        job(fresh, { status: "running", stage: "writing", heartbeat_at: isoAgo(10_000) }),
        job(stale, { status: "running", stage: "rendering", heartbeat_at: isoAgo(10 * 60_000) }),
      ],
    });
    expect(structured(await runTool("get_brief_status", READER, { job_id: fresh }))).toMatchObject({
      stage: "writing",
      rescheduled: false,
    });
    expect(state.afterTasks).toHaveLength(0);
    expect(structured(await runTool("get_brief_status", READER, { job_id: stale }))).toMatchObject({
      rescheduled: true,
    });
    expect(state.afterTasks).toHaveLength(1);
  });

  it("finds the newest job for an episode, with links once it's done", async () => {
    const episodeId = randomUUID();
    const older = randomUUID();
    const newer = randomUUID();
    project({
      episodes: [episode(episodeId, { title: "Your weekly brief" })],
      brief_jobs: [
        job(older, { episode_id: episodeId, status: "failed", stage: "failed", created_at: "2026-10-28T10:00:00.000Z" }),
        job(newer, {
          episode_id: episodeId,
          status: "done",
          stage: "done",
          created_at: "2026-10-29T10:00:00.000Z",
          finished_at: "2026-10-29T10:12:00.000Z",
        }),
      ],
    });
    const out = await getBriefStatus(READER, { episode_id: episodeId });
    expect(out).toMatchObject({
      job_id: newer,
      status: "done",
      title: "Your weekly brief",
      links: {
        markdown: `https://graveyard.example/api/episodes/${episodeId}/markdown`,
        audio: `https://graveyard.example/api/episodes/${episodeId}/audio`,
      },
      rescheduled: false,
    });
  });

  it("hides other people's jobs", async () => {
    const theirs = randomUUID();
    project({ brief_jobs: [job(theirs, { user_id: OTHER })] });
    expect(errorText(await runTool("get_brief_status", READER, { job_id: theirs }))).toBe("No such job");
    expect(errorText(await runTool("get_brief_status", READER, { job_id: randomUUID() }))).toBe("No such job");
    expect(state.afterTasks).toHaveLength(0);
  });

  it("needs exactly one well-formed id, checked before any lookup", async () => {
    const from = vi.spyOn(fake, "from");
    expect(errorText(await runTool("get_brief_status", READER, {}))).toBe("Pass exactly one of job_id or episode_id");
    expect(
      errorText(await runTool("get_brief_status", READER, { job_id: randomUUID(), episode_id: randomUUID() }))
    ).toBe("Pass exactly one of job_id or episode_id");
    expect(errorText(await runTool("get_brief_status", READER, { job_id: "job-1" }))).toMatch(/^Invalid arguments/);
    expect(errorText(await runTool("get_brief_status", READER, { episode_id: "' or 1=1" }))).toMatch(
      /^Invalid arguments/
    );
    expect(from.mock.calls.map(([table]) => table)).not.toContain("brief_jobs");
  });
});

describe("hide_bookmark", () => {
  it("hides the user's own bookmark, and only theirs", async () => {
    project({ bookmarks: [bookmark("42"), bookmark("42", { user_id: OTHER }), bookmark("43")] });
    expect(await hideBookmark(WRITER, { tweet_id: "42" })).toEqual({ ok: true });
    expect(fake.tables.bookmarks.map((b) => [b.user_id, b.tweet_id, b.hidden])).toEqual([
      [USER, "42", true],
      [OTHER, "42", false],
      [USER, "43", false],
    ]);
    // Again, or for a post that isn't there: still ok, nothing else changes.
    expect(structured(await runTool("hide_bookmark", WRITER, { tweet_id: "42" }))).toEqual({ ok: true });
    expect(structured(await runTool("hide_bookmark", WRITER, { tweet_id: "999" }))).toEqual({ ok: true });
    expect(fake.tables.bookmarks.filter((b) => b.hidden)).toHaveLength(1);
  });

  it("rejects a tweet_id that isn't 1 to 30 digits", async () => {
    for (const tweet_id of ["", "12a", "1".repeat(31)]) {
      expect(errorText(await runTool("hide_bookmark", WRITER, { tweet_id }))).toMatch(/^Invalid arguments/);
    }
  });
});

// ---------------------------------------------------------------------------

describe("runTool", () => {
  it("records one mcp_call for the token's user on every call, read or write", async () => {
    vi.mocked(createBriefJob).mockResolvedValue(job("j"));
    await runTool("list_topics", READER, {});
    await runTool("generate_brief", WRITER, { format: "markdown" });
    expect(usage).toEqual([`mcp_call:${USER}`, `mcp_call:${USER}`]);
  });

  it.each([
    ["generate_brief", { format: "markdown" }, "start a brief"],
    ["hide_bookmark", { tweet_id: "42" }, "hide bookmarks"],
  ])("turns a read-only token away from %s with a tool error that says how to fix it", async (name, input, action) => {
    project({ bookmarks: [bookmark("42")] });
    const message = errorText(await runTool(name, READER, input));
    expect(message).toContain(`read-only, so it can't ${action}`);
    expect(message).toContain("Assistants panel");
    expect(createBriefJob).not.toHaveBeenCalled();
    expect(fake.tables.bookmarks[0].hidden).toBe(false);
  });

  it("answers the daily mcp_call cap as a tool error before running anything", async () => {
    underCap = false;
    project({ bookmarks: [bookmark("42")] });
    const from = vi.spyOn(fake, "from");
    const message = errorText(await runTool("search_bookmarks", READER, {}));
    expect(message).toMatch(/^Daily limit reached for mcp call \(1000\/24h\)/);
    expect(from).not.toHaveBeenCalled();
    // The cap comes first, even for a call the scope would refuse.
    expect(errorText(await runTool("hide_bookmark", READER, { tweet_id: "42" }))).toMatch(/^Daily limit reached/);
  });

  it("answers anything unexpected generically and logs the detail", async () => {
    delete fake.functions.record_usage; // the usage check itself fails
    expect(errorText(await runTool("list_topics", READER, {}))).toBe("Something went wrong on the server");
    expect(console.error).toHaveBeenCalledWith("MCP list_topics:", expect.any(Error));
  });
});

describe("registerTools", () => {
  type Registered = { config: Record<string, unknown>; handler: (args: unknown, ctx: unknown) => Promise<CallToolResult> };

  function registered(): Map<string, Registered> {
    const tools = new Map<string, Registered>();
    const server = {
      registerTool: (name: string, config: Record<string, unknown>, handler: Registered["handler"]) => {
        tools.set(name, { config, handler });
      },
    };
    registerTools(server as never);
    return tools;
  }

  it("registers the seven tools with descriptions, schemas and honest annotations", () => {
    const tools = registered();
    expect([...tools.keys()]).toEqual([
      "search_bookmarks",
      "list_topics",
      "list_episodes",
      "get_episode",
      "generate_brief",
      "get_brief_status",
      "hide_bookmark",
    ]);
    for (const [name, { config }] of tools) {
      const write = name === "generate_brief" || name === "hide_bookmark";
      expect(config.annotations, name).toMatchObject({ readOnlyHint: !write, destructiveHint: false });
      expect(config.inputSchema, name).toBe(TOOLS.find((t) => t.name === name)?.inputSchema);
      expect(String(config.description), name).toMatch(write ? /write access/ : /Free/);
    }
    expect(tools.get("hide_bookmark")?.config.annotations).toMatchObject({ idempotentHint: true });
    expect(tools.get("generate_brief")?.config.annotations).toMatchObject({ idempotentHint: false });
    expect(String(tools.get("generate_brief")?.config.description)).toMatch(/costs money/);
    expect(String(tools.get("search_bookmarks")?.config.description)).toMatch(/not instructions/);
    expect(String(tools.get("search_bookmarks")?.config.description)).toMatch(/X does not expose/);
  });

  it("runs a tool as the user in ctx.http.authInfo, with the token's scopes", async () => {
    project({ bookmarks: [bookmark("42")] });
    const { handler } = registered().get("hide_bookmark")!;
    const authInfo = (scopes: string[]) => ({
      token: "bg_not-a-real-token",
      clientId: "token-1",
      scopes,
      extra: { userId: USER, tokenId: "token-1" },
    });
    expect(errorText(await handler({ tweet_id: "42" }, { http: { authInfo: authInfo(["read"]) } }))).toMatch(
      /read-only/
    );
    expect(structured(await handler({ tweet_id: "42" }, { http: { authInfo: authInfo(["read", "write"]) } }))).toEqual({
      ok: true,
    });
    expect(fake.tables.bookmarks[0].hidden).toBe(true);
    expect(errorText(await handler({ tweet_id: "42" }, {}))).toMatch(/^Not authenticated/);
  });

  it("reads the caller from auth info, dropping scopes it doesn't know", () => {
    expect(
      toolContextFrom({
        http: { authInfo: { token: "t", clientId: "c", scopes: ["read", "admin"], extra: { userId: "u", tokenId: "c" } } },
      })
    ).toEqual({ userId: "u", tokenId: "c", scopes: ["read"] });
    expect(toolContextFrom({ http: { authInfo: { token: "t", clientId: "c", scopes: ["read"] } } })).toBeNull();
    expect(toolContextFrom({})).toBeNull();
  });
});
