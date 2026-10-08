import "server-only";
import { db } from "./supabase";

// How full this instance's Supabase project is, and pruning of old podcast
// audio before the plan limits break uploads. File storage is the limit that
// bites (a 15-minute brief's MP3 is ~13.5 MB against the free tier's 1 GiB),
// while the database is mostly fixed overhead against its 500 MiB, so it only
// ever warns. Usage is measured on every call through the storage_usage_bytes /
// database_size_bytes functions (service role only); nothing is cached.

const BUCKET = "episodes";
/** At or above this share of a limit the level is "warn"; pruning aims back down to it. */
const WARN_RATIO = 0.8;
/** At or above this share it's "critical": new audio has to make room first. */
const CRITICAL_RATIO = 0.9;
/** Byte rate of a brief's CBR 128 kbps MP3, for estimating a file from its duration. */
const MP3_BYTES_PER_SECOND = 16_000;
const DEFAULT_STORAGE_LIMIT = 1024 ** 3; // Supabase free tier: 1 GiB of file storage
const DEFAULT_DATABASE_LIMIT = 500 * 1024 ** 2; // and a 500 MiB database
const DEFAULT_KEEP_RECENT = 4;
const OFF = new Set(["0", "false", "no", "off"]);

export type CapacityLevel = "ok" | "warn" | "critical";

export interface CapacityReport {
  storage: { usedBytes: number; limitBytes: number; ratio: number };
  database: { usedBytes: number; limitBytes: number; ratio: number };
  /** The worse of the two. */
  level: CapacityLevel;
  /** AUTO_PRUNE_AUDIO: whether new audio may remove the oldest to make room. */
  autoPrune: boolean;
  /** KEEP_RECENT_AUDIO: how many of each person's newest briefs always keep their audio. */
  keepRecent: number;
  /** What to do about it; null while both are under 80%. */
  recommendation: string | null;
}

export interface PrunedEpisode {
  episodeId: string;
  userId: string;
  title: string;
  createdAt: string;
}

export interface PruneResult {
  pruned: PrunedEpisode[];
  /** Storage in use afterwards: measured, or for a dry run estimated from the pruned briefs' durations. */
  usedBytes: number;
}

/** New audio doesn't fit and pruning can't (or may not) make room. The finalize route answers 507. */
export class CapacityError extends Error {
  name = "CapacityError";
}

interface Settings {
  storageLimit: number;
  databaseLimit: number;
  autoPrune: boolean;
  keepRecent: number;
}

/** Read on every call, never at import. */
function settings(): Settings {
  const bytes = "a positive number of bytes, e.g. 1073741824";
  return {
    storageLimit: envNumber("STORAGE_LIMIT_BYTES", DEFAULT_STORAGE_LIMIT, (n) => n > 0, bytes),
    databaseLimit: envNumber("DATABASE_LIMIT_BYTES", DEFAULT_DATABASE_LIMIT, (n) => n > 0, bytes),
    autoPrune: !OFF.has(process.env.AUTO_PRUNE_AUDIO?.trim().toLowerCase() ?? ""),
    keepRecent: envNumber(
      "KEEP_RECENT_AUDIO",
      DEFAULT_KEEP_RECENT,
      (n) => Number.isInteger(n) && n >= 0,
      "a whole number of briefs, e.g. 4"
    ),
  };
}

/**
 * Unset or blank means the default. Anything else that doesn't parse throws
 * instead of falling back: a mistyped limit silently becoming the free tier's
 * 1 GiB would prune a bigger instance's audio.
 */
function envNumber(name: string, fallback: number, valid: (n: number) => boolean, expected: string): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !valid(n)) throw new Error(`Invalid ${name} "${raw}": use ${expected}`);
  return n;
}

async function measure(fn: "storage_usage_bytes" | "database_size_bytes"): Promise<number> {
  const { data, error } = await db().rpc(fn);
  if (error) throw new Error(`${fn}() failed: ${error.message}`);
  const bytes = Number(data); // bigint may arrive as a string
  if (!Number.isFinite(bytes)) throw new Error(`${fn}() returned ${JSON.stringify(data)}`);
  return bytes;
}

