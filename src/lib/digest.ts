import "server-only";
import { db } from "./supabase";
import {
  selectBookmarksForDigest,
  stalenessPass,
  writeMarkdownDigest,
  writePodcastScript,
} from "./brain";
import type { ScriptLine } from "./brain";
import { ensureRoomFor } from "./capacity";
import { signEpisodeUrls } from "./episodes";
import { checkUsage } from "./limits";
import { mp3DurationSeconds, stripMp3Headers } from "./mp3";
import { estimateDurationSeconds, LINES_PER_CALL, renderPodcast } from "./tts";
import { isTtsReady } from "./voice";
import type { VoiceConfig } from "./voice";
import { getVoiceProviderForUser, pinnedVoiceFrom, resolveVoiceConfigForUser } from "./voice/user";

// The four stages of a brief, as plain functions of data: no request, no response. The /api/digest/*
// routes are thin wrappers (parse the request, call a stage, map errors), and a background job can drive
// the same stages without a request. Every guard sits exactly where the routes had it relative to the
// paid calls: the draft-only resume check, the forward-only render cursor, the idempotent finalize, the
// coverage check before stitching, checkUsage right before each paid call, the voice resolved before the
// usage gate, ensureRoomFor before the audio upload.

/**
 * A stage refusing to continue for a reason the caller shows as is (not found, not resumable, nothing
 * to select). It carries the HTTP status the route answers with and the message that is safe to show.
 * `logDetail` set means the route logs it and, outside production, appends it to the response, the way
 * apiError does; unset means a plain answer that is not logged.
 *
 * Failures that the routes map by class (UsageLimitError, VoiceConfigError, InvalidVoiceKeyError,
 * VoiceVendorError, CapacityError) are not wrapped: they propagate as themselves.
 */
export class DigestStageError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  readonly logDetail?: string;

  constructor(status: number, publicMessage: string, logDetail?: string) {
    super(publicMessage);
    this.name = "DigestStageError";
    this.status = status;
    this.publicMessage = publicMessage;
    this.logDetail = logDetail;
  }
}

/** An episode as the dashboard receives it: the row plus freshly signed file URLs. */
export type SignedEpisode = Awaited<ReturnType<typeof signEpisodeUrls>>;

// ---------------------------------------------------------------------------
// Stage 1: prepare (select -> freshness -> outline -> compose markdown)
// ---------------------------------------------------------------------------

export interface PrepareRequest {
  // "audio" requests are normalized to "both" in validatePrepareInput, so only these two are ever stored.
  format: "markdown" | "both";
  from?: string;
  to?: string;
  topics?: string[];
  tweetIds?: string[];
  targetMinutes?: number;
}

export interface PrepareResult {
  episode: SignedEpisode;
  markdown: string;
  /** True for a markdown-only brief, which is complete here; a podcast continues to scriptBrief. */
  done: boolean;
  stats: { considered: number; droppedAsStale: number; excludedAsMisleading: number };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TWEET_IDS = 500;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Lightweight hand-rolled validation (no schema lib) — the request shape is
 * small and fixed, so a few explicit checks are clearer than a dependency.
 */
export function validatePrepareInput(body: unknown): { value: PrepareRequest } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid request body" };
  const b = body as Record<string, unknown>;

  if (b.from !== undefined && (typeof b.from !== "string" || !DATE_RE.test(b.from))) {
    return { error: "from must be a YYYY-MM-DD date" };
  }
  if (b.to !== undefined && (typeof b.to !== "string" || !DATE_RE.test(b.to))) {
    return { error: "to must be a YYYY-MM-DD date" };
  }
  if (b.topics !== undefined && !isStringArray(b.topics)) {
    return { error: "topics must be an array of strings" };
  }
  if (b.tweetIds !== undefined) {
    if (!isStringArray(b.tweetIds)) return { error: "tweetIds must be an array of strings" };
    if (b.tweetIds.length > MAX_TWEET_IDS) {
      return { error: `tweetIds cannot exceed ${MAX_TWEET_IDS} items` };
    }
  }
  if (b.targetMinutes !== undefined && typeof b.targetMinutes !== "number") {
    return { error: "targetMinutes must be a number" };
  }

  // The server still accepts "markdown", "audio" and "both". "audio" behaves as "both": the markdown is
  // produced first either way and the podcast script is derived from it, so audio-only was never really
  // audio-only. The picker no longer offers it, but old clients may still send it. Anything else
  // unrecognised also falls back to "both".
  const format: PrepareRequest["format"] = b.format === "markdown" ? "markdown" : "both";

