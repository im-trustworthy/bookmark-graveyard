import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { withBucketMethods } from "./capacity-fixtures";
import { expectConformance, MoveLog } from "./conformance";
import type { NotExercised } from "./conformance";

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
  TOKEN_REVOKED_MESSAGE,
  UNEXPECTED_STAGE_MOVE,
  USER_NOT_ALLOWED_MESSAGE,
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
import {
  BRIEF_JOB_STAGE_TRANSITIONS,
  BRIEF_JOB_STATE_TRANSITIONS,
  canMoveBriefJobStage,
  canMoveBriefJobState,
} from "@/lib/state/brief-job";
import type { BriefJobStage, BriefJobState } from "@/lib/state/brief-job";

type Row = Record<string, unknown>;

const USER = "u1";
const NO_MATCH = "No bookmarks match these filters. Try widening the date range or syncing first.";
const MINUTE = 60_000;

/** Every stage write the runner made to any job row in this file, with the stage it replaced. */
const stageMoves = new MoveLog<BriefJobStage>();

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
    // A job that carries an episode is past `writing`: the episode is recorded only once that stage is set.
    stage: extra.episode_id ? "writing" : "queued",
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

/**
 * The fake project: tables (the job's user is allowed, its token live), a claim_brief_job that behaves
 * like the SQL (a fresh lease_id on every claim), record_usage, chunk listings.
 */
