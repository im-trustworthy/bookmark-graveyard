import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { withBucketMethods } from "./capacity-fixtures";

// The background brief runner against the fake db. The four digest stages, the X sync and the analysis
// passes are mocked (their own tests cover them), so what is under test is the job: the lease, the stage
// it resumes from, the progress it records, and what a failure leaves behind. `after` from next/server
// only captures its callback, so a test runs a scheduled runner by hand.
const state = vi.hoisted(() => ({ db: null as unknown, afterTasks: [] as (() => unknown)[] }));
vi.mock("next/server", () => ({ after: (task: () => unknown) => void state.afterTasks.push(task) }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/digest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/digest")>()),
  prepareBrief: vi.fn(),
  scriptBrief: vi.fn(),
  renderChunk: vi.fn(),
  finalizeBrief: vi.fn(),
}));
vi.mock("@/lib/brain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/brain")>()),
  selectBookmarksForDigest: vi.fn(),
  enrichNewBookmarks: vi.fn(),
}));
vi.mock("@/lib/sync", () => ({ syncUser: vi.fn() }));
vi.mock("@/lib/ingest", () => ({ ingestPending: vi.fn() }));

import {
  createBriefJob,
  getBriefJobStatus,
  maybeRescheduleBriefJob,
  runBriefJob,
  scheduleBriefJob,
  validateBriefJobInput,
} from "@/lib/jobs";
import type { BriefJobParams } from "@/lib/jobs";
import { DigestStageError, finalizeBrief, prepareBrief, renderChunk, scriptBrief } from "@/lib/digest";
import type { PrepareRequest } from "@/lib/digest";
import { enrichNewBookmarks, selectBookmarksForDigest } from "@/lib/brain";
import type { DigestBookmark } from "@/lib/brain";
import { syncUser } from "@/lib/sync";
import { ingestPending } from "@/lib/ingest";
import { UsageLimitError } from "@/lib/limits";
import { CapacityError } from "@/lib/capacity";
import { InvalidVoiceKeyError, VoiceConfigError, VoiceVendorError } from "@/lib/voice";

type Row = Record<string, unknown>;

const USER = "u1";
const NO_MATCH = "No bookmarks match these filters. Try widening the date range or syncing first.";
const MINUTE = 60_000;

let fake: FakeDb;
/** Rendered chunk file names under each `<base>/chunks` folder, as storage.list() reports them. */
let chunkFiles: Record<string, string[]>;
/** Every paid-call cap the runner spent, by kind, in order. */
let usage: string[];
/** The calls the runner made, in order, for sequencing assertions. */
let calls: string[];

const job = (id = "job-1") => fake.tables.brief_jobs.find((r) => r.id === id)!;
const episode = (id: string) => fake.tables.episodes.find((r) => r.id === id)!;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ speaker: i % 2 ? "B" : "A", line: `Line ${i}.` }));