function levelOf(ratio: number): CapacityLevel {
  return ratio >= CRITICAL_RATIO ? "critical" : ratio >= WARN_RATIO ? "warn" : "ok";
}

const percent = (ratio: number) => Math.round(ratio * 100);

function keptNote(keepRecent: number): string {
  if (keepRecent === 0) return "";
  return keepRecent === 1
    ? " (the newest brief per person is always kept)"
    : ` (the newest ${keepRecent} briefs per person are always kept)`;
}

function storageAdvice(ratio: number, { autoPrune, keepRecent }: Settings): string | null {
  const level = levelOf(ratio);
  if (level === "ok") return null;
  const used = percent(ratio);
  if (level === "warn") {
    return autoPrune
      ? `Storage is ${used}% full. Oldest podcast audio is removed automatically once it reaches ${percent(CRITICAL_RATIO)}%${keptNote(keepRecent)}.`
      : `Storage is ${used}% full. Free up space by removing old podcast audio, or raise STORAGE_LIMIT_BYTES.`;
  }
  return autoPrune
    ? `Storage is almost full (${used}%). Oldest podcast audio is removed automatically before the next brief is saved${keptNote(keepRecent)}.`
    : `Storage is almost full (${used}%) — new podcast audio will be refused until space is freed. Remove old podcast audio, or raise STORAGE_LIMIT_BYTES.`;
}

// Never pruned automatically: what's in there is the bookmarks themselves.
function databaseAdvice(ratio: number): string | null {
  const level = levelOf(ratio);
  if (level === "ok") return null;
  const used = percent(ratio);
  const full = level === "warn" ? `is ${used}% full` : `is almost full (${used}%)`;
  return `The database ${full}. Bookmark data is never pruned automatically — upgrade the Supabase plan, or raise DATABASE_LIMIT_BYTES if your plan allows more.`;
}

export async function getCapacity(): Promise<CapacityReport> {
  const config = settings();
  const [storageUsed, databaseUsed] = await Promise.all([
    measure("storage_usage_bytes"),
    measure("database_size_bytes"),
  ]);
  const storage = { usedBytes: storageUsed, limitBytes: config.storageLimit, ratio: storageUsed / config.storageLimit };
  const database = {
    usedBytes: databaseUsed,
    limitBytes: config.databaseLimit,
    ratio: databaseUsed / config.databaseLimit,
  };
  const advice = [storageAdvice(storage.ratio, config), databaseAdvice(database.ratio)].filter(Boolean);
  return {
    storage,
    database,
    level: levelOf(Math.max(storage.ratio, database.ratio)), // same thresholds, so the worse level
    autoPrune: config.autoPrune,
    keepRecent: config.keepRecent,
    recommendation: advice.length > 0 ? advice.join(" ") : null,
  };
}

interface AudioEpisode {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  audio_path: string;
  duration_seconds: number | null;
}

/**
 * Finished briefs that still have audio, oldest first, minus each person's
 * newest `keepRecent`. Ordered in the query too, so if the API's row cap ever
 * truncates the list it drops the newest rows: ranks counted within what's
 * returned can then only overstate how recent a brief is, never prune a kept one.
 */
async function pruneCandidates(keepRecent: number, userId?: string): Promise<AudioEpisode[]> {
  let query = db()
    .from("episodes")
    .select("id, user_id, title, created_at, audio_path, duration_seconds")
    .eq("status", "ready")
    .not("audio_path", "is", null)
    .order("created_at", { ascending: true });
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;
  if (error) throw new Error(`Audio episode lookup failed: ${error.message}`);

  const newestFirst = ((data ?? []) as AudioEpisode[]).sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
  );
  const seen = new Map<string, number>();
  const candidates = newestFirst.filter((episode) => {
    const rank = (seen.get(episode.user_id) ?? 0) + 1;
    seen.set(episode.user_id, rank);
    return rank > keepRecent;
  });
  return candidates.reverse();
}