function project({
  jobs = [],
  episodes = [],
  users = [{ id: USER, is_allowed: true }],
  tokens = [{ id: "tok-1", user_id: USER, revoked_at: null, expires_at: null }],
}: { jobs?: Row[]; episodes?: Row[]; users?: Row[]; tokens?: Row[] } = {}) {
  fake = createFakeDb({ brief_jobs: jobs, episodes, users, api_tokens: tokens });
  // Watch every stage write on the job rows, so the whole file feeds the stage conformance check at the end.
  for (const row of fake.tables.brief_jobs) {
    let stage = row.stage as BriefJobStage;
    Object.defineProperty(row, "stage", {
      enumerable: true,
      configurable: true,
      get: () => stage,
      set: (to: BriefJobStage) => {
        stageMoves.record(stage, to);
        stage = to;
      },
    });
  }
  fake.functions.claim_brief_job = vi.fn((args: Record<string, unknown>) => {
    const row = fake.tables.brief_jobs.find((r) => r.id === args.p_job_id);
    if (!row) return [];
    const staleBefore = Date.now() - Number(args.p_stale_seconds) * 1000;
    const stale = row.status === "running" && row.heartbeat_at !== null && Date.parse(row.heartbeat_at as string) < staleBefore;
    if (row.status !== "queued" && !stale) return [];
    const now = new Date().toISOString();
    Object.assign(row, { status: "running", heartbeat_at: now, started_at: row.started_at ?? now, lease_id: randomUUID() });
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
    return { enriched: 60, remaining: left, missed: 0 };
  });
});
afterEach(() => {
  // Every flow in this file is a move the runner really makes, so none may fall outside
  // BRIEF_JOB_STAGE_TRANSITIONS: this is what proves the table complete. A test that provokes one on
  // purpose clears the spy after checking it.
  const unexpected = vi
    .mocked(console.error)
    .mock.calls.filter(([line]) => typeof line === "string" && line.includes(UNEXPECTED_STAGE_MOVE));
  expect(unexpected).toEqual([]);
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
      stage_label: "Finished",
      stalled: false,
      next_action: "read_episode",
      note: null,
      episode_status: "ready",
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
      jobs: [jobRow({ status: "running", stage: "writing", episode_id: "ep-1", heartbeat_at: isoAgo(3 * MINUTE) })],
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

  it("an episode no stage will act on (a failed row) fails the job without calling any stage", async () => {
    resumable({ script: lines(30), status: "failed" }, ["00000.mp3"]);
    await runBriefJob("job-1");
    expect(calls).toEqual([]);
    expect(finalizeBrief).not.toHaveBeenCalled();
    expect(job()).toMatchObject({ status: "failed", stage: "failed", error: "This brief's draft can no longer be finished" });
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

// Revoking a token in the Assistants panel, or taking a user off the allowlist, must stop the briefs they
// already started, not just new ones: the runner checks before every step that costs money.
describe("runBriefJob: a revoked token or a disallowed user stops the job", () => {
  const revokeToken = () => void (fake.tables.api_tokens[0].revoked_at = new Date().toISOString());
  const disallowUser = () => void (fake.tables.users[0].is_allowed = false);

  /** Has `lose` happen as the paid call of the given stage finishes (on its `nth` call). */
  function loseDuring(stage: "prepare" | "script" | "render", lose: () => void, nth = 1) {
    let n = 0;
    const once = () => ++n === nth && lose();
    if (stage === "prepare") {
      const real = vi.mocked(prepareBrief).getMockImplementation()!;
      vi.mocked(prepareBrief).mockImplementation(async (...args) => {
        const out = await real(...args);
        once();
        return out;
      });
    } else if (stage === "script") {
      const real = vi.mocked(scriptBrief).getMockImplementation()!;
      vi.mocked(scriptBrief).mockImplementation(async (...args) => {
        const out = await real(...args);
        once();
        return out;
      });
    } else {
      const real = vi.mocked(renderChunk).getMockImplementation()!;
      vi.mocked(renderChunk).mockImplementation(async (...args) => {
        const out = await real(...args);
        once();
        return out;
      });
    }
  }

  const podcast = (extra: Row = {}) => project({ jobs: [jobRow({ token_id: "tok-1", ...extra })] });

  it("checks right after the claim: a token revoked before the run starts spends nothing, not even the sync", async () => {
    podcast({ params: { format: "both", targetMinutes: 15, syncFirst: true } });
    revokeToken();
    await runBriefJob("job-1");
    expect(calls).toEqual([]);
    expect(usage).toEqual([]);
    expect(job()).toMatchObject({ status: "failed", stage: "failed", error: TOKEN_REVOKED_MESSAGE });
  });

  it.each([
    ["the script", "prepare", 1, ["select", "prepare:writing"]],
    ["the render loop", "script", 1, ["select", "prepare:writing", "script:scripting:15"]],
    [
      "the next chunk",
      "render",
      1,
      ["select", "prepare:writing", "script:scripting:15", "render:rendering:0:0/30"],
    ],
    [
      "publishing",
      "render",
      3,
      [
        "select",
        "prepare:writing",
        "script:scripting:15",
        "render:rendering:0:0/30",
        "render:rendering:12:12/30",
        "render:rendering:24:24/30",
      ],
    ],
  ] as const)("a token revoked mid-run stops the job before %s", async (_label, stage, nth, expected) => {
    podcast();
    loseDuring(stage, revokeToken, nth);
    await runBriefJob("job-1");
    expect(calls).toEqual(expected);
    expect(finalizeBrief).not.toHaveBeenCalled();
    expect(job()).toMatchObject({
      status: "failed",
      stage: "failed",
      error: TOKEN_REVOKED_MESSAGE,
      episode_id: "ep-new",
      finished_at: expect.any(String),
    });
    // The draft stays as it was, resumable from the dashboard.
    expect(episode("ep-new").status).toBe("draft");
  });

  it("an expired token, or one whose row is gone, stops it the same way", async () => {
    podcast();
    fake.tables.api_tokens[0].expires_at = new Date(Date.now() - 1000).toISOString();
    await runBriefJob("job-1");
    expect(calls).toEqual([]);
    expect(job()).toMatchObject({ status: "failed", error: TOKEN_REVOKED_MESSAGE });

    podcast({ token_id: "tok-gone" });
    await runBriefJob("job-1");
    expect(calls).toEqual([]);
    expect(job()).toMatchObject({ status: "failed", error: TOKEN_REVOKED_MESSAGE });
  });

  it("a user taken off the allowlist mid-run is stopped too, with or without a token", async () => {
    podcast();
    loseDuring("script", disallowUser);
    await runBriefJob("job-1");
    expect(renderChunk).not.toHaveBeenCalled();
    expect(job()).toMatchObject({ status: "failed", error: USER_NOT_ALLOWED_MESSAGE });

    project({ jobs: [jobRow({ token_id: null })], users: [{ id: USER, is_allowed: false }] });
    calls = [];
    await runBriefJob("job-1");
    expect(calls).toEqual([]);
    expect(job()).toMatchObject({ status: "failed", error: USER_NOT_ALLOWED_MESSAGE });
  });

  it("a live token and an allowed user run the job to the end", async () => {
    podcast({ params: { format: "markdown", syncFirst: true } });
    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "done", error: null });
  });
});

// A runner that was only slow (not dead) can be taken over when its heartbeat looks stale. Its writes are
// fenced on the lease it claimed, so once another runner holds the job it stops at its next write and
// overwrites nothing.
describe("runBriefJob: the fenced lease", () => {
  it("a runner whose lease was taken over stops at its next write; the new lease holder's writes win", async () => {
    project({ jobs: [jobRow({ token_id: "tok-1" })] });
    const errorSpy = vi.mocked(console.error);
    const realPrepare = vi.mocked(prepareBrief).getMockImplementation()!;
    let firstLease: unknown;
    vi.mocked(prepareBrief).mockImplementationOnce(async (...args) => {
      // Runner A is mid-way through the writing pass when its heartbeat goes stale and runner B claims the
      // job and finishes it.
      firstLease = job().lease_id;
      job().heartbeat_at = new Date(Date.now() - 5 * MINUTE).toISOString();
      await runBriefJob("job-1");
      expect(job()).toMatchObject({ status: "done", stage: "done", episode_id: "ep-new" });
      // A's own writing pass then lands, as a second episode.
      const out = await realPrepare(...args);
      return { ...out, episode: { ...out.episode, id: "ep-a" } as typeof out.episode };
    });

    await runBriefJob("job-1"); // runner A
    expect(job().lease_id).not.toBe(firstLease);
    // B's outcome stands: A didn't record its episode, didn't script or render, and didn't mark anything.
    expect(job()).toMatchObject({ status: "done", stage: "done", episode_id: "ep-new", rendered_lines: 30, error: null });
    expect(calls.filter((c) => c.startsWith("prepare"))).toHaveLength(2);
    expect(scriptBrief).toHaveBeenCalledTimes(1);
    expect(finalizeBrief).toHaveBeenCalledTimes(1);
    // One line for the stop, none for a failure.
    expect(errorSpy).toHaveBeenCalledWith("Brief job job-1: another runner took the job over; this one stopped");
    expect(errorSpy).not.toHaveBeenCalledWith("Brief job job-1 failed:", expect.anything());
  });

  it("a runner that fails after losing its lease doesn't record the failure over the new holder's job", async () => {
    project({ jobs: [jobRow({ episode_id: "ep-1" })], episodes: [draftEpisode("ep-1", { script: lines(30) })] });
    vi.mocked(renderChunk).mockImplementationOnce(async () => {
      job().lease_id = "lease-of-runner-b"; // taken over while this chunk rendered
      job().stage = "rendering";
      throw new Error("Chunk upload failed");
    });
    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "running", stage: "rendering", lease_id: "lease-of-runner-b", error: null });
    expect(console.error).toHaveBeenCalledWith("Brief job job-1: another runner took the job over; this one stopped");
  });

  it("the outcome write is fenced too: a runner taken over during finalize doesn't mark the job done", async () => {
    project({ jobs: [jobRow({ episode_id: "ep-1" })], episodes: [draftEpisode("ep-1", { script: lines(30) })] });
    chunkFiles["u1/ep-1/chunks"] = ["00000.mp3", "00012.mp3", "00024.mp3"];
    const realFinalize = vi.mocked(finalizeBrief).getMockImplementation()!;
    vi.mocked(finalizeBrief).mockImplementationOnce(async (...args) => {
      const out = await realFinalize(...args);
      job().lease_id = "lease-of-runner-b";
      return out;
    });
    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "running", stage: "publishing", finished_at: null });
  });

  it("the heartbeat is fenced: it never beats over the new holder's lease, and stops", async () => {
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
    expect(job().heartbeat_at).toBe("2026-10-29T12:00:30.000Z");
    // Runner B takes over and beats on its own schedule.
    Object.assign(job(), { lease_id: "lease-of-runner-b", heartbeat_at: "2026-10-29T12:00:31.000Z" });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(job().heartbeat_at).toBe("2026-10-29T12:00:31.000Z");

    release();
    await run;
    expect(job()).toMatchObject({ status: "running", episode_id: null, lease_id: "lease-of-runner-b" });
  });

  it("refuses to run on a claim that hands out no lease (the migration isn't applied)", async () => {
    project({ jobs: [jobRow()] });
    fake.functions.claim_brief_job = vi.fn(() => [{ ...job(), status: "running" }]);
    await expect(runBriefJob("job-1")).rejects.toThrow(/no lease_id/);
    expect(calls).toEqual([]);
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
      stage_label: "Recording audio",
      stalled: false,
      next_action: "wait",
      note: null,
      episode_status: "draft",
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

// The stage table in src/lib/state/brief-job.ts is checked, not enforced: a move it doesn't list is
// logged once and the run carries on. The afterEach above proves every other flow here stays inside it.
describe("runBriefJob: the stage table", () => {
  it("logs a move the table doesn't list, and still finishes the job", async () => {
    // A job stored at `selecting` never carries an episode in practice, so its resume jump is unlisted.
    project({
      jobs: [jobRow({ status: "running", stage: "selecting", episode_id: "ep-1", heartbeat_at: isoAgo(3 * MINUTE) })],
      episodes: [draftEpisode("ep-1")],
    });
    const recorded = stageMoves.moves.length;
    await runBriefJob("job-1");
    // This move is unlisted on purpose, to prove the check fires: it stays out of the conformance record.
    stageMoves.moves.splice(recorded);
    expect(job()).toMatchObject({ status: "done", stage: "done" });
    const logged = vi
      .mocked(console.error)
      .mock.calls.filter(([line]) => typeof line === "string" && line.includes(UNEXPECTED_STAGE_MOVE));
    expect(logged).toEqual([[`Brief job job-1: ${UNEXPECTED_STAGE_MOVE} selecting -> scripting`]]);
    vi.mocked(console.error).mockClear();
  });

  it("a done write that fails records the failure from the stage the run really reached", async () => {
    project({ jobs: [jobRow({ params: { format: "markdown", syncFirst: false } })] });
    // The write that would record done fails as a dropped connection would; every other write lands.
    const client = state.db as { from: (t: string) => unknown };
    const realFrom = client.from.bind(client);
    const failed: unknown = new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "then"
            ? (resolve: (r: unknown) => unknown) => resolve({ data: null, error: { message: "connection reset" } })
            : () => failed,
      }
    );
    vi.spyOn(client, "from").mockImplementation(((t: string) => {
      const query = realFrom(t) as { update: (patch: Row) => unknown };
      if (t !== "brief_jobs") return query;
      const realUpdate = query.update.bind(query);
      query.update = (patch: Row) => (patch.status === "done" ? failed : realUpdate(patch));
      return query;
    }) as never);

    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "failed", stage: "failed", error: "Brief generation failed" });
    expect(console.error).toHaveBeenCalledWith(
      "Brief job job-1 failed:",
      expect.objectContaining({ message: "Job update failed: connection reset" })
    );
    // The afterEach checks that no unexpected stage move (done -> failed) was logged.
  });
});