  return {
    value: {
      format,
      from: b.from as string | undefined,
      to: b.to as string | undefined,
      topics: b.topics as string[] | undefined,
      tweetIds: b.tweetIds as string[] | undefined,
      targetMinutes: b.targetMinutes as number | undefined,
    },
  };
}

/**
 * Selects the bookmarks, runs the staleness pass, writes the markdown brief and saves the episode. A
 * markdown-only brief is `ready` on return; a podcast is a `draft` the caller continues with scriptBrief.
 * Throws DigestStageError for an unusable voice setup or an empty selection, VoiceConfigError for a broken
 * one, UsageLimitError when the day's allowance is spent.
 */
export async function prepareBrief(userId: string, params: PrepareRequest): Promise<PrepareResult> {
  const format = params.format;

  // Before any paid work: without a voice provider an audio brief would burn
  // a digest_prepare slot and the Grok writing pass, then fail at render.
  let voice: VoiceConfig | null = null;
  if (format === "both") {
    // A broken voice setup throws VoiceConfigError, which names the setting to fix (never a secret).
    voice = await resolveVoiceConfigForUser(userId);
    if (!isTtsReady(voice)) {
      // Non-null but not ready means ElevenLabs with a key and no host voices (Grok voices have defaults).
      const message = voice
        ? "ElevenLabs voices aren't set — choose voices under Voices, or set ELEVENLABS_VOICE_HOST_A and ELEVENLABS_VOICE_HOST_B on the server"
        : "Audio briefs need a voice provider — connect Grok Voice or ElevenLabs under Voices, or set VOICE_PROVIDER on the server, or choose a markdown-only brief";
      throw new DigestStageError(400, message, message);
    }
  }

  const { included, excludedAsMisleading } = await selectBookmarksForDigest(userId, params);
  if (included.length === 0) {
    throw new DigestStageError(400, "No bookmarks match these filters. Try widening the date range or syncing first.");
  }

  // Gates the whole pipeline: script/render/finalize don't re-check, so a
  // resumed generation never burns another slot — only fresh briefs do.
  // Checked after the (free, DB-only) selection so empty-filter misses don't
  // consume a daily slot, but before the first paid Grok call below.
  await checkUsage(userId, "digest_prepare");

  const verdicts = await stalenessPass(included);
  const markdown = await writeMarkdownDigest(userId, included, verdicts, excludedAsMisleading, {
    from: params.from,
    to: params.to,
  });

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const markdownPath = `${userId}/${stamp}/brief.md`;
  const { error: mdErr } = await db()
    .storage.from("episodes")
    .upload(markdownPath, Buffer.from(markdown, "utf8"), { contentType: "text/markdown" });
  if (mdErr) throw new Error(`Markdown upload failed: ${mdErr.message}`);

  const dropped = included.filter((b) => verdicts.get(b.tweet_id) === "stale").length;
  const markdownOnly = format === "markdown";
  const title = `Bookmark Graveyard — ${new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  })}`;

  const { data: episode, error: epErr } = await db()
    .from("episodes")
    .insert({
      user_id: userId,
      title,
      format,
      status: markdownOnly ? "ready" : "draft",
      date_from: params.from ?? null,
      date_to: params.to ?? null,
      topics: params.topics ?? [],
      markdown_path: markdownPath,
      bookmark_count: included.length - dropped,
      // Pin the voices this brief starts with, so a resumed render finishes in them.
      voice: voice ? { provider: voice.provider, voiceA: voice.voiceA, voiceB: voice.voiceB } : null,
    })
    .select()
    .single();
  if (epErr) throw new Error(`Episode save failed: ${epErr.message}`);

  return {
    episode: await signEpisodeUrls(episode),
    markdown,
    done: markdownOnly,
    stats: {
      considered: included.length,
      droppedAsStale: dropped,
      excludedAsMisleading: excludedAsMisleading.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 2 (audio): turn the prepared markdown into the two-host script
// ---------------------------------------------------------------------------

/** Writes the two-host script for a draft episode and saves it. `targetMinutes` is clamped to 5-30, default 20. */
export async function scriptBrief(
  userId: string,
  episodeId: string,
  targetMinutes?: number
): Promise<{ totalLines: number }> {
  const { data: episode } = await db()
    .from("episodes")
    .select("id, markdown_path, status")
    .eq("user_id", userId)
    .eq("id", episodeId)
    .single();
  if (!episode?.markdown_path) throw new DigestStageError(404, "Episode not found");
  // Only an unfinished draft is resumable — a 'ready' episode's script is
  // never cleared, so without this a replayed/late call would silently
  // re-run (and re-bill) script generation against a finished brief.
  if (episode.status !== "draft") throw new DigestStageError(409, "Episode is not resumable", "episode not draft");

  const { data: mdFile, error: dlErr } = await db().storage.from("episodes").download(episode.markdown_path);
  if (dlErr || !mdFile) throw new Error(`Markdown download failed: ${dlErr?.message}`);
  const markdown = await mdFile.text();

  // Gate right before the paid Grok call, after the free DB/storage reads above.
  await checkUsage(userId, "digest_script");

  const script = await writePodcastScript(markdown, Math.min(Math.max(targetMinutes ?? 20, 5), 30));
  if (script.length === 0) throw new Error("Script generation returned no lines");

  const { error } = await db().from("episodes").update({ script }).eq("user_id", userId).eq("id", episodeId);
  if (error) throw new Error(error.message);

  return { totalLines: script.length };
}

// ---------------------------------------------------------------------------
// Stage 3 (audio): render the next chunk of script lines to an MP3 segment
// ---------------------------------------------------------------------------

/**
 * Renders the script lines from `cursor` (one chunk of LINES_PER_CALL) to an MP3 segment in storage and
 * advances the episode's persisted render cursor. The caller loops with the returned `nextCursor` until
 * `done`, so each call stays short.
 */
export async function renderChunk(
  userId: string,
  episodeId: string,
  cursor: number
): Promise<{ nextCursor: number; totalLines: number; done: boolean }> {
  const { data: episode } = await db()
    .from("episodes")
    .select("id, script, markdown_path, status, render_cursor, voice")
    .eq("user_id", userId)
    .eq("id", episodeId)
    .single();
  const script = (episode?.script ?? []) as ScriptLine[];
  if (!episode || script.length === 0) throw new DigestStageError(404, "Episode has no script");
  // Only an unfinished draft is resumable — a 'ready' episode's script is
  // never cleared, so without this a replayed/late call would silently
  // re-render (and re-bill) audio against a finished brief.
  if (episode.status !== "draft") throw new DigestStageError(409, "Episode is not resumable", "episode not draft");

  const start = Math.max(0, cursor);

  // Forward-only: render_cursor is a persisted high-water mark, so only the
  // current frontier chunk (one chunk-width behind it) may be re-rendered —
  // that's exactly the "redo the last, possibly-partial chunk" resume move
  // the client makes (see deriveDigestStage). Anything further back is a
  // replay (stale tab, leaked session, retried request) against a chunk
  // that's already landed and already been paid for.
  if (start < episode.render_cursor - LINES_PER_CALL) {
    throw new DigestStageError(409, "Stale render cursor", "stale render cursor");
  }

  const chunk = script.slice(start, start + LINES_PER_CALL);
  if (chunk.length === 0) return { nextCursor: script.length, totalLines: script.length, done: true };

  // The voices this episode started with (when pinned), with the user's key or
  // the instance's. Resolved before the usage gate so a broken voice config
  // doesn't burn a slot on every retry.
  const provider = await getVoiceProviderForUser(userId, pinnedVoiceFrom(episode.voice));

  // Gate right before the paid TTS call, after all the free checks above.
  await checkUsage(userId, "digest_render");

  // Pass neighbors for prosody continuity across chunk boundaries
  const mp3 = await renderPodcast(
    chunk,
    undefined,
    { previousLine: script[start - 1]?.line, nextLine: script[start + chunk.length]?.line },
    provider
  );

  const base = episode.markdown_path!.replace(/\/brief\.md$/, "");
  const chunkPath = `${base}/chunks/${String(start).padStart(5, "0")}.mp3`;
  const { error } = await db()
    .storage.from("episodes")
    .upload(chunkPath, mp3, { contentType: "audio/mpeg", upsert: true });
  if (error) throw new Error(`Chunk upload failed: ${error.message}`);

  const nextCursor = start + chunk.length;

  // Guarded update: only ever advances render_cursor, never regresses it.
  // The `lt` filter is evaluated against the live row at execution time, so
  // this stays a correct monotonic high-water mark even if two chunk
  // uploads for the same episode race (e.g. two tabs both resuming).
  const { error: cursorErr } = await db()
    .from("episodes")
    .update({ render_cursor: nextCursor })
    .eq("user_id", userId)
    .eq("id", episodeId)
    .lt("render_cursor", nextCursor);
  if (cursorErr) throw new Error(`Cursor update failed: ${cursorErr.message}`);

  return { nextCursor, totalLines: script.length, done: nextCursor >= script.length };
}

// ---------------------------------------------------------------------------
// Stage 4 (audio): stitch rendered chunks into one MP3 and publish the episode
// ---------------------------------------------------------------------------

// A complete render is chunk starts 0, LINES_PER_CALL, 2*LINES_PER_CALL, ...
// with no gaps, and the last chunk must reach the end of the script — mirrors
// the "renderedThroughEnd" rule in deriveDigestStage (src/lib/episodes.ts).
function hasCompleteCoverage(sortedStarts: number[], scriptLength: number): boolean {
  if (sortedStarts.length === 0) return false;
  for (let i = 0; i < sortedStarts.length; i++) {
    if (sortedStarts[i] !== i * LINES_PER_CALL) return false;
  }
  return sortedStarts[sortedStarts.length - 1] + LINES_PER_CALL >= scriptLength;
}

/**
 * Stitches the rendered chunks into brief.mp3 and marks the episode `ready`. Idempotent: an episode that
 * is already `ready` is returned as is. Throws CapacityError when storage has no room for the audio.
 */
export async function finalizeBrief(userId: string, episodeId: string): Promise<{ episode: SignedEpisode }> {
  const { data: episode } = await db()
    .from("episodes")
    .select("*")
    .eq("user_id", userId)
    .eq("id", episodeId)
    .single();
  if (!episode?.markdown_path) throw new DigestStageError(404, "Episode not found");

  // Already published: hand back the existing episode rather than
  // re-stitching. Idempotent so a replayed/racing finalize call (e.g. a
  // second tab) is a no-op instead of an error.
  if (episode.status === "ready") return { episode: await signEpisodeUrls(episode) };
  // Only an unfinished draft is otherwise resumable.
  if (episode.status !== "draft") throw new DigestStageError(409, "Episode is not resumable", "episode not draft");

  const script = (episode.script ?? []) as ScriptLine[];

  const storage = db().storage.from("episodes");
  const base = episode.markdown_path.replace(/\/brief\.md$/, "");
  const { data: chunkFiles, error: listErr } = await storage.list(`${base}/chunks`, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (listErr) throw new Error(listErr.message);
  if (!chunkFiles || chunkFiles.length === 0) throw new DigestStageError(400, "No rendered audio chunks found");

  // Verify coverage before doing any concatenation/publishing work: a
  // replayed finalize, a client that skipped ahead, or an interrupted
  // render can all leave the chunk set short or gappy, and stitching that
  // would publish a truncated/broken brief as 'ready'.
  const sortedStarts = chunkFiles
    .map((f) => parseInt(f.name, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!hasCompleteCoverage(sortedStarts, script.length)) {
    throw new DigestStageError(
      409,
      "Audio is incomplete — resume rendering before finalizing",
      `incomplete coverage: starts=[${sortedStarts.join(",")}] scriptLength=${script.length}`
    );
  }

  // Chunks share one fixed CBR encoding, so byte concatenation is valid.
  // Chunks are rendered header-free (src/lib/tts.ts); stripping again here
  // keeps chunks from an older deploy from reintroducing mid-stream Info
  // headers that break seeking. Idempotent on clean input.
  const buffers: Buffer[] = [];
  for (const file of chunkFiles) {
    const { data, error } = await storage.download(`${base}/chunks/${file.name}`);
    if (error || !data) throw new Error(`Chunk download failed: ${error?.message}`);
    buffers.push(Buffer.from(await data.arrayBuffer()));
  }
  const audio = stripMp3Headers(Buffer.concat(buffers));

  // Past 90% full this prunes the oldest podcast audio first, or refuses
  // (CapacityError → 507) while the chunks stay put for a later resume,
  // instead of letting the upload run into the plan's storage limit.
  await ensureRoomFor(audio.length);

  const audioPath = `${base}/brief.mp3`;
  const { error: upErr } = await storage.upload(audioPath, audio, {
    contentType: "audio/mpeg",
    upsert: true,
  });
  if (upErr) throw new Error(`Audio upload failed: ${upErr.message}`);

  await storage.remove(chunkFiles.map((f) => `${base}/chunks/${f.name}`));

  const { data: updated, error } = await db()
    .from("episodes")
    .update({
      audio_path: audioPath,
      // Real length from the frames we just stitched; the word-count estimate is
      // only a fallback if the parser somehow finds no frames.
      duration_seconds: Math.round(mp3DurationSeconds(audio)) || estimateDurationSeconds(script),
      status: "ready",
    })
    .eq("user_id", userId)
    .eq("id", episodeId)
    .select()
    .single();
  if (error) throw new Error(error.message);

  return { episode: await signEpisodeUrls(updated) };
}
