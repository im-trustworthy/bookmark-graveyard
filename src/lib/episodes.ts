import { db } from "./supabase";
import { deriveDigestStage, EPISODE_STATUS, scriptLengthOf } from "./state/episode";
import type { DigestStageResult } from "./state/episode";

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

// The stage vocabulary and the pure resume rule live in src/lib/state/episode.ts; re-exported so existing
// imports keep working.
export { deriveDigestStage } from "./state/episode";
export type { DigestStage, DigestStageResult } from "./state/episode";

/**
 * Where a brief stands and where it resumes, from its row plus the chunk files in storage. The one
 * place that decides when storage is worth listing: only for an unfinished episode with a script to
 * check chunk progress against (and a folder to look in). The status route and the job runner both
 * resume from this, so the Resume banner and a background run always agree.
 */
export async function resumePointFor(episode: {
  status: string;
  script: unknown;
  markdown_path: string | null;
}): Promise<DigestStageResult> {
  const scriptLength = scriptLengthOf(episode.script);
  const chunkStarts =
    episode.status !== EPISODE_STATUS.ready && scriptLength > 0 && episode.markdown_path
      ? await listChunkStarts(episodeBasePath(episode.markdown_path))
      : [];
  return deriveDigestStage({ status: episode.status, scriptLength, chunkStarts });
}