// The user can discard a draft from the dashboard while the job works on it. The stage functions then
// answer 404 in their own words; the job records the runner's message instead.
describe("runBriefJob: a draft discarded mid-run", () => {
  const DISCARDED = "This brief's draft was discarded before it finished";

  it.each([
    ["the script", () => vi.mocked(scriptBrief).mockRejectedValue(new DigestStageError(404, "Episode not found")), {}, []],
    [
      "the render loop",
      () => vi.mocked(renderChunk).mockRejectedValue(new DigestStageError(404, "Episode has no script")),
      { script: lines(30) },
      [],
    ],
    [
      "publishing",
      () => vi.mocked(finalizeBrief).mockRejectedValue(new DigestStageError(404, "Episode not found")),
      { script: lines(30) },
      ["00000.mp3", "00012.mp3", "00024.mp3"],
    ],
  ] as const)("during %s, records the discard message", async (_label, arrange, episodeExtra, chunks) => {
    project({ jobs: [jobRow({ episode_id: "ep-1" })], episodes: [draftEpisode("ep-1", { ...episodeExtra })] });
    chunkFiles["u1/ep-1/chunks"] = [...chunks];
    arrange();
    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "failed", stage: "failed", error: DISCARDED });
  });

  it("leaves a stage's other refusals as they were", async () => {
    project({ jobs: [jobRow({ episode_id: "ep-1" })], episodes: [draftEpisode("ep-1", { script: lines(30) })] });
    vi.mocked(renderChunk).mockRejectedValue(new DigestStageError(409, "Stale render cursor"));
    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "failed", error: "Stale render cursor" });
  });
});

