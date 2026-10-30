import "server-only";
import { after } from "next/server";
import { db } from "./supabase";
import { enrichNewBookmarks, selectBookmarksForDigest } from "./brain";
import { CapacityError } from "./capacity";
import { DigestStageError, finalizeBrief, prepareBrief, renderChunk, scriptBrief, validatePrepareInput } from "./digest";
import type { PrepareRequest, SignedEpisode } from "./digest";
import { appUrl } from "./env";
import { deriveDigestStage, episodeBasePath, listChunkStarts } from "./episodes";
import { ingestPending } from "./ingest";
import { checkUsage, UsageLimitError } from "./limits";
import { syncUser } from "./sync";
import { InvalidVoiceKeyError, VoiceConfigError, VoiceVendorError } from "./voice";

// Background brief jobs: a brief an assistant starts, driven on the server instead of by a browser tab.
// One `brief_jobs` row per request. The runner drives the same four stages as the dashboard (prepare,
// script, the render loop, finalize, all from src/lib/digest.ts, so every guard and cap still applies)
// and records its progress on the row, so a status call can report it.
//
// The runner holds a lease: claim_brief_job flips a queued job to running, or takes over a running job
// whose heartbeat went stale, in one statement, so two runners can't both work on one job. While it runs
// it bumps heartbeat_at. On a long-lived Node host one run finishes the job. On a request-bound host the
// run is cut off at the route's maxDuration, its heartbeat goes stale, and the next status poll
// (maybeRescheduleBriefJob) claims the job again and resumes from what the episode has persisted.

export type BriefJobState = "queued" | "running" | "done" | "failed";

export type BriefJobStage =
  | "queued"
  | "syncing"
  | "selecting"
  | "writing"
  | "scripting"
  | "rendering"
  | "publishing"
  | "done"
  | "failed";

/** A validated generate request, as stored in `brief_jobs.params`. */
export interface BriefJobParams extends PrepareRequest {
  /** Pull new bookmarks from X and analyze them before selecting. */
  syncFirst: boolean;
}

