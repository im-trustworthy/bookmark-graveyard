import "server-only";
import { after } from "next/server";
import { db } from "./supabase";
import { isUserAllowed } from "./allowlist";
import { enrichNewBookmarks, selectBookmarksForDigest } from "./brain";
import { CapacityError } from "./capacity";
import { DigestStageError, finalizeBrief, prepareBrief, renderChunk, scriptBrief, validatePrepareInput } from "./digest";
import type { PrepareRequest, SignedEpisode } from "./digest";
import { appUrl } from "./env";
import { resumePointFor } from "./episodes";
import { ingestPending } from "./ingest";
import { checkUsage, UsageLimitError } from "./limits";
import {
  BRIEF_JOB_STAGE_INFO,
  BRIEF_JOB_STAGES,
  briefJobOutlook,
  briefJobStalled,
  canMoveBriefJobStage,
  isBriefJobStage,
} from "./state/brief-job";
import type { BriefJobNextAction, BriefJobStage, BriefJobState } from "./state/brief-job";
import { audioAvailability, EPISODE_STATUS } from "./state/episode";
import { PIPELINE_CHUNK, pipelineProgress } from "./state/pipeline";
import { BEARER_USABLE_STATUSES, tokenStatusIn } from "./state/token";
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
//
// The lease is fenced: each claim stamps a fresh lease_id, and every write the runner makes (stage,
// heartbeat, progress, episode, outcome) is filtered on it. A runner that was only slow, not dead, and got
// taken over finds its next write matching no row; it stops there without writing anything else, so the
// new lease holder's progress stands.
//
// Before each paid step (sync, prepare, script, every rendered chunk, finalize) the runner also checks
// that the token which started the job is still live and the user still allowed, so revoking a token in
// the Assistants panel, or taking someone off the allowlist, stops their running briefs too.
//
// The states, stages and their legal moves live in src/lib/state/brief-job.ts; the types are re-exported
// here so existing imports keep working.

export type { BriefJobStage, BriefJobState };

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
  /** The current runner's lease, set by every claim; null until the first one. */
  lease_id?: string | null;
}

/** What a status call reports about a job (the get_brief_status tool's output). */
export interface BriefJobStatus {
  job_id: string;
  status: BriefJobState;
  stage: BriefJobStage;
  progress: { rendered_lines: number; total_lines: number };
  episode_id: string | null;
  title: string | null;
  /**
   * Stable links to the brief whenever its episode is ready (so also for a failed job whose draft the
   * user finished later); `audio` is null without playable audio (markdown-only, or pruned).
   */
  links: { markdown: string; audio: string | null } | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** The stage in words, for the agent to pass on. */
  stage_label: string;
  /** A queued or running job that has gone quiet longer than the stale window. */
  stalled: boolean;
  /** What the agent should do next (see briefJobOutlook). */
  next_action: BriefJobNextAction;
  /** A sentence explaining an outcome the other fields don't, or null. */
  note: string | null;
  /** The status of the episode the job drives; null when it has none. */
  episode_status: "draft" | "ready" | null;
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

/** What a failed job reports when its token was revoked (or expired) while it ran. */
export const TOKEN_REVOKED_MESSAGE = "The token that started this brief was revoked";
/** What a failed job reports when its user was taken off the allowlist while it ran. */
export const USER_NOT_ALLOWED_MESSAGE = "This account can no longer use this server";

/** The job may not go on: its token or its user lost access. The message is safe to show. */
class JobAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobAccessError";
  }
}

/** What a job reports when the draft it drives was discarded from the dashboard before it finished. */
const DRAFT_DISCARDED_MESSAGE = "This brief's draft was discarded before it finished";

/** What a job reports when the episode it drives is in a state no stage will act on. */
const DRAFT_UNFINISHABLE_MESSAGE = "This brief's draft can no longer be finished";