describe("runBriefJob: the access check's database errors", () => {
  /** Makes every read of `table` answer a database error. */
  function failReads(table: string) {
    const client = state.db as { from: (t: string) => unknown };
    const realFrom = client.from.bind(client);
    const failing = {
      select: () => failing,
      eq: () => failing,
      maybeSingle: async () => ({ data: null, error: { message: "connection reset" } }),
    };
    vi.spyOn(client, "from").mockImplementation(((t: string) => (t === table ? failing : realFrom(t))) as never);
  }

  it.each([
    ["api_tokens", "Token lookup failed: connection reset"],
    ["users", "User lookup failed: connection reset"],
  ])("a failed %s lookup fails the job generically and logs the detail", async (table, detail) => {
    project({ jobs: [jobRow({ token_id: "tok-1" })] });
    failReads(table);
    await runBriefJob("job-1");
    expect(calls).toEqual([]);
    expect(job()).toMatchObject({ status: "failed", error: "Brief generation failed" });
    expect(console.error).toHaveBeenCalledWith("Brief job job-1 failed:", expect.objectContaining({ message: detail }));
  });
});

describe("getBriefJobStatus: what to do next", () => {
  it("a failed job whose draft the user finished later reports the brief, with a note", async () => {
    project({
      jobs: [jobRow({ status: "failed", stage: "failed", episode_id: "ep-1", error: "Stale render cursor" })],
      episodes: [draftEpisode("ep-1", { status: "ready", script: lines(30), audio_path: "u1/ep-1/brief.mp3" })],
    });
    expect(await getBriefJobStatus(USER, { jobId: "job-1" })).toMatchObject({
      status: "failed",
      error: "Stale render cursor",
      episode_status: "ready",
      links: {
        markdown: "https://graveyard.example/api/episodes/ep-1/markdown",
        audio: "https://graveyard.example/api/episodes/ep-1/audio",
      },
      stalled: false,
      next_action: "read_episode",
      note: "This job failed, but the brief was finished afterwards from the dashboard.",
    });
  });

  it("a failed job with its draft still saved points at the dashboard", async () => {
    project({
      jobs: [jobRow({ status: "failed", stage: "failed", episode_id: "ep-1", error: "Stale render cursor" })],
      episodes: [draftEpisode("ep-1", { script: lines(30) })],
    });
    expect(await getBriefJobStatus(USER, { jobId: "job-1" })).toMatchObject({
      episode_status: "draft",
      links: null,
      next_action: "resume_in_dashboard",
    });
  });

  it("a failed job that left no episode says to start again", async () => {
    project({ jobs: [jobRow({ status: "failed", stage: "failed", error: NO_MATCH })] });
    expect(await getBriefJobStatus(USER, { jobId: "job-1" })).toMatchObject({
      episode_id: null,
      episode_status: null,
      links: null,
      next_action: "start_again",
      error: NO_MATCH,
    });
  });

  it("a running job with a stale heartbeat is stalled: a read-only caller needs a write token", async () => {
    project({
      jobs: [jobRow({ status: "running", stage: "rendering", episode_id: "ep-1", heartbeat_at: isoAgo(5 * MINUTE) })],
      episodes: [draftEpisode("ep-1", { script: lines(30) })],
    });
    expect(await getBriefJobStatus(USER, { jobId: "job-1" })).toMatchObject({
      stage_label: "Recording audio",
      stalled: true,
      next_action: "use_write_token",
      note: "This job has stalled; restarting it needs a token with write access.",
    });
    expect(await getBriefJobStatus(USER, { jobId: "job-1" }, { canRestart: true, rescheduled: true })).toMatchObject({
      stalled: true,
      next_action: "wait",
      note: "This job had stalled; this poll restarted it.",
    });
  });

  it("an episode whose audio was pruned links no audio, even with its audio path still set", async () => {
    project({
      jobs: [jobRow({ status: "done", stage: "done", episode_id: "ep-1" })],
      episodes: [
        draftEpisode("ep-1", { status: "ready", audio_path: "u1/ep-1/brief.mp3", audio_pruned_at: "2026-10-28T00:00:00.000Z" }),
      ],
    });
    expect((await getBriefJobStatus(USER, { jobId: "job-1" }))?.links).toEqual({
      markdown: "https://graveyard.example/api/episodes/ep-1/markdown",
      audio: null,
    });
  });
});