export interface BriefJobRow {
  id: string;
  user_id: string;
  token_id: string | null;
  params: BriefJobParams;
  status: BriefJobState;
  stage: BriefJobStage;
  episode_id: string | null;
  rendered_lines: number;
  total_lines: number;
  error: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

/** What a status call reports about a job (the get_brief_status tool's output). */
export interface BriefJobStatus {
  job_id: string;
  status: BriefJobState;
  stage: BriefJobStage;
  progress: { rendered_lines: number; total_lines: number };
  episode_id: string | null;
  title: string | null;
  /** Stable links to the finished brief, only once the job is done; `audio` is null without audio. */
  links: { markdown: string; audio: string | null } | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export const DEFAULT_BRIEF_JOB_STALE_SECONDS = 90;

/**
 * How long a running job's heartbeat may go quiet before another runner may claim it, in seconds.
 * BRIEF_JOB_STALE_SECONDS overrides the default of 90; read on every call, never at import.
 */
export function briefJobStaleSeconds(): number {
  const fromEnv = Number(process.env.BRIEF_JOB_STALE_SECONDS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_BRIEF_JOB_STALE_SECONDS;
}

// ---------------------------------------------------------------------------
// Creating a job
// ---------------------------------------------------------------------------

/**
 * Validates a generate request: the prepare fields exactly as the prepare route checks them, plus an
 * optional boolean `sync_first` (the MCP tool's name for it) or `syncFirst`, stored as `syncFirst`.
 */
export function validateBriefJobInput(body: unknown): { value: BriefJobParams } | { error: string } {
  const prepared = validatePrepareInput(body);
  if ("error" in prepared) return prepared;
  const b = body as Record<string, unknown>;
  const syncFirst = b.sync_first !== undefined ? b.sync_first : b.syncFirst;
  if (syncFirst !== undefined && typeof syncFirst !== "boolean") return { error: "sync_first must be a boolean" };
  return { value: { ...prepared.value, syncFirst: syncFirst ?? false } };
}

const NO_MATCH = "No bookmarks match these filters. Try widening the date range or syncing first.";

/**
 * Records a queued job and returns its row; the caller then schedules it with scheduleBriefJob. Unless
 * the job syncs first (which may add posts), the free selection check runs first, so a filter that
 * matches nothing throws DigestStageError(400) here: no job is created and no cap is spent.
 */
export async function createBriefJob(
  userId: string,
  params: BriefJobParams,
  opts: { tokenId?: string } = {}
): Promise<BriefJobRow> {
  if (!params.syncFirst) {
    const { included } = await selectBookmarksForDigest(userId, params);
    if (included.length === 0) throw new DigestStageError(400, NO_MATCH);
  }
  const { data, error } = await db()
    .from("brief_jobs")
    .insert({ user_id: userId, token_id: opts.tokenId ?? null, params, status: "queued", stage: "queued" })
    .select()
    .single();
  if (error || !data) throw new Error(`Job insert failed: ${error?.message}`);
  return data as BriefJobRow;
}

// ---------------------------------------------------------------------------
// Running a job
// ---------------------------------------------------------------------------

/**
 * Runs the job once the current response has been sent, through `after()` from next/server. Must be
 * called inside a request scope (a route handler or a server action): `after()` throws anywhere else.
 * The callback gets the route's maxDuration, so on a request-bound host a long job is finished by later
 * claims (see maybeRescheduleBriefJob). A runner that crashes is logged here, never rethrown.
 */
export function scheduleBriefJob(jobId: string): void {
  after(async () => {
    try {
      await runBriefJob(jobId);
    } catch (err) {
      console.error(`Brief job ${jobId}: runner crashed:`, err);
    }
  });
}

/**
 * Claims the job and drives it to done or failed. Returns quietly when the claim finds nothing to take
 * (another runner holds the lease, or the job already finished). Resumes from whatever the episode has
 * persisted, so a re-claimed job never re-pays for a script or a chunk that already landed. A failure
 * marks the job failed with a message that is safe to show and leaves the episode alone: a draft stays
 * resumable from the dashboard. Rejects only when the database itself fails (the claim, or the write
 * that records the outcome).
 */
export async function runBriefJob(jobId: string): Promise<void> {
  const job = await claimBriefJob(jobId);
  if (!job) return;

  const stopHeartbeat = startHeartbeat(jobId);
  try {
    await driveJob(job);
    await updateJob(jobId, { status: "done", stage: "done", error: null, finished_at: new Date().toISOString() });
  } catch (err) {
    console.error(`Brief job ${jobId} failed:`, err);
    await updateJob(jobId, {
      status: "failed",
      stage: "failed",
      error: publicJobError(err),
      finished_at: new Date().toISOString(),
    });
  } finally {
    stopHeartbeat();
  }
}

/** The claim_brief_job lease: the claimed row, or null when another runner holds it or it is finished. */
async function claimBriefJob(jobId: string): Promise<BriefJobRow | null> {
  const { data, error } = await db().rpc("claim_brief_job", {
    p_job_id: jobId,
    p_stale_seconds: briefJobStaleSeconds(),
  });
  if (error) throw new Error(`Job claim failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return (row as BriefJobRow | undefined) ?? null;
}

// Stages that only run once the episode exists. A job past them with no episode_id lost its episode
// (the user discarded the draft, and the foreign key cleared the id): preparing again would start and
// bill a whole new brief.
const EPISODE_STAGES = new Set<BriefJobStage>(["scripting", "rendering", "publishing"]);

async function driveJob(job: BriefJobRow): Promise<void> {
  const { id: jobId, user_id: userId, params } = job;
  let episodeId = job.episode_id;

  if (!episodeId) {
    if (EPISODE_STAGES.has(job.stage)) {
      throw new DigestStageError(409, "This brief's draft was discarded before it finished", "episode gone");
    }
    // A run cut off after syncing (stage selecting or writing) doesn't spend another sync slot.
    if (params.syncFirst && (job.stage === "queued" || job.stage === "syncing")) {
      await setStage(jobId, "syncing");
      await syncBookmarks(jobId, userId);
    }

    // The same free check createBriefJob makes, here so a sync that found nothing new still answers
    // "no bookmarks match" before any paid call.
    await setStage(jobId, "selecting");
    const { included } = await selectBookmarksForDigest(userId, params);
    if (included.length === 0) throw new DigestStageError(400, NO_MATCH);

    await setStage(jobId, "writing");
    const prepared = await prepareBrief(userId, prepareRequest(params));
    // The signed episode is the inserted row plus URLs; its type keeps only the URL fields by name.
    episodeId = (prepared.episode as SignedEpisode & { id: string }).id;
    await updateJob(jobId, { episode_id: episodeId, heartbeat_at: new Date().toISOString() });
    if (prepared.done) return; // markdown-only: the brief is ready
  }

  await finishAudio(jobId, userId, episodeId, params.targetMinutes);
}

/** Script, render and publish a draft, resuming exactly where the dashboard's Resume banner would. */
async function finishAudio(jobId: string, userId: string, episodeId: string, targetMinutes?: number) {
  const { data: episode, error } = await db()
    .from("episodes")
    .select("id, status, script, markdown_path")
    .eq("user_id", userId)
    .eq("id", episodeId)
    .maybeSingle();
  if (error) throw new Error(`Episode lookup failed: ${error.message}`);
  if (!episode) throw new DigestStageError(404, "This brief's draft was discarded before it finished", "episode gone");

  // As /api/digest/status does: chunk progress only matters for an unfinished episode with a script.
  const scriptLength = Array.isArray(episode.script) ? episode.script.length : 0;
  const chunkStarts =
    episode.status !== "ready" && scriptLength > 0 && episode.markdown_path
      ? await listChunkStarts(episodeBasePath(episode.markdown_path))
      : [];
  const resume = deriveDigestStage({ status: episode.status, scriptLength, chunkStarts });
  if (resume.stage === "ready") return; // finished by an earlier run (or a markdown-only brief)

  let { totalLines, nextCursor: cursor } = resume;
  if (resume.stage === "needs_script") {
    await setStage(jobId, "scripting");
    ({ totalLines } = await scriptBrief(userId, episodeId, targetMinutes));
    cursor = 0;
  }

  // The dashboard's loop: a cursor already at totalLines (needs_finalize) goes straight to publishing.
  if (cursor < totalLines) {
    await setStage(jobId, "rendering", { rendered_lines: cursor, total_lines: totalLines });
    while (cursor < totalLines) {
      const rendered = await renderChunk(userId, episodeId, cursor);
      cursor = rendered.nextCursor;
      totalLines = rendered.totalLines;
      await updateJob(jobId, {
        heartbeat_at: new Date().toISOString(),
        rendered_lines: Math.min(cursor, totalLines),
        total_lines: totalLines,
      });
      if (rendered.done) break;
    }
  }

  await setStage(jobId, "publishing", { rendered_lines: totalLines, total_lines: totalLines });
  await finalizeBrief(userId, episodeId);
}

/**
 * Pulls new bookmarks from X and analyzes them, spending from the same caps as the dashboard's Sync
 * button: one sync slot, then one enrich slot per chunk of the same size the dashboard's loop asks for.
 */
async function syncBookmarks(jobId: string, userId: string): Promise<void> {
  await checkUsage(userId, "sync");
  const { pendingAnalysis } = await syncUser(userId);

  let pending = pendingAnalysis;
  while (pending > 0) {
    await checkUsage(userId, "enrich");
    const ingest = await ingestPending(userId, 15);
    const enrich = await enrichNewBookmarks(userId, 60);
    await updateJob(jobId, { heartbeat_at: new Date().toISOString() });
    const remaining = Math.max(ingest.remaining, enrich.remaining);
    if (ingest.ingested === 0 && enrich.enriched === 0 && remaining > 0) {
      // The dashboard stops here too. The posts still unanalyzed are selected all the same, untagged.
      console.error(`Brief job ${jobId}: analysis stalled with ${remaining} bookmarks left; continuing`);
      break;
    }
    pending = remaining;
  }
}

function prepareRequest(params: BriefJobParams): PrepareRequest {
  const { format, from, to, topics, tweetIds, targetMinutes } = params;
  return { format, from, to, topics, tweetIds, targetMinutes };
}

type JobPatch = Partial<Omit<BriefJobRow, "id" | "user_id" | "token_id" | "params" | "created_at">>;

/** One small update on the job row, scoped by id. */
async function updateJob(jobId: string, patch: JobPatch): Promise<void> {
  const { error } = await db().from("brief_jobs").update(patch).eq("id", jobId);
  if (error) throw new Error(`Job update failed: ${error.message}`);
}

/** A stage transition, which is also a heartbeat. */
function setStage(jobId: string, stage: BriefJobStage, extra: JobPatch = {}): Promise<void> {
  return updateJob(jobId, { stage, heartbeat_at: new Date().toISOString(), ...extra });
}

/**
 * Keeps the lease while a single paid call runs long (the Grok writing pass, the script), so a status
 * poll doesn't take the job over from a runner that is still working and pay for the same step twice.
 * Beats three times per stale window. Dies with the process, which is what lets a cut-off run go stale.
 */
function startHeartbeat(jobId: string): () => void {
  const everyMs = Math.max(1, Math.floor(briefJobStaleSeconds() / 3)) * 1000;
  const timer = setInterval(() => {
    db()
      .from("brief_jobs")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("status", "running")
      .then(
        ({ error }) => {
          if (error) console.error(`Brief job ${jobId}: heartbeat failed:`, error.message);
        },
        (err: unknown) => console.error(`Brief job ${jobId}: heartbeat failed:`, err)
      );
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * The message a failed job reports, which an assistant may show the user: the same public messages the
 * /api/digest/* routes answer with. Anything unexpected is generic; its detail stays in the server log.
 */
export function publicJobError(err: unknown): string {
  if (err instanceof DigestStageError) return err.publicMessage;
  if (err instanceof UsageLimitError) return err.message;
  if (err instanceof VoiceConfigError) return err.message;
  if (err instanceof InvalidVoiceKeyError) return "The voice provider rejected the API key — update it under Voices";
  if (err instanceof VoiceVendorError && (err.status === 401 || err.status === 403)) {
    return "The voice provider refused the request — check that account's credits and permissions";
  }
  if (err instanceof CapacityError) return err.message;
  return "Brief generation failed";
}

// ---------------------------------------------------------------------------
// Reporting on a job
// ---------------------------------------------------------------------------

export interface BriefJobLookup {
  jobId?: string;
  /** The newest job that produced this episode. */
  episodeId?: string;
}

/** The user's job by id, or the newest one for an episode; null when there is none (or it isn't theirs). */
export async function findBriefJob(userId: string, lookup: BriefJobLookup): Promise<BriefJobRow | null> {
  if (lookup.jobId) {
    const { data, error } = await db()
      .from("brief_jobs")
      .select("*")
      .eq("user_id", userId)
      .eq("id", lookup.jobId)
      .maybeSingle();
    if (error) throw new Error(`Job lookup failed: ${error.message}`);
    return (data as BriefJobRow | null) ?? null;
  }
  if (lookup.episodeId) {
    const { data, error } = await db()
      .from("brief_jobs")
      .select("*")
      .eq("user_id", userId)
      .eq("episode_id", lookup.episodeId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Job lookup failed: ${error.message}`);
    return (data as BriefJobRow | null) ?? null;
  }
  return null;
}

/** A job row as a status report: the episode's title once there is one, and its links once it's done. */
export async function describeBriefJob(job: BriefJobRow): Promise<BriefJobStatus> {
  let title: string | null = null;
  let links: BriefJobStatus["links"] = null;
  if (job.episode_id) {
    const { data: episode, error } = await db()
      .from("episodes")
      .select("id, title, audio_path")
      .eq("user_id", job.user_id)
      .eq("id", job.episode_id)
      .maybeSingle();
    if (error) throw new Error(`Episode lookup failed: ${error.message}`);
    if (episode) {
      title = episode.title ?? null;
      if (job.status === "done") {
        // The stable routes, which mint a fresh signed URL on every visit, so a link in a chat keeps working.
        const base = `${appUrl()}/api/episodes/${episode.id}`;
        links = { markdown: `${base}/markdown`, audio: episode.audio_path ? `${base}/audio` : null };
      }
    }
  }
  return {
    job_id: job.id,
    status: job.status,
    stage: job.stage,
    progress: { rendered_lines: job.rendered_lines ?? 0, total_lines: job.total_lines ?? 0 },
    episode_id: job.episode_id,
    title,
    links,
    error: job.error,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
}

/**
 * The status report for the user's job, by job id or by the episode it produced; null when not found.
 * A status tool that should also keep the job moving uses findBriefJob, then maybeRescheduleBriefJob,
 * then describeBriefJob.
 */
export async function getBriefJobStatus(userId: string, lookup: BriefJobLookup): Promise<BriefJobStatus | null> {
  const job = await findBriefJob(userId, lookup);
  return job ? describeBriefJob(job) : null;
}

/**
 * Schedules a runner for a job that needs one: still queued (its first runner never started), or running
 * with a heartbeat older than the stale window (its runner was cut off). Returns whether it scheduled.
 * Like scheduleBriefJob, call it inside a request scope. A runner it starts for a job someone else just
 * claimed loses the claim and stops, so calling it on every status poll is safe.
 */
export function maybeRescheduleBriefJob(job: Pick<BriefJobRow, "id" | "status" | "heartbeat_at">): boolean {
  const stale =
    job.status === "running" &&
    job.heartbeat_at !== null &&
    Date.now() - Date.parse(job.heartbeat_at) > briefJobStaleSeconds() * 1000;
  if (job.status !== "queued" && !stale) return false;
  scheduleBriefJob(job.id);
  return true;
}