/** A fenced write matched no row: another runner claimed the job, and this one must stop. */
class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Brief job ${jobId}: lease lost`);
    this.name = "LeaseLostError";
  }
}

/** One runner's hold on one job: everything a fenced write or an access check needs. */
interface JobRun {
  jobId: string;
  leaseId: string;
  userId: string;
  tokenId: string | null;
  /**
   * The stage this run last wrote, seeded from the claimed row: what setStage checks each move against
   * BRIEF_JOB_STAGE_TRANSITIONS from. A string, since the column has no CHECK.
   */
  stage: string;
}

/**
 * Claims the job and drives it to done or failed. Returns quietly when the claim finds nothing to take
 * (another runner holds the lease, or the job already finished), and stops quietly, writing nothing more,
 * when another runner takes the lease over mid-run. Resumes from whatever the episode has persisted, so a
 * re-claimed job never re-pays for a script or a chunk that already landed. A failure marks the job failed
 * with a message that is safe to show and leaves the episode alone: a draft stays resumable from the
 * dashboard. Rejects only when the database itself fails (the claim, or the write that records the outcome).
 */
export async function runBriefJob(jobId: string): Promise<void> {
  const job = await claimBriefJob(jobId);
  if (!job) return;
  const run: JobRun = { jobId, leaseId: job.lease_id!, userId: job.user_id, tokenId: job.token_id, stage: job.stage };

  const stopHeartbeat = startHeartbeat(run);
  try {
    try {
      await ensureJobMayContinue(run);
      await driveJob(run, job);
      // Checked before the write, recorded only once it lands: a done write that fails leaves this run at
      // its last stage, so the failure that follows is checked from there, not from a done it never reached.
      checkStageMove(run, "done");
      await updateJob(run, { status: "done", stage: "done", error: null, finished_at: new Date().toISOString() });
      run.stage = "done";
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      console.error(`Brief job ${jobId} failed:`, err);
      noteStageMove(run, "failed");
      await updateJob(run, {
        status: "failed",
        stage: "failed",
        error: publicJobError(err),
        finished_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    if (!(err instanceof LeaseLostError)) throw err;
    console.error(`Brief job ${jobId}: another runner took the job over; this one stopped`);
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
  const row = (Array.isArray(data) ? data[0] : data) as BriefJobRow | undefined;
  if (!row) return null;
  // Without a lease no write could be fenced; that is a database missing the hardening migration.
  if (!row.lease_id) throw new Error("Job claim returned no lease_id: apply the latest supabase/migrations");
  return row;
}

/**
 * Throws JobAccessError when the token that started the job is revoked, expired or gone, or the user is no
 * longer allowed. Called right after the claim and before every paid step, so revoking access stops a
 * running brief at its next step rather than after it has spent everything.
 */
async function ensureJobMayContinue(run: JobRun): Promise<void> {
  if (run.tokenId) {
    const { data: token, error } = await db()
      .from("api_tokens")
      .select("revoked_at, expires_at")
      .eq("id", run.tokenId)
      .maybeSingle();
    if (error) throw new Error(`Token lookup failed: ${error.message}`);
    // A token gone from the table reads as revoked: it can't be used either way.
    if (!token || !tokenStatusIn(BEARER_USABLE_STATUSES, token)) throw new JobAccessError(TOKEN_REVOKED_MESSAGE);
  }
  if (!(await isUserAllowed(run.userId))) throw new JobAccessError(USER_NOT_ALLOWED_MESSAGE);
}

/** A stage transition (fenced, so it also confirms the lease) followed by the access check: the gate before a paid step. */
async function beginPaidStage(run: JobRun, stage: BriefJobStage, extra: JobPatch = {}): Promise<void> {
  await setStage(run, stage, extra);
  await ensureJobMayContinue(run);
}

// Stages that only run once the episode exists. A job past them with no episode_id lost its episode
// (the user discarded the draft, and the foreign key cleared the id): preparing again would start and
// bill a whole new brief.
const EPISODE_STAGES: ReadonlySet<string> = new Set<BriefJobStage>(
  BRIEF_JOB_STAGES.filter((stage) => BRIEF_JOB_STAGE_INFO[stage].needsEpisode)
);

async function driveJob(run: JobRun, job: BriefJobRow): Promise<void> {
  const { user_id: userId, params } = job;
  let episodeId = job.episode_id;

  if (!episodeId) {
    if (EPISODE_STAGES.has(job.stage)) {
      throw new DigestStageError(409, DRAFT_DISCARDED_MESSAGE, "episode gone");
    }
    // A run cut off after syncing (stage selecting or writing) doesn't spend another sync slot.
    if (params.syncFirst && (job.stage === "queued" || job.stage === "syncing")) {
      await beginPaidStage(run, "syncing");
      await syncBookmarks(run);
    }

    // The same free check createBriefJob makes, here so a sync that found nothing new still answers
    // "no bookmarks match" before any paid call.
    await setStage(run, "selecting");
    const { included } = await selectBookmarksForDigest(userId, params);
    if (included.length === 0) throw new DigestStageError(400, NO_MATCH);

    await beginPaidStage(run, "writing");
    const prepared = await prepareBrief(userId, prepareRequest(params));
    // The signed episode is the inserted row plus URLs; its type keeps only the URL fields by name.
    episodeId = (prepared.episode as SignedEpisode & { id: string }).id;
    await updateJob(run, { episode_id: episodeId, heartbeat_at: new Date().toISOString() });
    if (prepared.done) return; // markdown-only: the brief is ready
  }

  await finishAudio(run, episodeId, params.targetMinutes);
}

/** Script, render and publish a draft, resuming exactly where the dashboard's Resume banner would. */
async function finishAudio(run: JobRun, episodeId: string, targetMinutes?: number) {
  const { userId } = run;
  const { data: episode, error } = await db()
    .from("episodes")
    .select("id, status, script, markdown_path")
    .eq("user_id", userId)
    .eq("id", episodeId)
    .maybeSingle();
  if (error) throw new Error(`Episode lookup failed: ${error.message}`);
  if (!episode) throw new DigestStageError(404, DRAFT_DISCARDED_MESSAGE, "episode gone");

  const resume = await resumePointFor(episode);
  if (resume.stage === "ready") return; // finished by an earlier run (or a markdown-only brief)
  // A row no stage will act on (a failed episode): without this the zero-line resume point would fall
  // through to publishing and ask finalize, a paid stage, only to be refused.
  if (resume.stage === "none") throw new DigestStageError(409, DRAFT_UNFINISHABLE_MESSAGE, "episode not resumable");

  let { totalLines, nextCursor: cursor } = resume;
  if (resume.stage === "needs_script") {
    await beginPaidStage(run, "scripting");
    ({ totalLines } = await draftStillThere(() => scriptBrief(userId, episodeId, targetMinutes)));
    cursor = 0;
  }

  // The dashboard's loop: a cursor already at totalLines (needs_finalize) goes straight to publishing.
  if (cursor < totalLines) {
    await beginPaidStage(run, "rendering", { rendered_lines: cursor, total_lines: totalLines });
    let first = true;
    while (cursor < totalLines) {
      // Every chunk spends voice credits: check access before each, not only at the loop's start.
      if (!first) await ensureJobMayContinue(run);
      first = false;
      const rendered = await draftStillThere(() => renderChunk(userId, episodeId, cursor));
      cursor = rendered.nextCursor;
      totalLines = rendered.totalLines;
      await updateJob(run, {
        heartbeat_at: new Date().toISOString(),
        rendered_lines: Math.min(cursor, totalLines),
        total_lines: totalLines,
      });
      if (rendered.done) break;
    }
  }

  await beginPaidStage(run, "publishing", { rendered_lines: totalLines, total_lines: totalLines });
  await draftStillThere(() => finalizeBrief(userId, episodeId));
}

/**
 * Runs one audio stage call, reading its 404 as what it means here: the user discarded the draft from the
 * dashboard while the job worked on it. The stage functions answer 404 with their own wording ("Episode
 * not found", "Episode has no script"), which is about a request, not about this job.
 */
async function draftStillThere<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof DigestStageError && err.status === 404) {
      throw new DigestStageError(404, DRAFT_DISCARDED_MESSAGE, `episode gone: ${err.logDetail ?? err.publicMessage}`);
    }
    throw err;
  }
}

/**
 * Pulls new bookmarks from X and analyzes them, spending from the same caps as the dashboard's Sync
 * button: one sync slot, then one enrich slot per chunk of the same size the dashboard's loop asks for.
 */
async function syncBookmarks(run: JobRun): Promise<void> {
  const { jobId, userId } = run;
  await checkUsage(userId, "sync");
  const { pendingAnalysis } = await syncUser(userId);

  let pending = pendingAnalysis;
  while (pending > 0) {
    await checkUsage(userId, "enrich");
    const ingest = await ingestPending(userId, PIPELINE_CHUNK.ingest);
    const enrich = await enrichNewBookmarks(userId, PIPELINE_CHUNK.enrich, PIPELINE_CHUNK.enrichCalls);
    await updateJob(run, { heartbeat_at: new Date().toISOString() });
    const { remaining, stalled } = pipelineProgress({
      ingested: ingest.ingested,
      enriched: enrich.enriched,
      missed: enrich.missed,
      ingestRemaining: ingest.remaining,
      enrichRemaining: enrich.remaining,
    });
    if (stalled) {
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

type JobPatch = Partial<Omit<BriefJobRow, "id" | "user_id" | "token_id" | "params" | "created_at" | "lease_id">>;

/**
 * One small update on the job row, fenced: it lands only while the row still carries this run's lease.
 * Throws LeaseLostError when it matched no row, which means another runner claimed the job.
 */
async function updateJob(run: JobRun, patch: JobPatch): Promise<void> {
  const { data, error } = await db()
    .from("brief_jobs")
    .update(patch)
    .eq("id", run.jobId)
    .eq("lease_id", run.leaseId)
    .select("id");
  if (error) throw new Error(`Job update failed: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) throw new LeaseLostError(run.jobId);
}