// The file goes first: a row marked pruned while its MP3 survived would be
// invisible to every later prune. brief.md and the row itself always stay.
async function removeAudio(episode: AudioEpisode): Promise<void> {
  const { error: removeError } = await db().storage.from(BUCKET).remove([episode.audio_path]);
  if (removeError) throw new Error(`Removing ${episode.audio_path} failed: ${removeError.message}`);
  const { error } = await db()
    .from("episodes")
    .update({ audio_path: null, audio_pruned_at: new Date().toISOString() })
    .eq("id", episode.id)
    .eq("user_id", episode.user_id);
  if (error) throw new Error(`Marking episode ${episode.id} pruned failed: ${error.message}`);
}

/**
 * Removes podcast audio, oldest first, until storage is at or under
 * `targetBytes` (default: 80% of STORAGE_LIMIT_BYTES) or nothing prunable is
 * left. Each person's newest KEEP_RECENT_AUDIO briefs with audio are never
 * candidates; with `userId`, only that person's audio is (usage and target
 * stay instance-wide). Usage is re-measured after every removal. `dryRun`
 * touches nothing and instead subtracts each file's size estimated from its
 * duration.
 */
export async function pruneAudio(
  opts: { userId?: string; targetBytes?: number; dryRun?: boolean } = {}
): Promise<PruneResult> {
  const { storageLimit, keepRecent } = settings();
  const target = opts.targetBytes ?? WARN_RATIO * storageLimit;
  let usedBytes = await measure("storage_usage_bytes");
  const pruned: PrunedEpisode[] = [];
  if (usedBytes <= target) return { pruned, usedBytes };

  for (const episode of await pruneCandidates(keepRecent, opts.userId)) {
    if (usedBytes <= target) break;
    if (opts.dryRun) {
      usedBytes = Math.max(0, usedBytes - (episode.duration_seconds ?? 0) * MP3_BYTES_PER_SECOND);
    } else {
      await removeAudio(episode);
      usedBytes = await measure("storage_usage_bytes");
    }
    const { id: episodeId, user_id: userId, title, created_at: createdAt } = episode;
    pruned.push({ episodeId, userId, title, createdAt });
  }
  return { pruned, usedBytes };
}

/**
 * Makes room for `bytes` of new audio before it's uploaded. If that would take
 * storage past 90%, prunes the oldest audio instance-wide down to 80% minus the
 * new file (when AUTO_PRUNE_AUDIO allows), and throws CapacityError if it
 * still doesn't fit. When usage can't be measured at all (say the capacity
 * migration isn't applied yet, or a limit is mistyped) it logs and lets the
 * upload go ahead: a gap in monitoring shouldn't become the wall it guards
 * against, and nothing is pruned on a guess.
 */
export async function ensureRoomFor(bytes: number): Promise<void> {
  let config: Settings;
  let usedBytes: number;
  try {
    config = settings();
    usedBytes = await measure("storage_usage_bytes");
  } catch (err) {
    console.error("Capacity check skipped:", err);
    return;
  }
  const ceiling = CRITICAL_RATIO * config.storageLimit;
  if (usedBytes + bytes <= ceiling) return;
  if (config.autoPrune) {
    ({ usedBytes } = await pruneAudio({ targetBytes: WARN_RATIO * config.storageLimit - bytes }));
    if (usedBytes + bytes <= ceiling) return;
  }
  const full = `Storage is ${percent(usedBytes / config.storageLimit)}% full`;
  throw new CapacityError(
    config.autoPrune
      ? `${full} and no more old podcast audio can be removed — raise STORAGE_LIMIT_BYTES or lower KEEP_RECENT_AUDIO`
      : `${full}, too full for this brief's audio — remove old podcast audio under Previous briefs, or raise STORAGE_LIMIT_BYTES`
  );
}