function jobRow(extra: Row = {}): Row {
  return {
    id: "job-1",
    user_id: USER,
    token_id: null,
    params: { format: "both", targetMinutes: 15, syncFirst: false },
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

function draftEpisode(id: string, extra: Row = {}): Row {
  return {
    id,
    user_id: USER,
    title: `Brief ${id}`,
    format: "both",
    status: "draft",
    script: null,
    markdown_path: `${USER}/${id}/brief.md`,
    audio_path: null,
    ...extra,
  };
}

/** The fake project: tables, a claim_brief_job that behaves like the SQL, record_usage, chunk listings. */
function project({ jobs = [], episodes = [] }: { jobs?: Row[]; episodes?: Row[] } = {}) {
  fake = createFakeDb({ brief_jobs: jobs, episodes });
  fake.functions.claim_brief_job = vi.fn((args: Record<string, unknown>) => {
    const row = fake.tables.brief_jobs.find((r) => r.id === args.p_job_id);
    if (!row) return [];
    const staleBefore = Date.now() - Number(args.p_stale_seconds) * 1000;
    const stale = row.status === "running" && row.heartbeat_at !== null && Date.parse(row.heartbeat_at as string) < staleBefore;
    if (row.status !== "queued" && !stale) return [];
    const now = new Date().toISOString();
    Object.assign(row, { status: "running", heartbeat_at: now, started_at: row.started_at ?? now });
    return [{ ...row }];
  });
  fake.functions.record_usage = vi.fn((args: Record<string, unknown>) => {
    usage.push(args.p_kind as string);
    return true;
  });
  state.db = withBucketMethods(fake, {
    list: async (prefix: string) => ({ data: (chunkFiles[prefix] ?? []).map((name) => ({ name })), error: null }),
  });
}

const someBookmarks = { included: [{ tweet_id: "t1" } as DigestBookmark], excludedAsMisleading: [] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BRIEF_JOB_STALE_SECONDS", undefined);
  vi.stubEnv("APP_URL", "https://graveyard.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.afterTasks = [];
  chunkFiles = {};
  usage = [];
  calls = [];

  vi.mocked(selectBookmarksForDigest).mockImplementation(async () => {
    calls.push("select");
    return someBookmarks;
  });
  // prepare saves the episode (a draft for a podcast, ready for markdown) as the real stage does.
  vi.mocked(prepareBrief).mockImplementation(async (userId: string, params: PrepareRequest) => {
    calls.push(`prepare:${job().stage}`);
    const markdownOnly = params.format === "markdown";
    const row = draftEpisode("ep-new", { user_id: userId, format: params.format, status: markdownOnly ? "ready" : "draft" });
    fake.tables.episodes.push(row);
    return {
      episode: { ...row, markdown_path: row.markdown_path as string, audio_path: null, markdown_url: "x", audio_url: null },
      markdown: "# Brief",
      done: markdownOnly,
      stats: { considered: 1, droppedAsStale: 0, excludedAsMisleading: 0 },
    };
  });
  vi.mocked(scriptBrief).mockImplementation(async (_userId: string, episodeId: string, targetMinutes?: number) => {
    calls.push(`script:${job().stage}:${targetMinutes}`);
    episode(episodeId).script = lines(30);
    return { totalLines: 30 };
  });
  // Each chunk records the progress the job had reported when it started, then lands 12 lines.
  vi.mocked(renderChunk).mockImplementation(async (_userId: string, episodeId: string, cursor: number) => {
    calls.push(`render:${job().stage}:${cursor}:${job().rendered_lines}/${job().total_lines}`);
    const total = (episode(episodeId).script as unknown[]).length;
    const nextCursor = Math.min(cursor + 12, total);
    return { nextCursor, totalLines: total, done: nextCursor >= total };
  });
  vi.mocked(finalizeBrief).mockImplementation(async (_userId: string, episodeId: string) => {
    calls.push(`finalize:${job().stage}:${job().rendered_lines}/${job().total_lines}`);
    const row = episode(episodeId);
    Object.assign(row, { status: "ready", audio_path: `${USER}/${episodeId}/brief.mp3` });
    return { episode: { ...(row as { markdown_path: string; audio_path: string }), markdown_url: "x", audio_url: "y" } };
  });
  vi.mocked(syncUser).mockImplementation(async () => {
    calls.push(`sync:${job().stage}`);
    return { fetched: 3, new: 3, pendingAnalysis: 70, newBookmarks: [] };
  });
  let left = 70;
  vi.mocked(ingestPending).mockImplementation(async (_userId: string, limit?: number) => {
    calls.push(`ingest:${limit}`);
    return { ingested: 15, remaining: 0 };
  });
  vi.mocked(enrichNewBookmarks).mockImplementation(async (_userId: string, limit?: number) => {
    calls.push(`enrich:${limit}`);
    left = Math.max(0, left - 60);
    return { enriched: 60, remaining: left };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("validateBriefJobInput", () => {
  it("takes the prepare fields as the prepare route does, plus sync_first stored as syncFirst", () => {
    expect(validateBriefJobInput({ format: "podcast", from: "2026-10-01", topics: ["AI"], sync_first: true })).toEqual({
      value: {
        format: "both",
        from: "2026-10-01",
        to: undefined,
        topics: ["AI"],
        tweetIds: undefined,
        targetMinutes: undefined,
        syncFirst: true,
      },
    });
    expect(validateBriefJobInput({ format: "markdown", syncFirst: true })).toMatchObject({ value: { syncFirst: true } });
    expect(validateBriefJobInput({ format: "markdown" })).toMatchObject({ value: { format: "markdown", syncFirst: false } });
  });

  it("rejects a sync_first that is not a boolean, and passes the prepare errors through", () => {
    expect(validateBriefJobInput({ sync_first: "yes" })).toEqual({ error: "sync_first must be a boolean" });
    expect(validateBriefJobInput({ syncFirst: 1 })).toEqual({ error: "sync_first must be a boolean" });
    expect(validateBriefJobInput({ from: "last week" })).toEqual({ error: "from must be a YYYY-MM-DD date" });
    expect(validateBriefJobInput(null)).toEqual({ error: "Invalid request body" });
  });
});

describe("createBriefJob", () => {
  const params: BriefJobParams = { format: "both", topics: ["AI"], syncFirst: false };

  it("checks the selection for free, then records a queued job with the token that started it", async () => {
    project();
    const row = await createBriefJob(USER, params, { tokenId: "tok-1" });
    expect(selectBookmarksForDigest).toHaveBeenCalledWith(USER, params);
    expect(row).toMatchObject({ user_id: USER, token_id: "tok-1", params, status: "queued", stage: "queued" });
    expect(fake.tables.brief_jobs).toHaveLength(1);
    expect(usage).toEqual([]);
  });

  it("refuses a filter that matches nothing: no job, no cap spent", async () => {
    project();
    vi.mocked(selectBookmarksForDigest).mockResolvedValue({ included: [], excludedAsMisleading: [] });
    const err = await createBriefJob(USER, params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DigestStageError);
    expect(err).toMatchObject({ status: 400, publicMessage: NO_MATCH });
    expect(fake.tables.brief_jobs).toEqual([]);
    expect(usage).toEqual([]);
  });

  it("skips the check when the job syncs first, since the sync may add posts", async () => {
    project();
    vi.mocked(selectBookmarksForDigest).mockResolvedValue({ included: [], excludedAsMisleading: [] });
    const row = await createBriefJob(USER, { ...params, syncFirst: true });
    expect(selectBookmarksForDigest).not.toHaveBeenCalled();
    expect(row).toMatchObject({ token_id: null, status: "queued" });
  });
});

describe("runBriefJob: the lease", () => {
  it("does nothing when the claim returns no row (another runner holds a fresh lease)", async () => {
    const heartbeat = isoAgo(10_000);
    project({ jobs: [jobRow({ status: "running", stage: "writing", heartbeat_at: heartbeat })] });
    const before = { ...job() };
    await runBriefJob("job-1");
    expect(fake.functions.claim_brief_job).toHaveBeenCalledWith({ p_job_id: "job-1", p_stale_seconds: 90 });
    expect(calls).toEqual([]);
    expect(job()).toEqual(before);
  });

  it("does nothing for a finished job or an unknown id", async () => {
    project({ jobs: [jobRow({ status: "done", stage: "done" })] });
    await runBriefJob("job-1");
    await runBriefJob("job-404");
    expect(calls).toEqual([]);
    expect(job()).toMatchObject({ status: "done" });
  });

  it("claims with the stale window from BRIEF_JOB_STALE_SECONDS", async () => {
    vi.stubEnv("BRIEF_JOB_STALE_SECONDS", "30");
    project({ jobs: [jobRow({ params: { format: "markdown", syncFirst: false } })] });
    await runBriefJob("job-1");
    expect(fake.functions.claim_brief_job).toHaveBeenCalledWith({ p_job_id: "job-1", p_stale_seconds: 30 });
  });

  it("lets only one of two racing runners work", async () => {
    project({ jobs: [jobRow({ params: { format: "markdown", syncFirst: false } })] });
    await Promise.all([runBriefJob("job-1"), runBriefJob("job-1")]);
    expect(prepareBrief).toHaveBeenCalledTimes(1);
    expect(job()).toMatchObject({ status: "done" });
  });

  it("takes over a running job whose heartbeat went stale", async () => {
    project({
      jobs: [jobRow({ status: "running", stage: "rendering", episode_id: "ep-1", heartbeat_at: isoAgo(5 * MINUTE) })],
      episodes: [draftEpisode("ep-1", { script: lines(30) })],
    });
    chunkFiles["u1/ep-1/chunks"] = ["00000.mp3"];
    await runBriefJob("job-1");
    expect(prepareBrief).not.toHaveBeenCalled();
    expect(job()).toMatchObject({ status: "done", stage: "done" });
  });

  it("keeps the lease with a heartbeat while one long call runs, and stops beating when done", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-29T12:00:00.000Z") });
    project({ jobs: [jobRow({ params: { format: "markdown", syncFirst: false } })] });
    const markdownPrepare = vi.mocked(prepareBrief).getMockImplementation()!;
    let release = () => {};
    vi.mocked(prepareBrief).mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return markdownPrepare(...args);
    });

    const run = runBriefJob("job-1");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(job()).toMatchObject({ status: "running", stage: "writing", heartbeat_at: "2026-10-29T12:00:30.000Z" });

    release();
    await run;
    const finished = { ...job() };
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(job()).toEqual(finished);
  });
});

describe("runBriefJob: fresh briefs", () => {
  it("a markdown brief runs prepare only and ends done, with its episode", async () => {
    project({ jobs: [jobRow({ params: { format: "markdown", from: "2026-10-01", syncFirst: false } })] });
    await runBriefJob("job-1");

    expect(calls).toEqual(["select", "prepare:writing"]);
    expect(prepareBrief).toHaveBeenCalledWith(USER, {
      format: "markdown",
      from: "2026-10-01",
      to: undefined,
      topics: undefined,
      tweetIds: undefined,
      targetMinutes: undefined,
    });
    expect(job()).toMatchObject({
      status: "done",
      stage: "done",
      episode_id: "ep-new",
      error: null,
      started_at: expect.any(String),
      finished_at: expect.any(String),
    });
    expect(await getBriefJobStatus(USER, { jobId: "job-1" })).toMatchObject({
      status: "done",
      title: "Brief ep-new",
      links: { markdown: "https://graveyard.example/api/episodes/ep-new/markdown", audio: null },
    });
  });

  it("a podcast runs prepare, the script, every chunk with progress after each, and finalize", async () => {
    project({ jobs: [jobRow()] });
    await runBriefJob("job-1");

    expect(calls).toEqual([
      "select",
      "prepare:writing",
      "script:scripting:15",
      "render:rendering:0:0/30",
      "render:rendering:12:12/30",
      "render:rendering:24:24/30",
      "finalize:publishing:30/30",
    ]);
    expect(job()).toMatchObject({ status: "done", stage: "done", episode_id: "ep-new", rendered_lines: 30, total_lines: 30 });
    expect(await getBriefJobStatus(USER, { jobId: "job-1" })).toEqual({
      job_id: "job-1",
      status: "done",
      stage: "done",
      progress: { rendered_lines: 30, total_lines: 30 },
      episode_id: "ep-new",
      title: "Brief ep-new",
      links: {
        markdown: "https://graveyard.example/api/episodes/ep-new/markdown",
        audio: "https://graveyard.example/api/episodes/ep-new/audio",
      },
      error: null,
      started_at: expect.any(String),
      finished_at: expect.any(String),
    });
  });

  it("fails before any paid call when a sync-first selection comes back empty", async () => {
    project({ jobs: [jobRow({ params: { format: "both", syncFirst: true } })] });
    vi.mocked(syncUser).mockResolvedValue({ fetched: 0, new: 0, pendingAnalysis: 0, newBookmarks: [] });
    vi.mocked(selectBookmarksForDigest).mockResolvedValue({ included: [], excludedAsMisleading: [] });
    await runBriefJob("job-1");
    expect(prepareBrief).not.toHaveBeenCalled();
    expect(job()).toMatchObject({ status: "failed", stage: "failed", error: NO_MATCH });
  });
});

describe("runBriefJob: resuming an existing episode", () => {
  function resumable(episodeExtra: Row, chunks: string[] = []) {
    project({
      jobs: [jobRow({ status: "running", stage: "rendering", episode_id: "ep-1", heartbeat_at: isoAgo(3 * MINUTE) })],
      episodes: [draftEpisode("ep-1", episodeExtra)],
    });
    chunkFiles["u1/ep-1/chunks"] = chunks;
  }

  it("needs_script: writes the script, renders and publishes, without preparing again", async () => {
    resumable({});
    await runBriefJob("job-1");
    expect(calls).toEqual([
      "script:scripting:15",
      "render:rendering:0:0/30",
      "render:rendering:12:12/30",
      "render:rendering:24:24/30",
      "finalize:publishing:30/30",
    ]);
    expect(job()).toMatchObject({ status: "done", episode_id: "ep-1" });
  });

  it("rendering mid-way: re-renders the last landed chunk onward, keeping the script", async () => {
    resumable({ script: lines(30) }, ["00000.mp3", "00012.mp3"]);
    await runBriefJob("job-1");
    expect(calls).toEqual(["render:rendering:12:12/30", "render:rendering:24:24/30", "finalize:publishing:30/30"]);
    expect(job()).toMatchObject({ status: "done", rendered_lines: 30, total_lines: 30 });
  });

  it("needs_finalize: every chunk landed, so it only publishes", async () => {
    resumable({ script: lines(30) }, ["00000.mp3", "00012.mp3", "00024.mp3"]);
    await runBriefJob("job-1");
    expect(calls).toEqual(["finalize:publishing:30/30"]);
    expect(job()).toMatchObject({ status: "done", stage: "done" });
  });

  it("an episode an earlier run already published just marks the job done", async () => {
    resumable({ script: lines(30), status: "ready", audio_path: "u1/ep-1/brief.mp3" });
    await runBriefJob("job-1");
    expect(calls).toEqual([]);
    expect(job()).toMatchObject({ status: "done", stage: "done" });
  });

  it("a job whose draft was discarded fails instead of starting a new brief", async () => {
    project({ jobs: [jobRow({ status: "running", stage: "rendering", episode_id: null, heartbeat_at: isoAgo(3 * MINUTE) })] });
    await runBriefJob("job-1");
    expect(calls).toEqual([]);
    expect(job()).toMatchObject({
      status: "failed",
      stage: "failed",
      error: "This brief's draft was discarded before it finished",
    });
  });
});

describe("runBriefJob: sync first", () => {
  it("syncs and analyzes on the dashboard's caps before preparing", async () => {
    project({ jobs: [jobRow({ params: { format: "markdown", syncFirst: true } })] });
    await runBriefJob("job-1");
    expect(calls).toEqual(["sync:syncing", "ingest:15", "enrich:60", "ingest:15", "enrich:60", "select", "prepare:writing"]);
    expect(usage).toEqual(["sync", "enrich", "enrich"]);
    expect(job()).toMatchObject({ status: "done" });
  });

  it("skips analysis when the sync left nothing to analyze", async () => {
    project({ jobs: [jobRow({ params: { format: "markdown", syncFirst: true } })] });
    vi.mocked(syncUser).mockResolvedValue({ fetched: 0, new: 0, pendingAnalysis: 0, newBookmarks: [] });
    await runBriefJob("job-1");
    expect(calls).toEqual(["select", "prepare:writing"]);
    expect(usage).toEqual(["sync"]);
  });

  it("a run cut off after syncing doesn't sync again when it is taken over", async () => {
    project({
      jobs: [jobRow({ status: "running", stage: "writing", heartbeat_at: isoAgo(3 * MINUTE), params: { format: "markdown", syncFirst: true } })],
    });
    await runBriefJob("job-1");
    expect(syncUser).not.toHaveBeenCalled();
    expect(calls).toEqual(["select", "prepare:writing"]);
  });

  it("a spent sync cap fails the job with the cap's message", async () => {
    project({ jobs: [jobRow({ params: { format: "markdown", syncFirst: true } })] });
    fake.functions.record_usage = vi.fn(() => false);
    await runBriefJob("job-1");
    expect(syncUser).not.toHaveBeenCalled();
    expect(job()).toMatchObject({ status: "failed", error: expect.stringMatching(/^Daily limit reached for sync \(24\/24h\)/) });
  });
});

describe("runBriefJob: failures", () => {
  const cases: [string, () => void, string][] = [
    [
      "a stage refusal shows its public message, not its log detail",
      () => vi.mocked(renderChunk).mockRejectedValue(new DigestStageError(409, "Stale render cursor", "cursor 0 < 12")),
      "Stale render cursor",
    ],
    [
      "a spent cap",
      () => vi.mocked(renderChunk).mockRejectedValue(new UsageLimitError("Daily limit reached for digest render (500/24h).")),
      "Daily limit reached for digest render (500/24h).",
    ],
    [
      "a broken voice setup",
      () => vi.mocked(renderChunk).mockRejectedValue(new VoiceConfigError("Set ELEVENLABS_API_KEY")),
      "Set ELEVENLABS_API_KEY",
    ],
    [
      "a rejected voice key",
      () => vi.mocked(renderChunk).mockRejectedValue(new InvalidVoiceKeyError("elevenlabs", 401, "ElevenLabs rejected the API key (401)")),
      "The voice provider rejected the API key — update it under Voices",
    ],
    [
      "a voice vendor refusing the account",
      () => vi.mocked(renderChunk).mockRejectedValue(new VoiceVendorError("elevenlabs", 403, "quota body")),
      "The voice provider refused the request — check that account's credits and permissions",
    ],
    [
      "full storage",
      () => vi.mocked(finalizeBrief).mockRejectedValue(new CapacityError("Storage is 95% full")),
      "Storage is 95% full",
    ],
    [
      "anything else, whose detail stays in the log",
      () => vi.mocked(renderChunk).mockRejectedValue(new Error("Chunk upload failed: bucket secret-ish detail")),
      "Brief generation failed",
    ],
  ];

  it.each(cases)("%s: marks the job failed and leaves the draft as it was", async (_name, arrange, message) => {
    project({
      jobs: [jobRow({ episode_id: "ep-1" })],
      episodes: [draftEpisode("ep-1", { script: lines(30) })],
    });
    arrange();
    const before = structuredClone(episode("ep-1"));

    await runBriefJob("job-1");

    expect(job()).toMatchObject({ status: "failed", stage: "failed", error: message, finished_at: expect.any(String) });
    expect(episode("ep-1")).toEqual(before);
    expect(console.error).toHaveBeenCalledWith("Brief job job-1 failed:", expect.any(Error));
  });
});

describe("getBriefJobStatus", () => {
  function reported() {
    project({
      jobs: [
        jobRow({ id: "job-old", status: "failed", stage: "failed", episode_id: "ep-1", error: "Stale render cursor", created_at: "2026-10-29T09:00:00.000Z" }),
        jobRow({ id: "job-new", status: "running", stage: "rendering", episode_id: "ep-1", rendered_lines: 12, total_lines: 30, heartbeat_at: isoAgo(5000), started_at: "2026-10-29T10:00:05.000Z", created_at: "2026-10-29T10:00:00.000Z" }),
        jobRow({ id: "job-md", status: "done", stage: "done", episode_id: "ep-md", created_at: "2026-10-28T10:00:00.000Z" }),
        jobRow({ id: "job-pruned", status: "done", stage: "done", episode_id: "ep-pruned", created_at: "2026-10-27T10:00:00.000Z" }),
        jobRow({ id: "job-other", user_id: "u2", episode_id: "ep-2" }),
      ],
      episodes: [
        draftEpisode("ep-1", { script: lines(30) }),
        draftEpisode("ep-md", { format: "markdown", status: "ready" }),
        draftEpisode("ep-pruned", { status: "ready", audio_path: null, audio_pruned_at: "2026-10-28T00:00:00.000Z" }),
        draftEpisode("ep-2", { user_id: "u2" }),
      ],
    });
  }

  it("reports a job by id: progress and title, no links until it is done", async () => {
    reported();
    expect(await getBriefJobStatus(USER, { jobId: "job-new" })).toEqual({
      job_id: "job-new",
      status: "running",
      stage: "rendering",
      progress: { rendered_lines: 12, total_lines: 30 },
      episode_id: "ep-1",
      title: "Brief ep-1",
      links: null,
      error: null,
      started_at: "2026-10-29T10:00:05.000Z",
      finished_at: null,
    });
    expect(await getBriefJobStatus(USER, { jobId: "job-old" })).toMatchObject({ status: "failed", error: "Stale render cursor", links: null });
  });

  it("by episode, reports the newest job that produced it", async () => {
    reported();
    expect(await getBriefJobStatus(USER, { episodeId: "ep-1" })).toMatchObject({ job_id: "job-new" });
  });

  it("links a markdown-only or pruned brief without audio", async () => {
    reported();
    expect((await getBriefJobStatus(USER, { jobId: "job-md" }))?.links).toEqual({
      markdown: "https://graveyard.example/api/episodes/ep-md/markdown",
      audio: null,
    });
    expect((await getBriefJobStatus(USER, { episodeId: "ep-pruned" }))?.links).toEqual({
      markdown: "https://graveyard.example/api/episodes/ep-pruned/markdown",
      audio: null,
    });
  });

  it("is scoped to the user: someone else's job, an unknown id, or no key at all is null", async () => {
    reported();
    expect(await getBriefJobStatus(USER, { jobId: "job-other" })).toBeNull();
    expect(await getBriefJobStatus(USER, { episodeId: "ep-2" })).toBeNull();
    expect(await getBriefJobStatus("u2", { jobId: "job-new" })).toBeNull();
    expect(await getBriefJobStatus(USER, { jobId: "job-404" })).toBeNull();
    expect(await getBriefJobStatus(USER, {})).toBeNull();
    expect(await getBriefJobStatus("u2", { jobId: "job-other" })).toMatchObject({ job_id: "job-other", title: "Brief ep-2" });
  });

  it("a queued job has no episode, title or progress yet", async () => {
    project({ jobs: [jobRow()] });
    expect(await getBriefJobStatus(USER, { jobId: "job-1" })).toMatchObject({
      status: "queued",
      stage: "queued",
      progress: { rendered_lines: 0, total_lines: 0 },
      episode_id: null,
      title: null,
      links: null,
    });
  });
});

describe("scheduling", () => {
  it("scheduleBriefJob runs the job after the response, through after()", async () => {
    project({ jobs: [jobRow({ params: { format: "markdown", syncFirst: false } })] });
    scheduleBriefJob("job-1");
    expect(calls).toEqual([]);
    expect(state.afterTasks).toHaveLength(1);
    await state.afterTasks[0]();
    expect(job()).toMatchObject({ status: "done" });
  });

  it("a runner that crashes is logged, never thrown into after()", async () => {
    project({ jobs: [jobRow()] });
    fake.functions = {}; // claim_brief_job missing: the claim itself errors
    scheduleBriefJob("job-1");
    await expect(state.afterTasks[0]()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("Brief job job-1: runner crashed:", expect.any(Error));
  });

  it.each([
    ["queued", { status: "queued", heartbeat_at: null }, true],
    ["running with a fresh heartbeat", { status: "running", heartbeat_at: isoAgo(30_000) }, false],
    ["running with a stale heartbeat", { status: "running", heartbeat_at: isoAgo(91_000) }, true],
    ["done", { status: "done", heartbeat_at: isoAgo(10 * MINUTE) }, false],
    ["failed", { status: "failed", heartbeat_at: isoAgo(10 * MINUTE) }, false],
  ] as const)("maybeRescheduleBriefJob, %s: %s", (_name, fields, expected) => {
    expect(maybeRescheduleBriefJob({ id: "job-1", ...fields })).toBe(expected);
    expect(state.afterTasks).toHaveLength(expected ? 1 : 0);
  });

  it("maybeRescheduleBriefJob uses the stale window from BRIEF_JOB_STALE_SECONDS", () => {
    vi.stubEnv("BRIEF_JOB_STALE_SECONDS", "300");
    expect(maybeRescheduleBriefJob({ id: "job-1", status: "running", heartbeat_at: isoAgo(2 * MINUTE) })).toBe(false);
    expect(maybeRescheduleBriefJob({ id: "job-1", status: "running", heartbeat_at: isoAgo(6 * MINUTE) })).toBe(true);
  });
});