/** A stage transition, which is also a heartbeat. */
async function setStage(run: JobRun, stage: BriefJobStage, extra: JobPatch = {}): Promise<void> {
  noteStageMove(run, stage);
  await updateJob(run, { stage, heartbeat_at: new Date().toISOString(), ...extra });
}

/** The line noteStageMove logs, so a test can look for it. */
export const UNEXPECTED_STAGE_MOVE = "unexpected stage move";

/**
 * Records the stage this run moves to, and logs a move BRIEF_JOB_STAGE_TRANSITIONS doesn't list. It never
 * throws: the table is an observability check on the runner, not a gate, and a job stopped over a
 * bookkeeping gap would cost the user a brief they paid for.
 */
function noteStageMove(run: JobRun, to: BriefJobStage): void {
  checkStageMove(run, to);
  run.stage = to;
}

/** The table check alone, for a move recorded only after its write lands. */
function checkStageMove(run: JobRun, to: BriefJobStage): void {
  const from = run.stage;
  if (!isBriefJobStage(from) || !canMoveBriefJobStage(from, to)) {
    console.error(`Brief job ${run.jobId}: ${UNEXPECTED_STAGE_MOVE} ${from} -> ${to}`);
  }
}

/**
 * Keeps the lease while a single paid call runs long (the Grok writing pass, the script), so a status
 * poll doesn't take the job over from a runner that is still working and pay for the same step twice.
 * Beats three times per stale window, fenced like every other write: once a beat finds the lease gone it
 * stops beating, and the run stops at its own next write. Dies with the process, which is what lets a
 * cut-off run go stale.
 */
