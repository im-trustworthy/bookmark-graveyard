import { db } from "./supabase";
import { LINES_PER_CALL } from "./tts";

export async function signEpisodeUrls(episode: {
  markdown_path: string | null;
  audio_path: string | null;
  [k: string]: unknown;
}) {
  const storage = db().storage.from("episodes");
  const sign = async (path: string | null) =>
    path ? (await storage.createSignedUrl(path, 60 * 60 * 24)).data?.signedUrl ?? null : null;
  return {
    ...episode,
    markdown_url: await sign(episode.markdown_path),
    audio_url: await sign(episode.audio_path),
  };
}

// ---------------------------------------------------------------------------
// Resume support: derive where a staged brief generation left off from
// persisted episode state + what's actually landed in storage, so an
// interrupted generation (refresh, network blip, TTS hiccup) can pick back up
// without re-paying for work already done.
// ---------------------------------------------------------------------------

/** Strips the trailing `/brief.md` off a markdown_path to get the episode's storage folder. */
export function episodeBasePath(markdownPath: string): string {
  return markdownPath.replace(/\/brief\.md$/, "");
}

/**
 * Lists the start-index of every rendered chunk file under `<base>/chunks/`.
 * Chunk filenames are zero-padded start indices (see /api/digest/render), so
 * this is just parsing filenames — no audio inspection.
 */
export async function listChunkStarts(basePath: string): Promise<number[]> {
  const { data: files, error } = await db()
    .storage.from("episodes")
    .list(`${basePath}/chunks`, { limit: 1000 });
  if (error) throw new Error(`Chunk listing failed: ${error.message}`);
  return (files ?? [])
    .map((f) => parseInt(f.name, 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Best-effort delete of every storage object under an episode's folder
 * (markdown, any rendered chunks, and audio if present). Failures are logged
 * rather than thrown so a storage hiccup never blocks discarding the DB row —
 * the row is the source of truth for what's resumable/visible.
 */
export async function deleteEpisodeFolder(
  basePath: string,
  knownPaths: (string | null | undefined)[]
): Promise<void> {
  const storage = db().storage.from("episodes");
  const paths = new Set(knownPaths.filter((p): p is string => Boolean(p)));
  try {
    const { data: chunkFiles } = await storage.list(`${basePath}/chunks`, { limit: 1000 });
    for (const f of chunkFiles ?? []) paths.add(`${basePath}/chunks/${f.name}`);
  } catch (err) {
    console.error("deleteEpisodeFolder: chunk listing failed:", err);
  }
  if (paths.size === 0) return;
  const { error } = await storage.remove([...paths]);
  if (error) console.error("deleteEpisodeFolder: storage removal failed:", error);
}

export type DigestStage = "needs_script" | "rendering" | "needs_finalize" | "ready" | "none";

export interface DigestStageResult {
  stage: DigestStage;
  totalLines: number;
  nextCursor: number;
}

/**
 * Pure resume state machine — no I/O, so the cursor math is unit-testable in
 * isolation. Given an episode's persisted status/script and the chunk-file
 * start indices already in storage, decides which stage to resume from and
 * where.
 *
 * `nextCursor` is always "where /api/digest/render should resume from, or
 * totalLines if there's nothing left to render" — that lets a client drive
 * both the 'rendering' and 'needs_finalize' cases through the same
 * `while (cursor < totalLines)` loop without branching on stage.
 *
 * Resume-point rule: the LAST chunk's start index (not start+length). Chunk
 * uploads use upsert:true, and a chunk that was mid-upload when generation
 * was interrupted may be partial, so re-rendering it is always safe and
 * correct — whereas trusting it and skipping past it risks baking a
 * truncated segment into the final MP3. Once the highest chunk on record
 * covers through the end of the script, rendering is done (a render call
 * only ever returns success after its upload confirms), so resume goes
 * straight to 'needs_finalize' instead of redundantly redoing that chunk.
 */
export function deriveDigestStage(input: {
  status: string;
  scriptLength: number;
  chunkStarts: number[];
}): DigestStageResult {
  const { status, scriptLength, chunkStarts } = input;

  if (status === "ready") {
    return { stage: "ready", totalLines: scriptLength, nextCursor: scriptLength };
  }
  if (scriptLength === 0) {
    return { stage: "needs_script", totalLines: 0, nextCursor: 0 };
  }
  if (chunkStarts.length === 0) {
    return { stage: "rendering", totalLines: scriptLength, nextCursor: 0 };
  }

  const lastStart = Math.max(...chunkStarts);
  const renderedThroughEnd = lastStart + LINES_PER_CALL >= scriptLength;
  if (renderedThroughEnd) {
    return { stage: "needs_finalize", totalLines: scriptLength, nextCursor: scriptLength };
  }
  return { stage: "rendering", totalLines: scriptLength, nextCursor: lastStart };
}
