import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import { renderPodcast, LINES_PER_CALL } from "@/lib/tts";
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
      .select("id, script, markdown_path")
      .eq("user_id", userId)
      .eq("id", episodeId)
      .single();
    const script = (episode?.script ?? []) as ScriptLine[];
    if (!episode || script.length === 0) {
      return NextResponse.json({ error: "Episode has no script" }, { status: 404 });
    }

    const start = Math.max(0, cursor);
    const chunk = script.slice(start, start + LINES_PER_CALL);
    if (chunk.length === 0) {
      return NextResponse.json({ nextCursor: script.length, totalLines: script.length, done: true });
    }

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
    return NextResponse.json({
      nextCursor,
      totalLines: script.length,
      done: nextCursor >= script.length,
    });
  } catch (err) {
    return apiError("Digest render error", err, "Audio rendering failed");
  }
}