function startHeartbeat(run: JobRun): () => void {
  const { jobId } = run;
  const everyMs = Math.max(1, Math.floor(briefJobStaleSeconds() / 3)) * 1000;
  const timer = setInterval(() => {
    db()
      .from("brief_jobs")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("lease_id", run.leaseId)
      .eq("status", "running")
      .select("id")
      .then(
        ({ data, error }) => {
          if (error) console.error(`Brief job ${jobId}: heartbeat failed:`, error.message);
          else if (!Array.isArray(data) || data.length === 0) clearInterval(timer); // lease gone: stop beating
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
  if (err instanceof JobAccessError) return err.message;
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

export interface DescribeBriefJobOptions {
  /** The caller may restart a stalled job (its token has write access). Default false. */
  canRestart?: boolean;
  /** This poll just scheduled a new runner for the job (maybeRescheduleBriefJob said so). Default false. */
  rescheduled?: boolean;
}

/**
 * A job row as a status report: the episode's title once there is one, its links whenever it is ready,
 * and what the caller should do next (briefJobOutlook), from the job and its episode together.
 */
export async function describeBriefJob(job: BriefJobRow, opts: DescribeBriefJobOptions = {}): Promise<BriefJobStatus> {
  let title: string | null = null;
  let links: BriefJobStatus["links"] = null;
  let episodeStatus: BriefJobStatus["episode_status"] = null;
  if (job.episode_id) {
    const { data, error } = await db()
      .from("episodes")
      .select("id, title, status, audio_path, audio_pruned_at")
      .eq("user_id", job.user_id)
      .eq("id", job.episode_id)
      .maybeSingle();
    if (error) throw new Error(`Episode lookup failed: ${error.message}`);
    const episode = data as {
      id: string;
      title: string | null;
      status: string;
      audio_path: string | null;
      audio_pruned_at?: string | null;
    } | null;
    if (episode) {
      title = episode.title ?? null;
      // Only the two statuses a job can leave behind; nothing writes a failed episode.
      if (episode.status === EPISODE_STATUS.draft || episode.status === EPISODE_STATUS.ready) episodeStatus = episode.status;
      if (episode.status === EPISODE_STATUS.ready) {
        // The stable routes, which mint a fresh signed URL on every visit, so a link in a chat keeps working.
        const base = `${appUrl()}/api/episodes/${episode.id}`;
        const playable =
          audioAvailability({ audio_path: episode.audio_path, audio_pruned_at: episode.audio_pruned_at ?? null }) === "available";
        links = { markdown: `${base}/markdown`, audio: playable ? `${base}/audio` : null };
      }
    }
  }
  const outlook = briefJobOutlook({
    status: job.status,
    heartbeat_at: job.heartbeat_at,
    created_at: job.created_at,
    episodeStatus,
    staleSeconds: briefJobStaleSeconds(),
    now: Date.now(),
    canRestart: opts.canRestart ?? false,
    rescheduled: opts.rescheduled ?? false,
  });
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
    // The column has no CHECK; a stage this code doesn't know is shown as it is stored.
    stage_label: isBriefJobStage(job.stage) ? BRIEF_JOB_STAGE_INFO[job.stage].label : String(job.stage),
    stalled: outlook.stalled,
    next_action: outlook.next_action,
    note: outlook.note,
    episode_status: episodeStatus,
  };
}

/**
 * The status report for the user's job, by job id or by the episode it produced; null when not found.
 * A status tool that should also keep the job moving uses findBriefJob, then maybeRescheduleBriefJob,
 * then describeBriefJob.
 */
export async function getBriefJobStatus(
  userId: string,
  lookup: BriefJobLookup,
  opts: DescribeBriefJobOptions = {}
): Promise<BriefJobStatus | null> {
  const job = await findBriefJob(userId, lookup);
  return job ? describeBriefJob(job, opts) : null;
}

/**
 * Schedules a runner for a job that needs one: still queued (its first runner never started), or running
 * with a heartbeat older than the stale window (its runner was cut off). Returns whether it scheduled.
 * Like scheduleBriefJob, call it inside a request scope. A runner it starts for a job someone else just
 * claimed loses the claim and stops, so calling it on every status poll is safe.
 */
export function maybeRescheduleBriefJob(job: Pick<BriefJobRow, "id" | "status" | "heartbeat_at">): boolean {
  // Queued always (its runner may still be about to start, and a second one just loses the claim); running
  // only once briefJobStalled, the same rule a status report's `stalled` uses, says its heartbeat is stale.
  const stale = job.status === "running" && briefJobStalled(job, briefJobStaleSeconds(), Date.now());
  if (job.status !== "queued" && !stale) return false;
  scheduleBriefJob(job.id);
  return true;
}
