import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import { writePodcastScript } from "@/lib/brain";

export const maxDuration = 300;

// Stage 2 (audio): turn the prepared markdown into the two-host script.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { episodeId, targetMinutes } = (await req.json()) as {
    episodeId?: string;
    targetMinutes?: number;
  };
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  try {
    const { data: episode } = await db()
      .from("episodes")
      .select("id, markdown_path, status")
      .eq("user_id", userId)
      .eq("id", episodeId)
      .single();
    if (!episode?.markdown_path) {
      return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    }

    const { data: mdFile, error: dlErr } = await db()
      .storage.from("episodes")
      .download(episode.markdown_path);
    if (dlErr || !mdFile) throw new Error(`Markdown download failed: ${dlErr?.message}`);
    const markdown = await mdFile.text();

    const script = await writePodcastScript(
      markdown,
      Math.min(Math.max(targetMinutes ?? 20, 5), 30)
    );
    if (script.length === 0) throw new Error("Script generation returned no lines");

    const { error } = await db()
      .from("episodes")
      .update({ script })
      .eq("user_id", userId)
      .eq("id", episodeId);
    if (error) throw new Error(error.message);

    return NextResponse.json({ totalLines: script.length });
  } catch (err) {
    console.error("Digest script error:", err);
    const message = err instanceof Error ? err.message : "Script generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
