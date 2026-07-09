import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import { renderPodcast, LINES_PER_CALL } from "@/lib/tts";
import { checkUsage } from "@/lib/limits";
import { apiError } from "@/lib/errors";
import type { ScriptLine } from "@/lib/brain";

export const maxDuration = 300;

// Stage 3 (audio): render the next chunk of script lines to an MP3 segment.
// The client loops, advancing `cursor`, so each request stays ~30-60s.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { episodeId, cursor = 0 } = (await req.json()) as { episodeId?: string; cursor?: number };
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  try {
    const { data: episode } = await db()
      .from("episodes")
      .select("id, script, markdown_path, status, render_cursor")
      .eq("user_id", userId)
      .eq("id", episodeId)
      .single();
    const script = (episode?.script ?? []) as ScriptLine[];
    if (!episode || script.length === 0) {
      return NextResponse.json({ error: "Episode has no script" }, { status: 404 });
    }
    // Only an unfinished draft is resumable — a 'ready' episode's script is
    // never cleared, so without this a replayed/late call would silently
    // re-render (and re-bill) audio against a finished brief.
    if (episode.status !== "draft") {
      return apiError("Digest render error", "episode not draft", "Episode is not resumable", 409);
    }

    const start = Math.max(0, cursor);

    // Forward-only: render_cursor is a persisted high-water mark, so only the
    // current frontier chunk (one chunk-width behind it) may be re-rendered —
    // that's exactly the "redo the last, possibly-partial chunk" resume move
    // the client makes (see deriveDigestStage). Anything further back is a
    // replay (stale tab, leaked session, retried request) against a chunk
    // that's already landed and already been paid for.
    if (start < episode.render_cursor - LINES_PER_CALL) {
      return apiError("Digest render error", "stale render cursor", "Stale render cursor", 409);
    }

    const chunk = script.slice(start, start + LINES_PER_CALL);
    if (chunk.length === 0) {
      return NextResponse.json({ nextCursor: script.length, totalLines: script.length, done: true });
    }

    // Gate right before the paid ElevenLabs call, after all the free checks above.
    await checkUsage(userId, "digest_render");

    // Pass neighbors for prosody continuity across chunk boundaries
    const mp3 = await renderPodcast(chunk, undefined, {
      previousLine: script[start - 1]?.line,
      nextLine: script[start + chunk.length]?.line,
    });

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

    return NextResponse.json({
      nextCursor,
      totalLines: script.length,
      done: nextCursor >= script.length,
    });
  } catch (err) {
    return apiError("Digest render error", err, "Audio rendering failed");
  }
}
