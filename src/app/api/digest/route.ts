import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import {
  selectBookmarksForDigest,
  stalenessPass,
  writeMarkdownDigest,
  writePodcastScript,
} from "@/lib/brain";
import { estimateDurationSeconds, renderPodcast } from "@/lib/tts";
import { signEpisodeUrls } from "@/lib/episodes";

export const maxDuration = 800;

interface DigestRequest {
  format: "markdown" | "audio" | "both";
  from?: string;
  to?: string;
  topics?: string[];
  targetMinutes?: number;
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const body = (await req.json()) as DigestRequest;
  const format = ["markdown", "audio", "both"].includes(body.format) ? body.format : "both";
  const targetMinutes = Math.min(Math.max(body.targetMinutes ?? 20, 5), 30);

  try {
    const { included, excludedAsMisleading } = await selectBookmarksForDigest(userId, body);
    if (included.length === 0) {
      return NextResponse.json(
        { error: "No bookmarks match these filters. Try widening the date range or syncing first." },
        { status: 400 }
      );
    }

    const verdicts = await stalenessPass(included);
    const markdown = await writeMarkdownDigest(included, verdicts, excludedAsMisleading, {
      from: body.from,
      to: body.to,
    });

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const base = `${userId}/${stamp}`;
    const storage = db().storage.from("episodes");

    const markdownPath = `${base}/brief.md`;
    const { error: mdErr } = await storage.upload(markdownPath, Buffer.from(markdown, "utf8"), {
      contentType: "text/markdown",
    });
    if (mdErr) throw new Error(`Markdown upload failed: ${mdErr.message}`);

    let audioPath: string | null = null;
    let durationSeconds: number | null = null;
    if (format !== "markdown") {
      const script = await writePodcastScript(markdown, targetMinutes);
      const mp3 = await renderPodcast(script);
      durationSeconds = estimateDurationSeconds(script);
      audioPath = `${base}/brief.mp3`;
      const { error: mp3Err } = await storage.upload(audioPath, mp3, {
        contentType: "audio/mpeg",
      });
      if (mp3Err) throw new Error(`Audio upload failed: ${mp3Err.message}`);
    }

    const dropped = included.filter((b) => verdicts.get(b.tweet_id) === "stale").length;
    const title = `Bookmark Brief — ${new Date().toLocaleDateString("en-US", {
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
        date_from: body.from ?? null,
        date_to: body.to ?? null,
        topics: body.topics ?? [],
        markdown_path: markdownPath,
        audio_path: audioPath,
        duration_seconds: durationSeconds,
        bookmark_count: included.length - dropped,
      })
      .select()
      .single();
    if (epErr) throw new Error(`Episode save failed: ${epErr.message}`);

    const signed = await signEpisodeUrls(episode);
    return NextResponse.json({
      episode: signed,
      markdown,
      stats: {
        considered: included.length,
        droppedAsStale: dropped,
        excludedAsMisleading: excludedAsMisleading.length,
      },
    });
  } catch (err) {
    console.error("Digest error:", err);
    const message = err instanceof Error ? err.message : "Digest generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