// brief_jobs.status against BRIEF_JOB_STATE_TRANSITIONS. The runner and the fake claim_brief_job run for
// real; every job row's status is watched, so each write to it (the claim's, the runner's outcome write)
// is recorded with the state it replaced. A write of the state the row already holds is recorded too: that
// is how a takeover of a stale running job shows as running -> running.
describe("brief job state conformance", () => {
  const stateMoves = new MoveLog<BriefJobState>();

  /** Makes every status write on the project's job rows land in stateMoves. */
  function watchStatus() {
    for (const row of fake.tables.brief_jobs) {
      let status = row.status as BriefJobState;
      Object.defineProperty(row, "status", {
        enumerable: true,
        configurable: true,
        get: () => status,
        set: (to: BriefJobState) => {
          stateMoves.record(status, to);
          status = to;
        },
      });
    }
  }
  /** The statuses the watched rows went through, as from -> to pairs, from `since` on. */
  const seen = (since = 0) => stateMoves.moves.slice(since).map((move) => `${move.from} -> ${move.to}`);

  it("a job that finishes goes queued, running, done", async () => {
    project({ jobs: [jobRow({ params: { format: "markdown", syncFirst: false } })] });
    watchStatus();
    const from = stateMoves.moves.length;
    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "done" });
    expect(seen(from)).toEqual(["queued -> running", "running -> done"]);
  });

  it("a job that fails goes queued, running, failed", async () => {
    project({ jobs: [jobRow()] });
    vi.mocked(selectBookmarksForDigest).mockResolvedValue({ included: [], excludedAsMisleading: [] });
    watchStatus();
    const from = stateMoves.moves.length;
    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "failed", error: NO_MATCH });
    expect(seen(from)).toEqual(["queued -> running", "running -> failed"]);
  });

  it("a stale running job is taken over, running to running, and then finishes", async () => {
    project({
      jobs: [jobRow({ status: "running", stage: "rendering", episode_id: "ep-1", heartbeat_at: isoAgo(5 * MINUTE) })],
      episodes: [draftEpisode("ep-1", { script: lines(30) })],
    });
    chunkFiles["u1/ep-1/chunks"] = ["00000.mp3"];
    watchStatus();
    const from = stateMoves.moves.length;
    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "done" });
    expect(seen(from)).toEqual(["running -> running", "running -> done"]);
  });

  it("a finished job is final: a runner for it, and a running job with a fresh lease, write no status", async () => {
    project({
      jobs: [
        jobRow({ id: "job-done", status: "done", stage: "done" }),
        jobRow({ id: "job-failed", status: "failed", stage: "failed" }),
        jobRow({ id: "job-live", status: "running", stage: "writing", heartbeat_at: isoAgo(10_000) }),
      ],
    });
    watchStatus();
    const from = stateMoves.moves.length;
    for (const id of ["job-done", "job-failed", "job-live"]) await runBriefJob(id);
    expect(seen(from)).toEqual([]);
    expect(calls).toEqual([]);
  });

  // Entries the fakes cannot produce, each with its reason. None today: a real run makes every one.
  const NOT_EXERCISED: NotExercised<BriefJobState>[] = [];

  it("every status move the runner made is allowed, and every allowed move was made", () => {
    expectConformance({
      transitions: BRIEF_JOB_STATE_TRANSITIONS,
      canMove: canMoveBriefJobState,
      moves: stateMoves.moves,
      notExercised: NOT_EXERCISED,
    });
  });

  it("would catch a status write the table does not list", () => {
    const withRegression = [...stateMoves.moves, { from: "done" as const, to: "queued" as const }];
    expect(() =>
      expectConformance({ transitions: BRIEF_JOB_STATE_TRANSITIONS, canMove: canMoveBriefJobState, moves: withRegression })
    ).toThrow();
  });
});

