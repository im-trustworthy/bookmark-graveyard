import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import { estimateDurationSeconds } from "@/lib/tts";
import { signEpisodeUrls } from "@/lib/episodes";
import { apiError } from "@/lib/errors";
import type { ScriptLine } from "@/lib/brain";

export const maxDuration = 300;

// Stage 4 (audio): stitch rendered chunks into one MP3 and publish the episode.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { episodeId } = (await req.json()) as { episodeId?: string };
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  try {
    const { data: episode } = await db()
      .from("episodes")
      .select("id, script, markdown_path")
      .eq("user_id", userId)
      .eq("id", episodeId)
      .single();
    if (!episode?.markdown_path) {
      return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    }

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

    // MP3 segments share one fixed encoding, so byte concatenation is valid.
    const buffers: Buffer[] = [];
    for (const file of chunkFiles) {
      const { data, error } = await storage.download(`${base}/chunks/${file.name}`);
      if (error || !data) throw new Error(`Chunk download failed: ${error?.message}`);
      buffers.push(Buffer.from(await data.arrayBuffer()));
    }

    const audioPath = `${base}/brief.mp3`;
    const { error: upErr } = await storage.upload(audioPath, Buffer.concat(buffers), {
      contentType: "audio/mpeg",
      upsert: true,
    });
    if (upErr) throw new Error(`Audio upload failed: ${upErr.message}`);

    await storage.remove(chunkFiles.map((f) => `${base}/chunks/${f.name}`));

    const script = (episode.script ?? []) as ScriptLine[];
    const { data: updated, error } = await db()
      .from("episodes")
      .update({
        audio_path: audioPath,
        duration_seconds: estimateDurationSeconds(script),
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
