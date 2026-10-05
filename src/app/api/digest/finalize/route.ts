import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import { estimateDurationSeconds, LINES_PER_CALL } from "@/lib/tts";
import { mp3DurationSeconds, stripMp3Headers } from "@/lib/mp3";
import { signEpisodeUrls } from "@/lib/episodes";
import { apiError } from "@/lib/errors";
import type { ScriptLine } from "@/lib/brain";

export const maxDuration = 300;

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

// Stage 4 (audio): stitch rendered chunks into one MP3 and publish the episode.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { episodeId } = (await req.json()) as { episodeId?: string };
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  try {
    const { data: episode } = await db()
      .from("episodes")
      .select("*")
      .eq("user_id", userId)
      .eq("id", episodeId)
      .single();
    if (!episode?.markdown_path) {
      return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    }

    // Already published: hand back the existing episode rather than
    // re-stitching. Idempotent so a replayed/racing finalize call (e.g. a
    // second tab) is a no-op instead of an error.
    if (episode.status === "ready") {
      return NextResponse.json({ episode: await signEpisodeUrls(episode) });
    }
    // Only an unfinished draft is otherwise resumable.
    if (episode.status !== "draft") {
      return apiError("Digest finalize error", "episode not draft", "Episode is not resumable", 409);
    }

    const script = (episode.script ?? []) as ScriptLine[];

    const storage = db().storage.from("episodes");
    const base = episode.markdown_path.replace(/\/brief\.md$/, "");
    const { data: chunkFiles, error: listErr } = await storage.list(`${base}/chunks`, {
      limit: 1000,
      sortBy: { column: "name", order: "asc" },
    });
    if (listErr) throw new Error(listErr.message);
    if (!chunkFiles || chunkFiles.length === 0) {
      return NextResponse.json({ error: "No rendered audio chunks found" }, { status: 400 });
    }

    // Verify coverage before doing any concatenation/publishing work: a
    // replayed finalize, a client that skipped ahead, or an interrupted
    // render can all leave the chunk set short or gappy, and stitching that
    // would publish a truncated/broken brief as 'ready'.
    const sortedStarts = chunkFiles
      .map((f) => parseInt(f.name, 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (!hasCompleteCoverage(sortedStarts, script.length)) {
      return apiError(
        "Digest finalize error",
        `incomplete coverage: starts=[${sortedStarts.join(",")}] scriptLength=${script.length}`,
        "Audio is incomplete — resume rendering before finalizing",
        409
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

    return NextResponse.json({ episode: await signEpisodeUrls(updated) });
  } catch (err) {
    return apiError("Digest finalize error", err, "Finalize failed");
  }
}