// brief_jobs.stage against BRIEF_JOB_STAGE_TRANSITIONS, observed over the whole file. The runner's own
// check (the afterEach above) proves no move falls outside the table; this block proves the other
// direction, with scenarios for the entries the rest of the file does not make and a final check that
// every entry is observed or excused below.
describe("brief job stage conformance", () => {
  const seenFrom = (from: number) => stageMoves.moves.slice(from).map((move) => `${move.from} -> ${move.to}`);
  const unscripted = () => draftEpisode("ep-1");
  const midRender = () => draftEpisode("ep-1", { script: lines(30) });
  const rendered = () => draftEpisode("ep-1", { script: lines(30) });
  const finished = () => draftEpisode("ep-1", { status: "ready", script: lines(30), audio_path: "u1/ep-1/brief.mp3" });
  const oneChunk = ["00000.mp3"];
  const allChunks = ["00000.mp3", "00012.mp3", "00024.mp3"];
  const stale = (stage: string, extra: Row = {}) =>
    jobRow({ status: "running", stage, heartbeat_at: isoAgo(5 * MINUTE), ...extra });

  // A run cut off in a stage and re-claimed (stale) resumes from the episode's own stage, at or after the
  // stored one; each row names the first move it must make.
  it.each([
    ["queued, syncing first", jobRow({ params: { format: "both", syncFirst: true } }), [], [], "queued -> syncing"],
    ["cut off syncing", stale("syncing", { params: { format: "both", syncFirst: true } }), [], [], "syncing -> syncing"],
    ["cut off selecting", stale("selecting"), [], [], "selecting -> selecting"],
    ["cut off writing, no episode yet", stale("writing"), [], [], "writing -> selecting"],
    ["cut off writing, draft unscripted", stale("writing", { episode_id: "ep-1" }), [unscripted()], [], "writing -> scripting"],
    ["cut off writing, draft mid-render", stale("writing", { episode_id: "ep-1" }), [midRender()], oneChunk, "writing -> rendering"],
    ["cut off writing, draft rendered", stale("writing", { episode_id: "ep-1" }), [rendered()], allChunks, "writing -> publishing"],
    ["cut off writing, draft finished", stale("writing", { episode_id: "ep-1" }), [finished()], [], "writing -> done"],
    ["cut off scripting, draft unscripted", stale("scripting", { episode_id: "ep-1" }), [unscripted()], [], "scripting -> scripting"],
    ["cut off scripting, dashboard rendered it", stale("scripting", { episode_id: "ep-1" }), [rendered()], allChunks, "scripting -> publishing"],
    ["cut off scripting, dashboard finished it", stale("scripting", { episode_id: "ep-1" }), [finished()], [], "scripting -> done"],
    ["cut off rendering, draft mid-render", stale("rendering", { episode_id: "ep-1" }), [midRender()], oneChunk, "rendering -> rendering"],
    ["cut off rendering, dashboard finished it", stale("rendering", { episode_id: "ep-1" }), [finished()], [], "rendering -> done"],
    ["cut off publishing, draft rendered", stale("publishing", { episode_id: "ep-1" }), [rendered()], allChunks, "publishing -> publishing"],
    ["cut off publishing, dashboard finished it", stale("publishing", { episode_id: "ep-1" }), [finished()], [], "publishing -> done"],
  ] as [string, Row, Row[], string[], string][])("%s", async (_name, jobFields, episodes, chunks, first) => {
    project({ jobs: [jobFields], episodes });
    chunkFiles["u1/ep-1/chunks"] = chunks;
    const from = stageMoves.moves.length;
    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "done", stage: "done" });
    expect(seenFrom(from)).toContain(first);
  });

  // A fresh run, with one step made to fail: the failure write comes from the stage that was running.
  it.each([
    ["syncing", { params: { format: "both", syncFirst: true } }, () => vi.mocked(syncUser).mockRejectedValue(new Error("x down"))],
    ["selecting", {}, () => vi.mocked(selectBookmarksForDigest).mockResolvedValue({ included: [], excludedAsMisleading: [] })],
    ["writing", {}, () => vi.mocked(prepareBrief).mockRejectedValue(new Error("writer down"))],
    ["scripting", {}, () => vi.mocked(scriptBrief).mockRejectedValue(new Error("script down"))],
    ["rendering", {}, () => vi.mocked(renderChunk).mockRejectedValue(new Error("voice down"))],
    ["publishing", {}, () => vi.mocked(finalizeBrief).mockRejectedValue(new Error("storage down"))],
  ] as [string, Row, () => unknown][])("a run that fails in %s", async (stage, jobFields, breakStep) => {
    project({ jobs: [jobRow(jobFields)] });
    breakStep();
    const from = stageMoves.moves.length;
    await runBriefJob("job-1");
    expect(job()).toMatchObject({ status: "failed", stage: "failed" });
    expect(seenFrom(from).at(-1)).toBe(`${stage} -> failed`);
  });

  it("a run stopped before its first step, by a revoked token, fails from queued", async () => {
    project({
      jobs: [jobRow({ token_id: "tok-1" })],
      tokens: [{ id: "tok-1", user_id: USER, revoked_at: "2026-10-29T09:00:00.000Z", expires_at: null }],
    });
    const from = stageMoves.moves.length;
    await runBriefJob("job-1");
    expect(seenFrom(from)).toEqual(["queued -> failed"]);
  });

  it.each([
    [{ format: "markdown", syncFirst: false }, ["queued -> selecting", "selecting -> writing", "writing -> done"]],
    [
      { format: "both", syncFirst: false },
      [
        "queued -> selecting",
        "selecting -> writing",
        "writing -> scripting",
        "scripting -> rendering",
        "rendering -> publishing",
        "publishing -> done",
      ],
    ],
  ])("a fresh run of %j makes the forward moves", async (params, expected) => {
    project({ jobs: [jobRow({ params })] });
    const from = stageMoves.moves.length;
    await runBriefJob("job-1");
    expect(seenFrom(from)).toEqual(expected);
  });

  // The check fires: these rows put a draft behind its job's stored stage, which cannot arise in a real run
  // (a script is never cleared, and chunk files go only with a publish or a discard). The runner resumes from
  // the episode whatever stage is stored, so it still makes the move, logs it as unexpected, and finishes
  // the job. Their moves stay out of the conformance record.
  it.each([
    ["rendering", [unscripted()], [], "rendering -> scripting"],
    ["publishing", [unscripted()], [], "publishing -> scripting"],
    ["publishing", [midRender()], oneChunk, "publishing -> rendering"],
  ] as [string, Row[], string[], string][])(
    "a draft behind its job's %s stage logs an unexpected move and still finishes (%#)",
    async (stored, episodes, chunks, move) => {
      project({ jobs: [stale(stored, { episode_id: "ep-1" })], episodes });
      chunkFiles["u1/ep-1/chunks"] = chunks;
      const recorded = stageMoves.moves.length;
      await runBriefJob("job-1");
      stageMoves.moves.splice(recorded);
      expect(job()).toMatchObject({ status: "done", stage: "done" });
      const logged = vi
        .mocked(console.error)
        .mock.calls.filter(([line]) => typeof line === "string" && line.includes(UNEXPECTED_STAGE_MOVE));
      expect(logged).toEqual([[`Brief job job-1: ${UNEXPECTED_STAGE_MOVE} ${move}`]]);
      vi.mocked(console.error).mockClear();
    }
  );

  // Entries the fakes cannot produce, each with its reason. None today.
  const NOT_EXERCISED: NotExercised<BriefJobStage>[] = [];

  it("every stage move the runner made is allowed, and every allowed move was made or is excused", () => {
    expectConformance({
      transitions: BRIEF_JOB_STAGE_TRANSITIONS,
      canMove: canMoveBriefJobStage,
      moves: stageMoves.moves,
      notExercised: NOT_EXERCISED,
    });
  });
});
