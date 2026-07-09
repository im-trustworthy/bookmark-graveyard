import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import {
  selectBookmarksForDigest,
  stalenessPass,
  writeMarkdownDigest,
} from "@/lib/brain";
import { signEpisodeUrls } from "@/lib/episodes";

export const maxDuration = 300;

interface PrepareRequest {
  format: "markdown" | "audio" | "both";
  from?: string;
  to?: string;
  topics?: string[];
  tweetIds?: string[];
  targetMinutes?: number;
}

// Stage 1: select -> freshness -> outline -> compose markdown. For markdown-only
// briefs this completes the episode; for audio the client continues to /script.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const body = (await req.json()) as PrepareRequest;
  const format = ["markdown", "audio", "both"].includes(body.format) ? body.format : "both";

  try {
    const { included, excludedAsMisleading } = await selectBookmarksForDigest(userId, body);
    if (included.length === 0) {
      return NextResponse.json(
        { error: "No bookmarks match these filters. Try widening the date range or syncing first." },
        { status: 400 }
      );
    }

    const verdicts = await stalenessPass(included);
    const markdown = await writeMarkdownDigest(userId, included, verdicts, excludedAsMisleading, {
      from: body.from,
      to: body.to,
    });

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const markdownPath = `${userId}/${stamp}/brief.md`;
    const { error: mdErr } = await db()
      .storage.from("episodes")
      .upload(markdownPath, Buffer.from(markdown, "utf8"), { contentType: "text/markdown" });
    if (mdErr) throw new Error(`Markdown upload failed: ${mdErr.message}`);

    const dropped = included.filter((b) => verdicts.get(b.tweet_id) === "stale").length;
    const markdownOnly = format === "markdown";
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
        status: markdownOnly ? "ready" : "draft",
        date_from: body.from ?? null,
        date_to: body.to ?? null,
        topics: body.topics ?? [],
        markdown_path: markdownPath,
        bookmark_count: included.length - dropped,
      })
      .select()
      .single();
    if (epErr) throw new Error(`Episode save failed: ${epErr.message}`);

    return NextResponse.json({
      episode: await signEpisodeUrls(episode),
      markdown,
      done: markdownOnly,
      stats: {
        considered: included.length,
        droppedAsStale: dropped,
        excludedAsMisleading: excludedAsMisleading.length,
      },
    });
  } catch (err) {
    console.error("Digest prepare error:", err);
    const message = err instanceof Error ? err.message : "Digest generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
